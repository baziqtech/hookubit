package ingest

import "context"

// Scope is the set of identities a rate limit can be applied to
// (ARCHITECTURE.md 25): organisation, project and API key, plus a global
// ceiling the implementation applies on its own.
type Scope struct {
	OrganizationID string
	ProjectID      string
	APIKeyID       string
}

// RateLimiter is the seam for ingestion rate limiting. The real implementation
// is a Redis token bucket; it lives behind this interface so ingest can ship,
// and be tested, without one. A limiter that cannot reach its backing store
// must fail OPEN - refusing traffic because Redis blipped turns a cache outage
// into a customer outage, and Redis is explicitly not the source of truth
// (ARCHITECTURE.md 14).
type RateLimiter interface {
	// Allow reports whether one event may be accepted for this scope. The
	// second return is a limiter fault, not a rejection.
	Allow(ctx context.Context, scope Scope) (bool, error)
}

// AllowAll is the placeholder limiter: no ceiling, no dependency.
type AllowAll struct{}

func (AllowAll) Allow(context.Context, Scope) (bool, error) { return true, nil }
