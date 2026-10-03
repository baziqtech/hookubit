package worker

import (
	"fmt"
	"sync"
	"testing"
)

// The streak has to be CONSECUTIVE and it has to reset once it has been acted
// on, or a delivery that stays stuck pays a query on every refusal from the
// moment it first crosses the threshold - which is the cost the tenant gate
// exists to avoid.
func TestTenantGateWatchReportsOnTheNthConsecutiveRefusal(t *testing.T) {
	w := newTenantGateWatch(3, 64)

	for i := 1; i < 3; i++ {
		if w.persistent("del_1") {
			t.Fatalf("refusal %d asked for a budget read; the ceiling is momentary until it is not", i)
		}
	}
	if !w.persistent("del_1") {
		t.Fatal("the third consecutive refusal did not ask for a budget read")
	}
	// Reset, so the next read is another three refusals away.
	if w.persistent("del_1") {
		t.Fatal("the refusal immediately after a check asked for another read")
	}
	if w.tracked() > 1 {
		t.Fatalf("tracking %d deliveries after one; the counter did not reset", w.tracked())
	}
}

// A delivery that gets THROUGH the gate is not stuck, and its streak is over.
// This is also what keeps the tracker's memory proportional to deliveries that
// are actually losing rather than to every delivery ever refused.
func TestTenantGateWatchForgetsADeliveryThatGotThrough(t *testing.T) {
	w := newTenantGateWatch(3, 64)

	w.persistent("del_1")
	w.persistent("del_1")
	w.forget("del_1")
	if w.tracked() != 0 {
		t.Fatalf("tracking %d deliveries after forgetting the only one", w.tracked())
	}

	// And the streak restarts from zero rather than resuming at two.
	if w.persistent("del_1") {
		t.Fatal("a delivery that ran and was then refused once was treated as persistently stuck")
	}
}

// Delivery ids are unbounded in cardinality - the tracked set is the refused
// backlog, which under the saturation this exists for is many multiples of the
// pool. An unbounded map here would be an outage of its own, so the rotation
// has to hold.
func TestTenantGateWatchMemoryIsBounded(t *testing.T) {
	const capacity = 128
	w := newTenantGateWatch(5, capacity)

	for i := 0; i < capacity*20; i++ {
		w.persistent(fmt.Sprintf("del_%d", i))
	}
	if got := w.tracked(); got > 2*capacity {
		t.Fatalf("tracking %d deliveries against a capacity of %d; the rotation is not bounding memory",
			got, capacity)
	}
}

// A rotation must DELAY a check, not cancel it. Clearing outright would let a
// large enough churn reset every counter forever and silently restore the bug
// this whole mechanism closes. A count survives exactly one rotation; beyond
// that it is dropped and re-accumulates, which costs a stuck delivery a few
// more refusals against a budget measured in hours.
func TestTenantGateWatchRotationCarriesTheCountForward(t *testing.T) {
	w := newTenantGateWatch(3, 4)

	w.persistent("del_target") // 1
	// Fill the current generation with other ids so exactly one rotation
	// happens: the target's count moves to the previous generation, which is
	// still readable.
	for i := 0; i < 4; i++ {
		w.persistent(fmt.Sprintf("del_other_%d", i))
	}
	// The target's count survived in the previous generation, so two more
	// refusals - not three - reach the threshold.
	if w.persistent("del_target") { // 2
		t.Fatal("reached the threshold a refusal early")
	}
	if !w.persistent("del_target") { // 3
		t.Fatal("a rotation cancelled the streak instead of delaying it; a stuck delivery would never be checked")
	}
}

func TestTenantGateWatchIsSafeUnderConcurrency(t *testing.T) {
	w := newTenantGateWatch(3, 256)

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				id := fmt.Sprintf("del_%d", (i*j)%64)
				w.persistent(id)
				if j%7 == 0 {
					w.forget(id)
				}
			}
		}(i)
	}
	wg.Wait()
}

// Defensive: a zero threshold would make every refusal pay a query, and a zero
// capacity would make the map thrash. Neither is reachable from the shipped
// constants, and both must be harmless if they ever are.
func TestTenantGateWatchClampsDegenerateSettings(t *testing.T) {
	w := newTenantGateWatch(0, 0)
	if !w.persistent("del_1") {
		t.Fatal("a threshold of zero should clamp to one, checking on the first refusal")
	}
}
