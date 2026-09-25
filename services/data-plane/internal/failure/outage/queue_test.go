package outage_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/queue"
	"github.com/shaq/hookubit/services/data-plane/internal/testsupport"
)

// TestScenario09_QueueUnavailable_ReportsTheOutageAndLosesNothing covers
// ARCHITECTURE.md 57 scenario 9: the queue becomes unavailable.
//
// In this platform the queue IS PostgreSQL (ADR-0003): queue.PostgresQueue
// claims rows with SELECT ... FOR UPDATE SKIP LOCKED, and Redis is never
// allowed to be the record. "The queue is unavailable" is therefore exactly
// "the database the deliveries table lives in is unreachable", which is what
// the relay injects here.
//
// Recovery strategy asserted:
//   - Claim returns an ERROR, never an empty batch. This is the assertion that
//     matters most: a queue that answers "nothing ready" during an outage is
//     indistinguishable from an idle system, so the workers go quiet, the
//     backlog is invisible, and no alert fires.
//   - The rows are untouched. Nothing is dropped, nothing is advanced, nothing
//     is marked failed because the queue could not be read.
//   - When the database returns, the same rows are claimable again with no
//     intervention, and a lease that lapsed during the outage is reclaimable -
//     which is the same code path a crashed worker recovers through.
//
// A production regression would look like: claimFIFO swallowing its error and
// returning (nil, nil), or an outage transitioning rows to `failed`, or
// deliveries stranded in `processing` after the outage with no path back into
// the ready set.
func TestScenario09_QueueUnavailable_ReportsTheOutageAndLosesNothing(t *testing.T) {
	dsn := testsupport.DSN(t)
	truth := directPool(t)
	seed := seedTenant(t, truth)

	// Three deliveries waiting, plus one already leased to a worker with a
	// short lease so the recovery half can watch it come back.
	pending := []string{
		seed.insertDelivery(t, "pending", "", 0),
		seed.insertDelivery(t, "pending", "", 0),
		seed.insertDelivery(t, "pending", "", 0),
	}
	leased := seed.insertDelivery(t, "processing", "worker_gone", 1500*time.Millisecond)

	proxy := newTCPProxy(t, upstreamOf(t, dsn))
	pool := proxiedPool(t, proxy, dsn, 4)
	q := queue.NewPostgresQueue(pool, queue.StrategyFIFO)

	ctx := context.Background()

	// Healthy baseline: one delivery claimed and held under a live lease.
	first, err := q.Claim(ctx, "worker_a", 1, 30*time.Second)
	if err != nil {
		t.Fatalf("baseline Claim: %v", err)
	}
	if len(first) != 1 {
		t.Fatalf("baseline Claim returned %d leases, want 1", len(first))
	}
	inFlight := first[0].Job.DeliveryID

	// The outage.
	proxy.down()

	claimed, err := q.Claim(ctx, "worker_a", 10, 30*time.Second)
	if err == nil {
		t.Fatalf("Claim returned (%d leases, nil error) while the queue's database was unreachable; an "+
			"outage that reads as an empty ready set silences the workers and hides the backlog", len(claimed))
	}
	if claimed != nil {
		t.Fatalf("Claim returned %d leases alongside its error; a partial batch under an outage is a batch "+
			"no worker can trust", len(claimed))
	}

	// Renew is the other call a worker makes every second, and its failure
	// mode is the dangerous one: `lost` means "abandon the attempt", so an
	// outage must produce an error, never a lost list.
	lost, err := q.Renew(ctx, "worker_a", []string{inFlight}, 30*time.Second)
	if err == nil {
		t.Fatal("Renew succeeded while the database was unreachable")
	}
	if lost != nil {
		t.Fatalf("Renew reported %d lost leases during a transport failure; a worker that believes its "+
			"lease is gone discards a delivery it may have already made", len(lost))
	}

	// Release, likewise: a failure to give a job back must be reported, not
	// mistaken for the lease having been reclaimed.
	relErr := q.Release(ctx, "worker_a", inFlight)
	if relErr == nil {
		t.Fatal("Release succeeded while the database was unreachable")
	}
	if errors.Is(relErr, queue.ErrLeaseLost) {
		t.Fatal("Release reported ErrLeaseLost for a transport failure: 'I could not ask' was turned into " +
			"'somebody else owns this now', which is a claim the caller acts on irreversibly")
	}

	// Nothing durable moved. Read through the direct pool: this is the
	// database's own account, not the pool that just failed.
	if n := scalar[int](t, truth,
		`SELECT count(*)::int FROM deliveries WHERE organization_id = $1`, seed.orgID); n != 4 {
		t.Fatalf("deliveries for the tenant = %d, want 4: the outage lost rows", n)
	}
	if n := scalar[int](t, truth,
		`SELECT count(*)::int FROM deliveries WHERE organization_id = $1 AND status IN ('failed','exhausted','cancelled')`,
		seed.orgID); n != 0 {
		t.Fatalf("%d deliveries reached a terminal state during a database outage; an outage of OURS must "+
			"never be recorded as the endpoint failing", n)
	}

	// Recovery.
	proxy.up(t)

	// The lease on `leased` (1.5s) is what stands between that row and a fresh
	// claim; `inFlight` is still held by worker_a under a live 30s lease and
	// must NOT come back. Wait out the short lease and give the pool a moment
	// to replace the connections the outage killed.
	var wanted []string
	for _, id := range pending {
		if id != inFlight {
			wanted = append(wanted, id)
		}
	}
	wanted = append(wanted, leased)

	// Claims are ACCUMULATED across polls, exactly as a worker fleet drains a
	// backlog: one poll may come back before the lapsed lease expires, and the
	// rows it took are then leased to worker_b and will not appear again.
	got := map[string]bool{}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		recovered, claimErr := q.Claim(ctx, "worker_b", 10, 30*time.Second)
		if claimErr == nil {
			err = nil
			for _, l := range recovered {
				got[l.Job.DeliveryID] = true
			}
		} else {
			err = claimErr
		}
		if allSeen(got, wanted) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("Claim never succeeded after the database returned: %v", err)
	}
	for _, id := range wanted {
		if !got[id] {
			t.Fatalf("delivery %s was never claimed after the database returned; it is stranded, and for "+
				"the lapsed lease that means an expired lease is not reclaimable by the ordinary claim "+
				"query - the path a crashed worker's rows come back through", id)
		}
	}
	if got[inFlight] {
		t.Fatalf("delivery %s was handed to a second worker while worker_a still holds a live lease on it: "+
			"an outage must not turn into a duplicate delivery", inFlight)
	}
}

// allSeen reports whether every wanted delivery has been claimed at some point
// during the recovery poll.
func allSeen(got map[string]bool, wanted []string) bool {
	for _, id := range wanted {
		if !got[id] {
			return false
		}
	}
	return true
}
