package worker

import "sync"

// tenantGateBudgetCheckAfter is how many times one delivery must be refused by
// the org/project concurrency gate before the worker spends a query finding out
// whether its wall-clock budget has run out.
//
// It is a constant, not a knob. Every value in the plausible range behaves the
// same way against the thing it is trading off: with the gate's ~2s jittered
// deferral, three refusals is about six seconds, which is nothing against a
// max_retry_duration measured in hours, while the query cost falls to a third
// of the refusals on the saturated path. There is no deployment for which some
// other small integer is the difference between working and not, and a knob
// nobody can reason about is worse than a number written down here.
const tenantGateBudgetCheckAfter = 3

// tenantGateWatchCapacity bounds how many deliveries the tracker remembers at
// once, across both generations. Sized well above the worker pool because the
// tracked set is deliveries REFUSED - which, under the saturation this exists
// for, is many multiples of the deliveries running.
const tenantGateWatchCapacity = 4096

// tenantGateWatch answers one question: has this delivery been refused by the
// tenant concurrency gate enough times in a row that it is worth paying a query
// to check its clock?
//
// WHY THIS EXISTS. The org/project gate refuses BEFORE the delivery row is read
// - deliberately, so a delivery that cannot run costs one UPDATE rather than a
// join and a decrypt - and therefore defers with an unknown budget. An unknown
// budget never expires, by construction. A delivery that keeps losing at that
// gate is rescheduled on every claim and never consults max_retry_duration:
// exactly the hole the breaker path had before the wall-clock check moved onto
// the deferral path, surviving on the one path that could not see the row.
//
// The obvious fixes are both bad. Reading the row on every refusal puts a query
// on the path that is saturated, which is the reason the gate is where it is.
// Carrying the budget in the claim result would make it free, but it means
// changing the claim SQL - the most load-bearing statement in the system - to
// serve a case that is rare by construction.
//
// So the cost is paid on the Nth consecutive refusal instead. A momentary
// ceiling, which is the overwhelmingly common case, costs exactly what it did
// before; a delivery genuinely stuck behind a saturated project pays one cheap
// read every N refusals and can reach a terminal state.
//
// BOUNDED MEMORY. The keys are delivery ids, whose cardinality is the refused
// backlog and therefore unbounded on a busy platform - the same trap the
// metrics package refuses to walk into. Two mechanisms keep it small:
//
//   - forget, called the moment a delivery gets THROUGH the gate. Only deliveries
//     currently losing are remembered.
//   - a generational rotation. At capacity the current map becomes the previous
//     one and a fresh map starts; the previous generation is still readable, so
//     a count survives one rotation and memory is bounded at two generations.
//     Clearing outright would let a large enough churn reset every counter
//     forever and silently restore the bug this closes.
//
// Losing a count is always safe. The consequence is that a stuck delivery is
// checked a few refusals later than it might have been, against a budget
// measured in hours.
type tenantGateWatch struct {
	mu        sync.Mutex
	threshold int
	capacity  int
	cur       map[string]int
	prev      map[string]int
}

func newTenantGateWatch(threshold, capacity int) *tenantGateWatch {
	if threshold < 1 {
		threshold = 1
	}
	if capacity < 1 {
		capacity = 1
	}
	return &tenantGateWatch{
		threshold: threshold,
		capacity:  capacity,
		cur:       make(map[string]int),
	}
}

// persistent records one refusal and reports whether this delivery has now been
// refused enough times in a row to be worth a budget read.
//
// The counter is RESET when it reports true, so a delivery that stays stuck
// pays one read per threshold refusals rather than one per refusal from then
// on.
func (t *tenantGateWatch) persistent(deliveryID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	n, ok := t.cur[deliveryID]
	if !ok {
		// Carry a count forward from the previous generation, so a rotation
		// delays a check rather than cancelling it.
		n = t.prev[deliveryID]
	}
	n++

	if n >= t.threshold {
		delete(t.cur, deliveryID)
		delete(t.prev, deliveryID)
		return true
	}

	if len(t.cur) >= t.capacity {
		t.prev = t.cur
		t.cur = make(map[string]int, t.capacity/2)
	}
	t.cur[deliveryID] = n
	return false
}

// forget drops a delivery's streak. Called when it gets through the gate: the
// streak is CONSECUTIVE refusals, and a delivery that ran is not stuck.
func (t *tenantGateWatch) forget(deliveryID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.cur) == 0 && len(t.prev) == 0 {
		return
	}
	delete(t.cur, deliveryID)
	delete(t.prev, deliveryID)
}

// tracked reports how many deliveries the watch is currently remembering. Test
// helper for the "memory is bounded" property.
func (t *tenantGateWatch) tracked() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.cur) + len(t.prev)
}
