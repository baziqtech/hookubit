package failure_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/queue"
)

// drainAll claims until the ready set is empty, returning every delivery id in
// claim order and failing if any id is handed out twice.
func drainAll(t *testing.T, q *queue.PostgresQueue, workerID string, batch int) []string {
	t.Helper()
	seen := map[string]bool{}
	var order []string
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		leases, err := q.Claim(context.Background(), workerID, batch, time.Hour)
		if err != nil {
			t.Fatalf("claim: %v", err)
		}
		if len(leases) == 0 {
			return order
		}
		for _, l := range leases {
			if seen[l.Job.DeliveryID] {
				t.Fatalf("delivery %s was claimed twice while draining", l.Job.DeliveryID)
			}
			seen[l.Job.DeliveryID] = true
			order = append(order, l.Job.DeliveryID)
		}
	}
	t.Fatal("draining the ready set did not finish within 30s")
	return nil
}

// burstFixture is two tenants: one that floods and one that must not be
// harmed by the flood.
type burstFixture struct {
	flooder   *fixture
	neighbour *fixture
	burst     map[string]bool
	quiet     map[string]bool
	total     int
}

// seedBurst plants a large backlog for one tenant, older than a handful of
// deliveries belonging to a second tenant. The age ordering is deliberate and
// generous - an hour versus a minute - because next_attempt_at is timestamp(3)
// and the claim orders on it; a test whose expected ordering turns on sub-
// millisecond differences is measuring PostgreSQL's rounding, not the queue.
func seedBurst(t *testing.T, pool *pgxpool.Pool, burstSize, quietSize int) *burstFixture {
	t.Helper()
	resetQueue(t, pool)

	flooder := seedTenant(t, pool)
	neighbour := seedTenant(t, pool)
	floodEndpoint := flooder.newEndpoint(t, endpointOpts{noSecret: true})
	quietEndpoint := neighbour.newEndpoint(t, endpointOpts{noSecret: true})

	b := &burstFixture{
		flooder:   flooder,
		neighbour: neighbour,
		burst:     map[string]bool{},
		quiet:     map[string]bool{},
		total:     burstSize + quietSize,
	}
	for _, id := range flooder.newDeliveries(t, floodEndpoint, burstSize, -time.Hour) {
		b.burst[id] = true
	}
	for _, id := range neighbour.newDeliveries(t, quietEndpoint, quietSize, -time.Minute) {
		b.quiet[id] = true
	}
	return b
}

// TestScenario19_TenantBurstDrainsUnderTheDefaultClaim covers the first half of
// ARCHITECTURE.md 57 case 19: a tenant publishes a huge burst.
//
// Recovery strategy asserted: the ready set drains completely and exactly once.
// Sixty-five deliveries across two tenants are claimed in batches until nothing
// is ready, and no id is ever handed out twice.
//
// It also records what the DEFAULT claim does NOT promise, and this is the
// honest part of the scenario. queue.NewPostgresQueue defaults to
// StrategyFIFO (see its doc comment: ADR-0007's tenant-fair lateral is
// implemented but opt-in behind CLAIM_STRATEGY until the head-of-line delay
// metric shows real starvation). claimFIFOSQL orders the whole ready set by
// (next_attempt_at, created_at) with no tenant predicate at all, so the older
// burst is claimed in full before the neighbour's first delivery is looked at.
// There is no fairness guarantee in the shipped default, and this test asserts
// that reality rather than a hoped-for one.
//
// What a regression looks like in production: nothing here regresses quietly -
// what changes is the operational consequence. On the FIFO default a tenant
// that publishes 100k events delays every other tenant's deliveries by the time
// it takes to drain that backlog, and the symptom reaches the neighbour as
// "your webhooks are hours late" with nothing wrong on their side.
// queue_head_of_line_delay_seconds is the metric that makes it visible;
// CLAIM_STRATEGY=tenant_fair is the remedy, exercised by the next test.
func TestScenario19_TenantBurstDrainsUnderTheDefaultClaim(t *testing.T) {
	pool := requirePool(t)
	b := seedBurst(t, pool, 60, 5)

	q := queue.NewPostgresQueue(pool, queue.StrategyFIFO)

	// The first batch is the fairness observation.
	first, err := q.Claim(context.Background(), "wrk_fifo", 10, time.Hour)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(first) != 10 {
		t.Fatalf("first batch = %d rows, want 10", len(first))
	}
	quietInFirst := 0
	for _, l := range first {
		if b.quiet[l.Job.DeliveryID] {
			quietInFirst++
		}
	}
	if quietInFirst != 0 {
		t.Fatalf("the FIFO claim returned %d of the neighbour's deliveries in the first batch. "+
			"That is better than this test expects, which means the default strategy changed: "+
			"update this test and the fairness claims in docs, do not just relax the assertion", quietInFirst)
	}

	// ...and the queue still drains completely.
	rest := drainAll(t, q, "wrk_fifo", 10)
	claimed := len(first) + len(rest)
	if claimed != b.total {
		t.Fatalf("drained %d deliveries, want %d: a burst must not leave rows behind", claimed, b.total)
	}

	stillReady := countRows(t, pool,
		`SELECT count(*) FROM deliveries
		  WHERE status IN ('pending','scheduled','queued','retrying')`)
	if stillReady != 0 {
		t.Fatalf("%d deliveries are still unclaimed after the drain", stillReady)
	}
}

// TestScenario19_TenantFairClaimProtectsTheNeighbour covers the second half of
// ARCHITECTURE.md 57 case 19: one tenant's burst must not starve another's.
//
// Recovery strategy asserted: with CLAIM_STRATEGY=tenant_fair the claim becomes
// claimTenantFairSQL - a LATERAL with a per-tenant LIMIT derived from the number
// of tenants with ready work. With two active tenants and a batch of ten the cap
// is five each, so the neighbour's deliveries are in the FIRST batch even though
// every one of them is an hour younger than the burst.
//
// The per-tenant cap being DERIVED rather than constant is the part worth
// guarding: with a single active tenant the cap is the whole batch, so a lone
// tenant is not throttled to `cap` rows per poll in front of an idle pool. This
// test asserts the two-tenant split; queue's own unit tests cover the derivation.
//
// What a regression looks like in production: hard-code the cap, and a single
// customer's backlog drains at cap-rows-per-poll while workers idle. Drop the
// shuffle in pickTenants, and the outer LIMIT systematically truncates whichever
// tenants sort last - starvation wearing a fairness costume, and much harder to
// spot than plain FIFO because the metric looks healthy for most tenants.
func TestScenario19_TenantFairClaimProtectsTheNeighbour(t *testing.T) {
	pool := requirePool(t)
	b := seedBurst(t, pool, 60, 5)

	q := queue.NewPostgresQueue(pool, queue.StrategyTenantFair)

	first, err := q.Claim(context.Background(), "wrk_fair", 10, time.Hour)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	var fromBurst, fromQuiet int
	for _, l := range first {
		switch {
		case b.burst[l.Job.DeliveryID]:
			fromBurst++
		case b.quiet[l.Job.DeliveryID]:
			fromQuiet++
		default:
			t.Fatalf("claimed a delivery this test never created: %s", l.Job.DeliveryID)
		}
	}
	if fromQuiet == 0 {
		t.Fatalf("the tenant-fair claim gave the neighbour none of the first batch (%d burst rows): "+
			"a burst in one project must not fill every slot", fromBurst)
	}
	if fromBurst == 0 {
		t.Fatal("the tenant-fair claim gave the flooding tenant nothing; fairness is a share, not a ban")
	}

	rest := drainAll(t, q, "wrk_fair", 10)
	if claimed := len(first) + len(rest); claimed != b.total {
		t.Fatalf("drained %d deliveries, want %d", claimed, b.total)
	}
}
