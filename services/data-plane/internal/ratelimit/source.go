package ratelimit

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"
)

// PolicySource supplies the rate_limit_policies rows that could apply to one
// (organisation, project) pair.
type PolicySource interface {
	Policies(ctx context.Context, organizationID, projectID string) ([]Row, error)
}

// maxPolicyRows bounds one lookup. The control plane caps a project at 300 rate
// limits, so this is slack, not a limit anyone reaches - it is here so a
// pathological organisation cannot turn a hot-path query into an unbounded
// result set.
const maxPolicyRows = 1000

// policiesSQL reads every row that could apply to this request.
//
// The `project_id` column on rate_limit_policies is NOT NULL, so an
// ORGANISATION-scoped policy is still filed under whichever project the API
// call named. Restricting the query to this project would therefore MISS an
// org-wide ceiling created under a sibling project, and an operator who set an
// organisation limit would watch it apply to one project. Hence the join: rows
// for this project, plus organisation-scoped rows anywhere in this
// organisation.
const policiesSQL = `
SELECT rl.scope::text, rl.resource_id, rl."limit", rl.window_seconds, rl.burst
FROM rate_limit_policies rl
JOIN projects p ON p.id = rl.project_id
WHERE p.organization_id = $1
  AND (rl.project_id = $2 OR rl.scope = 'organization')
LIMIT $3
`

// PostgresSource reads policies from the control plane's own table. The data
// plane never writes it.
type PostgresSource struct{ pool *pgxpool.Pool }

func NewPostgresSource(pool *pgxpool.Pool) *PostgresSource { return &PostgresSource{pool: pool} }

func (s *PostgresSource) Policies(ctx context.Context, organizationID, projectID string) ([]Row, error) {
	rows, err := s.pool.Query(ctx, policiesSQL, organizationID, projectID, maxPolicyRows)
	if err != nil {
		return nil, fmt.Errorf("load rate limit policies: %w", err)
	}
	defer rows.Close()

	var out []Row
	for rows.Next() {
		var r Row
		var scope string
		if err := rows.Scan(&scope, &r.ResourceID, &r.Limit, &r.WindowSeconds, &r.Burst); err != nil {
			return nil, fmt.Errorf("scan rate limit policy: %w", err)
		}
		r.Scope = Scope(scope)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read rate limit policies: %w", err)
	}
	return out, nil
}

// DefaultCacheTTL is how long a resolved policy set is reused.
//
// This is the whole staleness contract, and it is deliberately short and
// FINITE (ARCHITECTURE.md 55 forbids an invalidation that is not time-bounded):
// after an operator adds, edits or deletes a policy in the dashboard, every
// data-plane replica picks it up within this window and no operator action is
// required. Nothing pushes invalidation, so there is no cache to get wedged.
const DefaultCacheTTL = 30 * time.Second

// maxCachedProjects bounds the cache the same way Local is bounded.
const maxCachedProjects = 20_000

// CachingSource memoises PolicySource for a bounded TTL.
//
// Without it the limiter re-creates exactly the database pressure it exists to
// prevent: one extra query per accepted event, on the same 20-connection pool
// the flood was exhausting. Empty results are cached too - most projects have
// no policies at all, and a cache that only remembers hits does nothing for the
// common case.
type CachingSource struct {
	inner PolicySource
	ttl   time.Duration
	now   func() time.Time

	// group collapses a stampede. Without it, the first request after an
	// expiry is joined by every concurrent request on the same project, and a
	// popular project turns one refresh into hundreds of queries.
	group singleflight.Group

	mu      sync.RWMutex
	entries map[string]cacheEntry
}

type cacheEntry struct {
	rows      []Row
	expiresAt time.Time
}

func NewCachingSource(inner PolicySource, ttl time.Duration, now func() time.Time) *CachingSource {
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	if now == nil {
		now = time.Now
	}
	return &CachingSource{inner: inner, ttl: ttl, now: now, entries: map[string]cacheEntry{}}
}

func (c *CachingSource) Policies(ctx context.Context, organizationID, projectID string) ([]Row, error) {
	key := organizationID + "\x00" + projectID

	c.mu.RLock()
	entry, ok := c.entries[key]
	c.mu.RUnlock()
	if ok && c.now().Before(entry.expiresAt) {
		return entry.rows, nil
	}

	// The singleflight result is SHARED between callers, so the slice must be
	// treated as immutable from here on. Nothing downstream mutates a Row.
	rows, err, _ := c.group.Do(key, func() (any, error) {
		fresh, err := c.inner.Policies(ctx, organizationID, projectID)
		if err != nil {
			return nil, err
		}
		c.store(key, fresh)
		return fresh, nil
	})
	if err != nil {
		// A stale entry is better than no ceiling: on a database blip the
		// limiter keeps enforcing what it last knew rather than falling back to
		// the configured default and silently widening every customer's limit.
		if ok {
			return entry.rows, nil
		}
		return nil, err
	}
	typed, _ := rows.([]Row)
	return typed, nil
}

func (c *CachingSource) store(key string, rows []Row) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= maxCachedProjects {
		// Cheap, coarse reclamation: drop what has already expired, and if that
		// is not enough drop entries in map order. Both cost a re-read, never
		// a wrong answer.
		now := c.now()
		for k, e := range c.entries {
			if now.After(e.expiresAt) {
				delete(c.entries, k)
			}
		}
		for k := range c.entries {
			if len(c.entries) < maxCachedProjects {
				break
			}
			delete(c.entries, k)
		}
	}
	c.entries[key] = cacheEntry{rows: rows, expiresAt: c.now().Add(c.ttl)}
}

// ErrNoSource is returned by a limiter built without a policy source. It is a
// programming error, never a runtime condition.
var ErrNoSource = errors.New("ratelimit: no policy source configured")
