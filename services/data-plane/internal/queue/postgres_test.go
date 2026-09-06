package queue

import (
	"math/rand"
	"strings"
	"testing"
)

// Regression for the reclaim hole. The claim predicate used to list only
// ('pending','scheduled','queued','retrying'), but a leased row is
// 'processing'. An expired lease was therefore invisible to Claim, and the only
// route back was the scheduler's ReclaimExpired - whose own doc comment called
// itself cosmetic. Lose the scheduler, OOM-kill a worker holding leases, and
// those deliveries are stuck in 'processing' forever: never retried, never
// exhausted. This asserts on the SQL text because the property is a property of
// the statement, and it holds with or without a database to run it against.
func TestClaimStatementsIncludeLeasedRows(t *testing.T) {
	statements := map[string]string{
		"fifo claim":      claimFIFOSQL,
		"tenant fair":     claimTenantFairSQL,
		"tenant snapshot": tenantSnapshotSQL,
	}
	for name, sql := range statements {
		if !strings.Contains(sql, "'processing'") {
			t.Errorf("%s does not consider 'processing' rows; an expired lease would never be reclaimable", name)
		}
		for _, status := range []string{"'pending'", "'scheduled'", "'queued'", "'retrying'"} {
			if !strings.Contains(sql, status) {
				t.Errorf("%s dropped status %s from the ready set", name, status)
			}
		}
		// Including 'processing' is only safe while the lease guard decides
		// claimability. Without this predicate the claim steals live leases.
		if !strings.Contains(sql, "locked_until") {
			t.Errorf("%s includes leased rows but has no locked_until guard: it would steal live leases", name)
		}
		if !strings.Contains(sql, "now()") {
			t.Errorf("%s has no now() comparison; readiness would not be time-bounded", name)
		}
	}

	// Both claim paths must actually lock, and must skip contended rows rather
	// than queue behind them.
	for name, sql := range map[string]string{"fifo claim": claimFIFOSQL, "tenant fair": claimTenantFairSQL} {
		if !strings.Contains(sql, "FOR UPDATE SKIP LOCKED") {
			t.Errorf("%s lost FOR UPDATE SKIP LOCKED; two workers could take one delivery", name)
		}
	}
}

// Renew must return the ids it extended, not just a count: a count cannot say
// WHICH lease was lost, and the worker needs the id to cancel that attempt.
func TestRenewStatementReturnsIDs(t *testing.T) {
	if !strings.Contains(renewSQL, "RETURNING id") {
		t.Fatal("renewSQL does not return the renewed ids; lost leases would be undetectable")
	}
	if !strings.Contains(renewSQL, "locked_by = $1") {
		t.Fatal("renewSQL does not scope to the calling worker; it would renew another worker's lease")
	}
}

// The derived cap is the rule that makes ADR-0007 degrade correctly. A constant
// cap would throttle a lone tenant to `cap` rows per poll and leave the pool
// idle in front of its own backlog.
func TestPerTenantCapIsDerivedNotConstant(t *testing.T) {
	cases := []struct {
		limit, tenants, want int
	}{
		{100, 1, 100}, // one tenant: the whole batch, i.e. FIFO
		{100, 2, 50},
		{100, 3, 34}, // ceil, so the batch can actually be filled
		{100, 100, 1},
		{100, 250, 1}, // floors at 1, never 0
		{64, 8, 8},
		{1, 1, 1},
		{100, 0, 100}, // no snapshot: no throttling
	}
	for _, c := range cases {
		if got := perTenantCap(c.limit, c.tenants); got != c.want {
			t.Errorf("perTenantCap(%d, %d) = %d, want %d", c.limit, c.tenants, got, c.want)
		}
	}

	// The cap must never be able to strand the pool: K tenants at cap each must
	// be able to fill the batch.
	for limit := 1; limit <= 256; limit++ {
		for tenants := 1; tenants <= limit; tenants++ {
			cap := perTenantCap(limit, tenants)
			if cap < 1 {
				t.Fatalf("perTenantCap(%d,%d) = %d; a zero cap claims nothing", limit, tenants, cap)
			}
			if cap*tenants < limit {
				t.Fatalf("perTenantCap(%d,%d) = %d; %d tenants cannot fill the batch", limit, tenants, cap, tenants)
			}
		}
	}
}

func TestPickTenantsTruncatesAndShuffles(t *testing.T) {
	snapshot := make([]tenant, 40)
	for i := range snapshot {
		snapshot[i] = tenant{OrganizationID: "org", ProjectID: string(rune('a' + i%26))}
	}
	rng := rand.New(rand.NewSource(3))

	if got := pickTenants(snapshot, 10, rng); len(got) != 10 {
		t.Fatalf("pickTenants took %d pairs, want K = min(len, limit) = 10", len(got))
	}
	if got := pickTenants(snapshot[:3], 10, rng); len(got) != 3 {
		t.Fatalf("pickTenants took %d pairs from a 3-tenant snapshot", len(got))
	}
	if got := pickTenants(nil, 10, rng); got != nil {
		t.Fatal("an empty snapshot must produce no pairs so the caller falls back to FIFO")
	}

	// The shuffle is load bearing: without it the claim's outer LIMIT would
	// always truncate whichever tenants sort last, which is starvation dressed
	// as fairness.
	first := pickTenants(snapshot, 10, rng)
	differed := false
	for i := 0; i < 20 && !differed; i++ {
		next := pickTenants(snapshot, 10, rng)
		for j := range next {
			if next[j] != first[j] {
				differed = true
				break
			}
		}
	}
	if !differed {
		t.Fatal("pickTenants returned the same slice every time; tenants sorting last would never be claimed")
	}

	// It must not mutate the snapshot it was given.
	before := make([]tenant, len(snapshot))
	copy(before, snapshot)
	_ = pickTenants(snapshot, 5, rng)
	for i := range snapshot {
		if snapshot[i] != before[i] {
			t.Fatal("pickTenants mutated the shared snapshot")
		}
	}
}

func TestParseStrategyDefaultsToFIFO(t *testing.T) {
	for _, raw := range []string{"", "fifo", "FIFO", "  fifo  "} {
		s, err := ParseStrategy(raw)
		if err != nil {
			t.Fatalf("ParseStrategy(%q): %v", raw, err)
		}
		if s != StrategyFIFO {
			t.Fatalf("ParseStrategy(%q) = %q, want fifo (the deliberate default; see HANDOFF.md)", raw, s)
		}
	}
	for _, raw := range []string{"tenant_fair", "tenant-fair", "lateral", "TENANT_FAIR"} {
		s, err := ParseStrategy(raw)
		if err != nil {
			t.Fatalf("ParseStrategy(%q): %v", raw, err)
		}
		if s != StrategyTenantFair {
			t.Fatalf("ParseStrategy(%q) = %q, want tenant_fair", raw, s)
		}
	}
	if _, err := ParseStrategy("round-robin-ish"); err == nil {
		t.Fatal("an unknown strategy must fail configuration validation, not silently pick one")
	}
}
