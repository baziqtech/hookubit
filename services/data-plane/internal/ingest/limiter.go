package ingest

import (
	"context"
	"time"
)

// Scope is the set of identities a rate limit can be applied to
// (ARCHITECTURE.md 25): organisation, project and API key. The pre-auth
// per-address ceiling is NOT here on purpose - it is charged before any of
// these are known. See SourceLimiter.
type Scope struct {
	OrganizationID string
	ProjectID      string
	APIKeyID       string
}

// LimitDecision is a limiter's answer.
//
// RetryAfter is part of the client contract, not a diagnostic: it becomes the
// `Retry-After` header and `details.retry_after_seconds`, which is the field
// the dashboard reads. A 429 without it tells a client to guess, and clients
// guess badly - usually immediately.
//
// LimitedScope names the ceiling that refused ("ingest", "project",
// "organization", "source_ip"). It is logged, never returned to the caller:
// which of an organisation's ceilings bit is operator information.
type LimitDecision struct {
	Allowed      bool
	RetryAfter   time.Duration
	LimitedScope string
}

// AllowedDecision is the answer when nothing objected.
var AllowedDecision = LimitDecision{Allowed: true}

// RateLimiter is the seam for ingestion rate limiting. The production
// implementation is internal/ratelimit's Redis token bucket, resolved from the
// control plane's rate_limit_policies table; it lives behind this interface so
// ingest can ship, and be tested, without Redis.
//
// A limiter that cannot reach its backing store must fail OPEN - refusing
// traffic because Redis blipped turns a cache outage into a customer outage,
// and Redis is explicitly not the source of truth (ARCHITECTURE.md 14).
type RateLimiter interface {
	// Allow reports whether one event may be accepted for this scope. The
	// second return is a limiter fault, not a rejection.
	Allow(ctx context.Context, scope Scope) (LimitDecision, error)
}

// AllowAll is the no-ceiling limiter, used in tests and when no policy source
// is configured.
type AllowAll struct{}

func (AllowAll) Allow(context.Context, Scope) (LimitDecision, error) { return AllowedDecision, nil }
