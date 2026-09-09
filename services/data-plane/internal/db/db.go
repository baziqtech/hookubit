// Package db owns the PostgreSQL connection pool for the data plane.
//
// The data plane never runs migrations. Prisma, in the control plane, owns all
// DDL (ADR-0002); these services read and write an already-migrated schema.
package db

import (
	"context"
	"fmt"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Open builds a bounded connection pool. The bound matters: an unbounded pool
// turns a slow query into a database-wide outage (engineering rule 11).
//
// statementTimeout is the server-side backstop for the same failure: pgxpool
// has no default statement timeout, so a lock wait or a failed-over replica
// would otherwise hold a pooled connection for as long as PostgreSQL is willing
// to wait. Callers still pass a context deadline; this catches the paths that
// forget to. Zero disables it.

// prismaOnlyParams are query parameters Prisma understands and libpq does not.
// Both planes are specified to read the SAME DATABASE_URL (ARCHITECTURE.md 36),
// and Prisma's documented connection string carries `schema`, so a URL that is
// correct for the control plane reaches pgx carrying a parameter PostgreSQL
// rejects outright:
//
//	FATAL: unrecognized configuration parameter "schema" (SQLSTATE 42704)
//
// Stripping them here means one URL works for both, which is what an operator
// is told to expect. `schema` is translated rather than dropped, because it
// carries real intent: it becomes search_path, which PostgreSQL does understand.
var prismaOnlyParams = map[string]string{
	"schema":           "search_path",
	"connection_limit": "",
	"pool_timeout":     "",
	"pgbouncer":        "",
	"socket_timeout":   "",
	"sslidentity":      "",
	"sslpassword":      "",
}

// NormaliseDSN rewrites a Prisma-flavoured connection string into one pgx can
// use. It is deliberately conservative: anything it does not recognise is left
// exactly as the operator wrote it.
func NormaliseDSN(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		// Not a URL - probably key=value DSN form, which pgx also accepts.
		return raw, nil
	}
	q := u.Query()
	changed := false
	for key, replacement := range prismaOnlyParams {
		v := q.Get(key)
		if v == "" && !q.Has(key) {
			continue
		}
		q.Del(key)
		changed = true
		if replacement != "" && v != "" {
			q.Set(replacement, v)
		}
	}
	if !changed {
		return raw, nil
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func Open(ctx context.Context, url string, maxConns int32, statementTimeout time.Duration) (*pgxpool.Pool, error) {
	cfg, err := buildConfig(url, maxConns, statementTimeout)
	if err != nil {
		return nil, err
	}
	return connect(ctx, cfg)
}

// OpenWithRetry is Open with a bounded, cancellable wait for a database that is
// not reachable yet.
//
// Why this exists: run() opens the pool during boot and exits non-zero when it
// cannot, so a PostgreSQL outage turned every starting pod into
// CrashLoopBackOff - and recovery was then gated on kubelet's exponential
// backoff, up to five minutes, rather than on the database. That is precisely
// the fleet-wide restart the liveness probe avoids by never touching PostgreSQL
// (ARCHITECTURE.md 46), reintroduced at a different point in the lifecycle. A
// startupProbe cannot rescue it either: a process that has already exited has
// no port left to probe.
//
// A malformed DATABASE_URL is NOT retried. From the outside, waiting out a
// configuration error looks identical to waiting out an outage, and those need
// telling apart: one clears on its own, the other never will.
//
// The wait ends when ctx does, so a SIGTERM arriving mid-wait still exits
// promptly.
func OpenWithRetry(
	ctx context.Context,
	url string,
	maxConns int32,
	statementTimeout time.Duration,
	onRetry func(attempt int, err error, retryIn time.Duration),
) (*pgxpool.Pool, error) {
	// Validate once, before the loop, so a bad DSN fails on the first pass
	// instead of being retried until the startup budget runs out.
	if _, err := buildConfig(url, maxConns, statementTimeout); err != nil {
		return nil, err
	}

	const (
		initialBackoff = 250 * time.Millisecond
		maxBackoff     = 10 * time.Second
	)

	backoff := initialBackoff
	for attempt := 1; ; attempt++ {
		// Rebuilt per attempt rather than shared: pgxpool.NewWithConfig takes
		// ownership of the config it is handed, and a pool we just closed must
		// not leave the next attempt reusing its internals.
		cfg, err := buildConfig(url, maxConns, statementTimeout)
		if err != nil {
			return nil, err
		}

		pool, err := connect(ctx, cfg)
		if err == nil {
			return pool, nil
		}
		if ctx.Err() != nil {
			return nil, waitCancelled(ctx, err)
		}
		if onRetry != nil {
			onRetry(attempt, err, backoff)
		}

		timer := time.NewTimer(backoff)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, waitCancelled(ctx, err)
		}

		if backoff < maxBackoff {
			if backoff *= 2; backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

// waitCancelled reports the shutdown AND the connection error that was standing
// when it arrived. A bare "context canceled" would name the shutdown and hide
// the reason the process was still waiting to start.
func waitCancelled(ctx context.Context, last error) error {
	return fmt.Errorf("waiting for PostgreSQL: %w (last connection error: %v)", ctx.Err(), last)
}

func buildConfig(rawURL string, maxConns int32, statementTimeout time.Duration) (*pgxpool.Config, error) {
	dsn, err := NormaliseDSN(rawURL)
	if err != nil {
		return nil, fmt.Errorf("normalise DATABASE_URL: %w", err)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = maxConns
	cfg.MinConns = 0
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	// PgBouncer in transaction mode cannot support server-side prepared
	// statement caching; describing on first use keeps us compatible with both
	// a direct connection and a pooler.
	cfg.ConnConfig.DefaultQueryExecMode = queryExecModeCacheStatement

	if statementTimeout > 0 {
		ms := statementTimeout.Milliseconds()
		if ms < 1 {
			ms = 1
		}
		// AfterConnect rather than a connection string parameter so it applies
		// however DATABASE_URL was written. The value is an integer we produced,
		// so the formatting is not an injection surface.
		cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
			if _, err := conn.Exec(ctx, fmt.Sprintf("SET statement_timeout = %d", ms)); err != nil {
				return fmt.Errorf("set statement_timeout: %w", err)
			}
			return nil
		}
	}
	return cfg, nil
}

func connect(ctx context.Context, cfg *pgxpool.Config) (*pgxpool.Pool, error) {
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create connection pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}
