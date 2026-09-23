package router

import (
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/retry"
)

// Event is the routing-relevant projection of an events row. It carries no
// payload: the router decides WHERE an event goes, never what is sent, so the
// bytes stay in PostgreSQL until a worker signs and delivers them.
type Event struct {
	ID             string
	OrganizationID string
	ProjectID      string
	EventType      string
	// OrderingKey is stored on the delivery but NOT enforced (ADR-0004).
	OrderingKey string
	// CreatedAt is when the event was ACCEPTED, and it is what pins the
	// subscription set - see loadCandidatesSQL. A routing wider than one batch
	// spans several transactions and therefore several snapshots, so without a
	// pin the answer to "do I receive events published before I subscribed?"
	// would be "only if the project is wider than ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT",
	// which is not a rule a customer can reason about.
	CreatedAt time.Time
}

// Candidate is one webhook_subscriptions row joined to everything that decides
// whether it may receive a delivery: the endpoint, its project, its
// organisation and its retry policy.
//
// Candidates are loaded WITHOUT pre-filtering on those flags on purpose. The
// difference between "no subscription matched this event type" and "every
// subscription in this project is disabled" is the first question an operator
// asks at 2am, and a WHERE clause that hides the second one makes it
// unanswerable without psql.
type Candidate struct {
	SubscriptionID string
	EndpointID     string
	EventTypes     []string
	Enabled        bool

	// EndpointProjectID / EndpointOrganizationID are read back through the
	// endpoint -> project -> organization joins, NOT copied from the event.
	// They exist so a subscription that somehow points across a tenant boundary
	// is dropped rather than materialised as a delivery carrying the event's
	// tenant columns - which is how a cross-tenant leak would look.
	EndpointProjectID      string
	EndpointOrganizationID string

	EndpointStatus     string
	EndpointEnabled    bool
	ProjectStatus      string
	OrganizationStatus string

	// EndpointMaxAttempts is the endpoint's own retry policy; zero means the
	// endpoint has none attached. ProjectDefaultMaxAttempts is the project's
	// default policy; zero means the project has none.
	EndpointMaxAttempts       int
	ProjectDefaultMaxAttempts int
}

// Target is one delivery row that must be written. It has no ID: identifiers
// are minted by the store so that BuildPlan stays a pure, deterministic
// function of its inputs.
type Target struct {
	SubscriptionID string
	EndpointID     string
	MaxAttempts    int
}

// Skip reasons. Every candidate that does not become a delivery is counted
// under exactly one of these, so "why did finance not get this event?" is
// answered from a metric and a log line rather than from a schema diagram.
const (
	SkipTenantMismatch        = "tenant_mismatch"
	SkipSubscriptionDisabled  = "subscription_disabled"
	SkipOrganizationNotActive = "organization_not_active"
	SkipProjectNotActive      = "project_not_active"
	SkipEndpointNotActive     = "endpoint_not_active"
	SkipEndpointDisabled      = "endpoint_disabled"
	SkipEventTypeUnmatched    = "event_type_unmatched"
	SkipDuplicateEndpoint     = "duplicate_endpoint"
	SkipRoutingCapExceeded     = "routing_cap_exceeded"
)

// statusActive is the only project/endpoint/organisation status that receives
// deliveries. Soft deletion is a status change, not a row removal (see the
// review-fixes migration), so this string is the entire soft-delete check.
const statusActive = "active"

// Plan is the decision for one event: the deliveries to write, and an account
// of everything that was considered and rejected.
type Plan struct {
	Targets []Target
	// Skipped counts candidates by reason. Only non-zero reasons appear.
	Skipped map[string]int
	// Truncated is how many matching, deduplicated targets were dropped by the
	// routing cap. Any value above zero is a correctness-visible event: those
	// endpoints will not receive this event at all.
	Truncated int
}

// BuildPlan turns the loaded candidates into the delivery rows to insert.
//
// The pipeline is deliberately ordered: tenant and lifecycle gating first (a
// disabled endpoint should not even be considered), then event-type matching
// via Match, then one-delivery-per-endpoint deduplication, then the cap.
//
// Deduplication matters more than it looks. The uniqueness arbiter in the
// schema is (event_id, endpoint_id) - NOT (event_id, subscription_id) - so two
// enabled subscriptions pointing at the same endpoint describe ONE delivery. If
// this function emitted both, the second would be swallowed by ON CONFLICT DO
// NOTHING and the created count would silently disagree with the plan. Doing it
// here makes the outcome deterministic (lowest subscription id wins, and ids
// are ULIDs, so that is the oldest subscription) and testable without a
// database.
func BuildPlan(ev Event, candidates []Candidate, routingCap int) Plan {
	p := Plan{Skipped: make(map[string]int)}

	eligible := make([]Subscription, 0, len(candidates))
	byID := make(map[string]Candidate, len(candidates))
	for _, c := range candidates {
		if reason, ok := gate(ev, c); !ok {
			p.Skipped[reason]++
			continue
		}
		byID[c.SubscriptionID] = c
		eligible = append(eligible, Subscription{
			ID:         c.SubscriptionID,
			EndpointID: c.EndpointID,
			EventTypes: c.EventTypes,
			Enabled:    true, // gate() already established this
		})
	}

	// Filters are always on and never widened. Match is the single definition
	// of "does this subscription select this event type"; the router does not
	// carry a second one.
	matched := Match(eligible, ev.EventType)
	if n := len(eligible) - len(matched); n > 0 {
		p.Skipped[SkipEventTypeUnmatched] += n
	}

	seen := make(map[string]struct{}, len(matched))
	p.Targets = make([]Target, 0, len(matched))
	for _, s := range matched {
		if _, dup := seen[s.EndpointID]; dup {
			p.Skipped[SkipDuplicateEndpoint]++
			continue
		}
		seen[s.EndpointID] = struct{}{}

		c := byID[s.ID]
		p.Targets = append(p.Targets, Target{
			SubscriptionID: c.SubscriptionID,
			EndpointID:     c.EndpointID,
			MaxAttempts:    ResolveMaxAttempts(c.EndpointMaxAttempts, c.ProjectDefaultMaxAttempts),
		})
	}

	if routingCap > 0 && len(p.Targets) > routingCap {
		p.Truncated = len(p.Targets) - routingCap
		p.Skipped[SkipRoutingCapExceeded] += p.Truncated
		p.Targets = p.Targets[:routingCap]
	}
	return p
}

// gate reports the first reason a candidate cannot receive a delivery.
//
// Tenant mismatch is checked first because it is the one failure here that is a
// security bug rather than a configuration state, and it must be reported even
// when the subscription is also disabled.
//
// A `paused` endpoint is skipped rather than buffered. Buffering would
// materialise rows that every worker poll claims and immediately puts back,
// which is dead-tuple churn on the hottest table in the system and an operator
// UI in which queue depth means nothing. See HANDOFF.md - this is a product
// decision, not a technical constraint.
func gate(ev Event, c Candidate) (string, bool) {
	switch {
	case c.EndpointProjectID != ev.ProjectID || c.EndpointOrganizationID != ev.OrganizationID:
		return SkipTenantMismatch, false
	case !c.Enabled:
		return SkipSubscriptionDisabled, false
	case c.OrganizationStatus != statusActive:
		return SkipOrganizationNotActive, false
	case c.ProjectStatus != statusActive:
		return SkipProjectNotActive, false
	case c.EndpointStatus != statusActive:
		// `paused`, `disabled` and `deleted` all land here.
		return SkipEndpointNotActive, false
	case !c.EndpointEnabled:
		// The circuit breaker's auto-disable writes this flag, so an endpoint
		// that has been shut off for repeated failures stops accruing new
		// deliveries instead of building a backlog it will never drain.
		return SkipEndpointDisabled, false
	}
	return "", true
}

// ResolveMaxAttempts picks the attempt budget stamped onto a delivery row:
// the endpoint's own retry policy, else the project's default policy, else the
// built-in default.
//
// It is resolved HERE, at routing time, and denormalised onto the row rather
// than joined at delivery time. That is deliberate: an endpoint's policy can be
// edited while a delivery is mid-retry, and a budget that changes underneath an
// in-flight retry chain makes "why did this stop after 3 attempts" unanswerable
// from the ledger. The row records the contract it was created under.
func ResolveMaxAttempts(endpointPolicy, projectDefault int) int {
	if endpointPolicy > 0 {
		return endpointPolicy
	}
	if projectDefault > 0 {
		return projectDefault
	}
	return retry.DefaultPolicy().MaxAttempts
}
