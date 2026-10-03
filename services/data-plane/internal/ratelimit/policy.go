package ratelimit

import (
	"fmt"
	"time"
)

// Scope mirrors the PostgreSQL enum "RateLimitScope".
type Scope string

const (
	ScopeOrganization Scope = "organization"
	ScopeProject      Scope = "project"
	ScopeEndpoint     Scope = "endpoint"
	ScopeIngest       Scope = "ingest"

	// ScopeSourceIP is NOT a database scope. It names the pre-auth bucket in
	// metrics and in the refusal, so an operator can tell "you exceeded your
	// project's ceiling" from "this address is being throttled before we even
	// looked you up".
	ScopeSourceIP Scope = "source_ip"
)

// Row is one `rate_limit_policies` row, as the data plane needs it.
//
// ResourceID is nil for the "every resource in this scope" row - the row the
// NULLS NOT DISTINCT unique index exists to keep unique. Burst is nil for
// "capacity equals limit".
type Row struct {
	Scope         Scope
	ResourceID    *string
	Limit         int
	WindowSeconds int
	Burst         *int
}

// Target is the set of identities one request or delivery is charged against.
// EndpointID is empty on the ingest path; APIKeyID is empty on the delivery
// path.
type Target struct {
	OrganizationID string
	ProjectID      string
	APIKeyID       string
	EndpointID     string
}

// Bucket is a resolved policy: a key to charge and the shape of the bucket.
type Bucket struct {
	Scope      Scope
	Key        string
	Capacity   float64
	RatePerSec float64
	// Limit and Window are kept for logging and for the equality that lets a
	// test assert WHICH policy was resolved rather than re-deriving the
	// arithmetic.
	Limit  int
	Window time.Duration
}

// Default is a configured ceiling applied when the database has nothing to say.
// Limit <= 0 disables it.
type Default struct {
	Limit         int
	WindowSeconds int
	Burst         int
}

func (d Default) row(scope Scope) (Row, bool) {
	if d.Limit <= 0 || d.WindowSeconds <= 0 {
		return Row{}, false
	}
	r := Row{Scope: scope, Limit: d.Limit, WindowSeconds: d.WindowSeconds}
	if d.Burst > 0 {
		burst := d.Burst
		r.Burst = &burst
	}
	return r, true
}

// bucketOf converts a row into a chargeable bucket keyed by `resource`.
func bucketOf(r Row, resource string) Bucket {
	window := time.Duration(r.WindowSeconds) * time.Second
	capacity := float64(r.Limit)
	if r.Burst != nil && *r.Burst > r.Limit {
		capacity = float64(*r.Burst)
	}
	return Bucket{
		Scope:      r.Scope,
		Key:        fmt.Sprintf("rl:%s:%s:%ds", r.Scope, resource, r.WindowSeconds),
		Capacity:   capacity,
		RatePerSec: float64(r.Limit) / window.Seconds(),
		Limit:      r.Limit,
		Window:     window,
	}
}

// pick implements the WITHIN-scope rule: the row whose resource_id names this
// resource beats the resource_id IS NULL row for the same scope. Never both.
func pick(rows []Row, scope Scope, resource string) (Row, bool) {
	var wildcard Row
	var haveWildcard bool
	for _, r := range rows {
		if r.Scope != scope {
			continue
		}
		if r.ResourceID != nil {
			if resource != "" && *r.ResourceID == resource {
				return r, true
			}
			continue
		}
		if !haveWildcard {
			wildcard, haveWildcard = r, true
		}
	}
	return wildcard, haveWildcard
}

// ResolveIngest returns every bucket an accepted event is charged against, in
// the order recorded by the control-plane team in apps/control-api/HANDOFF.md:
//
//  1. scope='ingest'       resource_id = <api key id>, else NULL
//  2. scope='project'      resource_id = <project id>, else NULL
//  3. scope='organization' resource_id = <org id>,     else NULL
//
// Two rules, and conflating them is the trap the handoff warns about:
//
//   - WITHIN one scope the most specific row wins (see pick).
//   - ACROSS scopes these are NESTED BUDGETS, not fallbacks. Every applicable
//     bucket is charged and any one of them may refuse. An API-key ceiling of
//     100/s inside a project ceiling of 500/s means both, and the tightest
//     bites first. A "most specific wins" reading would let a per-key policy
//     SILENTLY RAISE a request above its project's ceiling, which is the
//     opposite of what an operator setting a project ceiling asked for.
//
// `def` is the configured platform ceiling. It applies at the ingest scope only
// when the database has no ingest-scope row at all, so an operator who
// configures a policy is never also charged the built-in default.
func ResolveIngest(rows []Row, t Target, def Default) []Bucket {
	var buckets []Bucket

	if r, ok := pick(rows, ScopeIngest, t.APIKeyID); ok {
		buckets = append(buckets, bucketOf(r, ingestResource(r, t)))
	} else if r, ok := def.row(ScopeIngest); ok && t.APIKeyID != "" {
		buckets = append(buckets, bucketOf(r, t.APIKeyID))
	}
	if r, ok := pick(rows, ScopeProject, t.ProjectID); ok && t.ProjectID != "" {
		buckets = append(buckets, bucketOf(r, t.ProjectID))
	}
	if r, ok := pick(rows, ScopeOrganization, t.OrganizationID); ok && t.OrganizationID != "" {
		buckets = append(buckets, bucketOf(r, t.OrganizationID))
	}
	return buckets
}

// ResolveDelivery is the same rule for the outbound path (handoff order:
// endpoint, then project, then organization). The endpoint's own
// endpoints.rate_limit columns sit ABOVE step 1 there and are not modelled
// here - internal/worker already reads them off the delivery row.
//
// Nothing wires this yet; the worker's own limiter seam is unchanged. It exists
// because the resolution rule is one rule, and having two copies of it is how
// the two paths drift.
func ResolveDelivery(rows []Row, t Target) []Bucket {
	var buckets []Bucket
	if r, ok := pick(rows, ScopeEndpoint, t.EndpointID); ok && t.EndpointID != "" {
		buckets = append(buckets, bucketOf(r, t.EndpointID))
	}
	if r, ok := pick(rows, ScopeProject, t.ProjectID); ok && t.ProjectID != "" {
		buckets = append(buckets, bucketOf(r, t.ProjectID))
	}
	if r, ok := pick(rows, ScopeOrganization, t.OrganizationID); ok && t.OrganizationID != "" {
		buckets = append(buckets, bucketOf(r, t.OrganizationID))
	}
	return buckets
}

// BucketFor builds a chargeable bucket from a limit and a window that did not
// come from a rate_limit_policies row.
//
// The delivery path needs it because endpoints.rate_limit is a COLUMN on the
// endpoint, not a policy row: the control plane lets a customer set a per
// endpoint ceiling directly, and internal/worker already has it loaded by the
// time it needs to charge it.
//
// `key` is expected to be namespaced by the caller (the worker uses
// "endpoint:<id>"), and the result is keyed under `rl:delivery:` so these
// buckets can never collide with an endpoint-scope policy row charged through
// ResolveDelivery. Two ceilings that an operator configured separately must be
// charged separately, or the tighter one silently absorbs the other.
func BucketFor(scope Scope, key string, limit int, window time.Duration) Bucket {
	if window <= 0 {
		window = time.Second
	}
	// The key carries whole seconds, so a bucket whose window is edited from 1s
	// to 60s gets a new key rather than inheriting the old one's tokens.
	windowSeconds := int(window.Round(time.Second) / time.Second)
	if windowSeconds < 1 {
		windowSeconds = 1
	}
	if limit < 0 {
		limit = 0
	}
	return Bucket{
		Scope:      scope,
		Key:        fmt.Sprintf("rl:delivery:%s:%ds", key, windowSeconds),
		Capacity:   float64(limit),
		RatePerSec: float64(limit) / window.Seconds(),
		Limit:      limit,
		Window:     window,
	}
}

// ingestResource keys a wildcard ingest row by the PROJECT, not by the key.
//
// `scope='ingest' AND resource_id IS NULL` means "every credential in this
// scope". Keying it per API key would hand each key its own copy of the shared
// budget, which is the one thing the wildcard row is not. A row naming a
// specific key is keyed by that key.
func ingestResource(r Row, t Target) string {
	if r.ResourceID != nil {
		return *r.ResourceID
	}
	return t.ProjectID
}
