package router

import (
	"testing"

	"github.com/shaq/hookubit/services/data-plane/internal/retry"
)

const (
	testOrg     = "org_test"
	testProject = "proj_test"
)

func testEvent() Event {
	return Event{
		ID:             "evt_1",
		OrganizationID: testOrg,
		ProjectID:      testProject,
		EventType:      "payment.settled",
	}
}

// healthy returns a candidate that passes every gate, so each test can spoil
// exactly one field and assert on the reason.
func healthy(subID, endpointID string, types ...string) Candidate {
	if len(types) == 0 {
		types = []string{"*"}
	}
	return Candidate{
		SubscriptionID:         subID,
		EndpointID:             endpointID,
		EventTypes:             types,
		Enabled:                true,
		EndpointProjectID:      testProject,
		EndpointOrganizationID: testOrg,
		EndpointStatus:         "active",
		EndpointEnabled:        true,
		ProjectStatus:          "active",
		OrganizationStatus:     "active",
	}
}

func endpointIDs(targets []Target) []string {
	out := make([]string, len(targets))
	for i, t := range targets {
		out[i] = t.EndpointID
	}
	return out
}

func TestBuildPlanFansOutToEveryMatchingSubscription(t *testing.T) {
	plan := BuildPlan(testEvent(), []Candidate{
		healthy("sub_a", "ep_a", "payment.settled"),
		healthy("sub_b", "ep_b", "payment.*"),
		healthy("sub_c", "ep_c", "*"),
	}, 0)

	if got := len(plan.Targets); got != 3 {
		t.Fatalf("targets = %d, want 3 (%v)", got, endpointIDs(plan.Targets))
	}
	if plan.Truncated != 0 {
		t.Fatalf("Truncated = %d, want 0", plan.Truncated)
	}
	if len(plan.Skipped) != 0 {
		t.Fatalf("Skipped = %v, want empty", plan.Skipped)
	}
}

func TestBuildPlanDoesNotWidenFilters(t *testing.T) {
	// The Convoy failure this platform exists to avoid: a subscription filtered
	// to one event type must not receive everything else.
	plan := BuildPlan(testEvent(), []Candidate{
		healthy("sub_a", "ep_a", "order.created"),
		healthy("sub_b", "ep_b", "payments.settled"), // near-miss prefix
		healthy("sub_c", "ep_c", "payment.settled.v2"),
	}, 0)

	if len(plan.Targets) != 0 {
		t.Fatalf("targets = %v, want none", endpointIDs(plan.Targets))
	}
	if plan.Skipped[SkipEventTypeUnmatched] != 3 {
		t.Fatalf("event_type_unmatched = %d, want 3 (%v)", plan.Skipped[SkipEventTypeUnmatched], plan.Skipped)
	}
}

func TestBuildPlanGatesAndReportsEveryReason(t *testing.T) {
	cases := []struct {
		name   string
		spoil  func(*Candidate)
		reason string
	}{
		{"disabled subscription", func(c *Candidate) { c.Enabled = false }, SkipSubscriptionDisabled},
		{"paused endpoint", func(c *Candidate) { c.EndpointStatus = "paused" }, SkipEndpointNotActive},
		{"soft-deleted endpoint", func(c *Candidate) { c.EndpointStatus = "deleted" }, SkipEndpointNotActive},
		{"auto-disabled endpoint", func(c *Candidate) { c.EndpointEnabled = false }, SkipEndpointDisabled},
		{"soft-deleted project", func(c *Candidate) { c.ProjectStatus = "deleted" }, SkipProjectNotActive},
		{"suspended project", func(c *Candidate) { c.ProjectStatus = "suspended" }, SkipProjectNotActive},
		{"soft-deleted organization", func(c *Candidate) { c.OrganizationStatus = "deleted" }, SkipOrganizationNotActive},
		{"suspended organization", func(c *Candidate) { c.OrganizationStatus = "suspended" }, SkipOrganizationNotActive},
		{"endpoint in another project", func(c *Candidate) { c.EndpointProjectID = "proj_other" }, SkipTenantMismatch},
		{"endpoint in another org", func(c *Candidate) { c.EndpointOrganizationID = "org_other" }, SkipTenantMismatch},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := healthy("sub_a", "ep_a")
			tc.spoil(&c)

			plan := BuildPlan(testEvent(), []Candidate{c}, 0)
			if len(plan.Targets) != 0 {
				t.Fatalf("targets = %v, want none", endpointIDs(plan.Targets))
			}
			if plan.Skipped[tc.reason] != 1 {
				t.Fatalf("skipped[%s] = %d, want 1 (all: %v)", tc.reason, plan.Skipped[tc.reason], plan.Skipped)
			}
		})
	}
}

func TestBuildPlanReportsTenantMismatchEvenWhenAlsoDisabled(t *testing.T) {
	// A cross-tenant subscription is a security finding, not a configuration
	// state, so it must be reported as such however else it is broken.
	c := healthy("sub_a", "ep_a")
	c.EndpointProjectID = "proj_other"
	c.Enabled = false

	plan := BuildPlan(testEvent(), []Candidate{c}, 0)
	if plan.Skipped[SkipTenantMismatch] != 1 {
		t.Fatalf("skipped = %v, want tenant_mismatch", plan.Skipped)
	}
}

func TestBuildPlanEmitsOneDeliveryPerEndpoint(t *testing.T) {
	// The uniqueness arbiter is (event_id, endpoint_id), NOT subscription id.
	// Two subscriptions on one endpoint therefore describe one delivery, and
	// the plan must say so rather than leaving ON CONFLICT to swallow the
	// second row.
	plan := BuildPlan(testEvent(), []Candidate{
		healthy("sub_a", "ep_shared", "payment.settled"),
		healthy("sub_b", "ep_shared", "payment.*"),
		healthy("sub_c", "ep_other", "*"),
	}, 0)

	if got := endpointIDs(plan.Targets); len(got) != 2 {
		t.Fatalf("targets = %v, want one per endpoint", got)
	}
	if plan.Targets[0].SubscriptionID != "sub_a" {
		t.Fatalf("winner = %q, want the lowest subscription id", plan.Targets[0].SubscriptionID)
	}
	if plan.Skipped[SkipDuplicateEndpoint] != 1 {
		t.Fatalf("duplicate_endpoint = %d, want 1", plan.Skipped[SkipDuplicateEndpoint])
	}
}

func TestBuildPlanEnforcesFanOutCap(t *testing.T) {
	var candidates []Candidate
	for _, id := range []string{"sub_1", "sub_2", "sub_3", "sub_4", "sub_5"} {
		candidates = append(candidates, healthy(id, "ep_"+id))
	}

	plan := BuildPlan(testEvent(), candidates, 3)
	if len(plan.Targets) != 3 {
		t.Fatalf("targets = %d, want 3", len(plan.Targets))
	}
	if plan.Truncated != 2 {
		t.Fatalf("Truncated = %d, want 2", plan.Truncated)
	}
	if plan.Skipped[SkipFanOutCapExceeded] != 2 {
		t.Fatalf("fan_out_cap_exceeded = %d, want 2", plan.Skipped[SkipFanOutCapExceeded])
	}
	// Deterministic truncation: subscription ids are ULIDs, so the oldest
	// subscriptions are the ones that keep working.
	if plan.Targets[0].SubscriptionID != "sub_1" || plan.Targets[2].SubscriptionID != "sub_3" {
		t.Fatalf("truncation was not in subscription-id order: %+v", plan.Targets)
	}
}

func TestBuildPlanCapZeroMeansUnbounded(t *testing.T) {
	var candidates []Candidate
	for i := 0; i < 50; i++ {
		id := string(rune('a'+i%26)) + string(rune('a'+i/26))
		candidates = append(candidates, healthy("sub_"+id, "ep_"+id))
	}
	plan := BuildPlan(testEvent(), candidates, 0)
	if len(plan.Targets) != 50 {
		t.Fatalf("targets = %d, want 50", len(plan.Targets))
	}
}

func TestBuildPlanNoCandidatesIsNotAnError(t *testing.T) {
	plan := BuildPlan(testEvent(), nil, 0)
	if len(plan.Targets) != 0 || plan.Truncated != 0 || len(plan.Skipped) != 0 {
		t.Fatalf("plan = %+v, want an empty plan", plan)
	}
}

func TestResolveMaxAttempts(t *testing.T) {
	builtin := retry.DefaultPolicy().MaxAttempts

	cases := []struct {
		name             string
		endpoint, projct int
		want             int
	}{
		{"endpoint policy wins", 3, 12, 3},
		{"project default when the endpoint has none", 0, 12, 12},
		{"built-in default when neither exists", 0, 0, builtin},
		{"a negative endpoint policy is not trusted", -1, 12, 12},
		{"a negative project default is not trusted", 0, -1, builtin},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ResolveMaxAttempts(tc.endpoint, tc.projct); got != tc.want {
				t.Fatalf("ResolveMaxAttempts(%d, %d) = %d, want %d", tc.endpoint, tc.projct, got, tc.want)
			}
		})
	}
}

func TestBuildPlanStampsResolvedMaxAttempts(t *testing.T) {
	endpointPolicy := healthy("sub_a", "ep_a")
	endpointPolicy.EndpointMaxAttempts = 3
	endpointPolicy.ProjectDefaultMaxAttempts = 12

	projectPolicy := healthy("sub_b", "ep_b")
	projectPolicy.ProjectDefaultMaxAttempts = 12

	noPolicy := healthy("sub_c", "ep_c")

	plan := BuildPlan(testEvent(), []Candidate{endpointPolicy, projectPolicy, noPolicy}, 0)
	want := []int{3, 12, retry.DefaultPolicy().MaxAttempts}
	for i, t2 := range plan.Targets {
		if t2.MaxAttempts != want[i] {
			t.Fatalf("target %d (%s) max_attempts = %d, want %d", i, t2.EndpointID, t2.MaxAttempts, want[i])
		}
	}
}
