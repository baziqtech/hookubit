// Package db owns the PostgreSQL connection pool for the data plane.
//
// The data plane never runs migrations. Prisma, in the control plane, owns all
// DDL (ADR-0002); these services read and write an already-migrated schema.
package db

import (
	"context"
	"fmt"
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
func Open(ctx context.Context, url string, maxConns int32, statementTimeout time.Duration) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
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
