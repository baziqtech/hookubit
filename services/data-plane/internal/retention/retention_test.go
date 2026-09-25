package retention

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/worker"
)

func quiet() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func testConfig() Config {
	c := DefaultConfig()
	c.BatchSize = 10
	c.MaxDeletesPerRun = 100
	return c
}

// TestTerminalStatusesMatchTheWorker is the pin the package comment promises.
//
// The asymmetry is what makes it worth a test rather than a comment: a terminal
// status MISSING from TerminalStatuses is a leak (those rows are never pruned),
// while a NON-terminal status PRESENT in it deletes a delivery out from under a
// worker that is still retrying it - after the platform has already answered
// 202 for the event. The second is unrecoverable, so both directions are
// asserted rather than just the one that is easy to notice.
func TestTerminalStatusesMatchTheWorker(t *testing.T) {
	every := []worker.State{
		worker.StatePending,
		worker.StateScheduled,
		worker.StateQueued,
		worker.StateProcessing,
		worker.StateSucceeded,
		worker.StateFailed,
		worker.StateRetrying,
		worker.StateExhausted,
		worker.StateCancelled,
	}
	for _, state := range every {
		pruned := slices.Contains(TerminalStatuses, string(state))
		if pruned != state.Terminal() {
			t.Fatalf("status %q: worker says terminal=%v, retention says prunable=%v",
				state, state.Terminal(), pruned)
		}
	}
	// And nothing in the list that the worker has never heard of, which is how
	// a typo would otherwise survive: a misspelled status matches no row, so
	// every assertion above still passes and the rows simply never get pruned.
	for _, status := range TerminalStatuses {
		if !slices.ContainsFunc(every, func(s worker.State) bool { return string(s) == status }) {
			t.Fatalf("TerminalStatuses contains %q, which is not a worker.State", status)
		}
	}
}

// The literal IN list is a planner requirement, not a style choice - see the
// comment on terminalPredicate. A parameterised status test silently costs both
// sweeps their partial index and turns every batch into a sequential scan of
// the largest table in the system, which no functional test would ever catch.
func TestBothStatementsCarryTheStatusListAsALiteral(t *testing.T) {
	for name, sql := range map[string]string{
		"prune attempts":   pruneAttemptsSQL,
		"prune deliveries": pruneDeliveriesSQL,
	} {
		for _, status := range TerminalStatuses {
			if !strings.Contains(sql, "'"+status+"'") {
				t.Errorf("%s: status %q is not a literal in the statement", name, status)
			}
		}
		if strings.Contains(sql, "ANY(") {
			t.Errorf("%s: the status test is parameterised; the partial index will not be used", name)
		}
	}
}

func TestRunOncePrunesAttemptsBeforeDeliveries(t *testing.T) {
	db := &fakeDB{
		attemptBatches:  []attemptBatch{{attempts: 30, marked: 4}},
		deliveryBatches: []int64{3},
	}
	s, err := New(db, testConfig(), quiet())
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.AttemptsDeleted != 30 || report.DeliveriesMarked != 4 || report.DeliveriesDeleted != 3 {
		t.Fatalf("report = %+v", report)
	}
	if report.Truncated {
		t.Fatal("a pass that ran out of rows must not report a backlog")
	}
	// One short batch each is enough to stop; a sweep that kept issuing
	// statements against an empty candidate set would burn a connection every
	// interval forever.
	if len(db.attemptLimits) != 1 || len(db.deliveryLimits) != 1 {
		t.Fatalf("statements issued: attempts=%d deliveries=%d, want 1 each",
			len(db.attemptLimits), len(db.deliveryLimits))
	}
}

// A pass that ends because it ran out of BUDGET must say so. The distinction is
// the whole operator signal: "nothing to do" and "there is a backlog I did not
// reach" look identical in the row counts.
func TestRunOnceReportsTruncationWhenTheRunCeilingBinds(t *testing.T) {
	cfg := testConfig()
	cfg.BatchSize = 10
	cfg.MaxDeletesPerRun = 20

	db := &fakeDB{
		// Two full batches of ten marks each: exactly the ceiling, with the
		// candidate set still full.
		attemptBatches: []attemptBatch{{attempts: 50, marked: 10}, {attempts: 40, marked: 10}},
	}
	s, err := New(db, cfg, quiet())
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !report.Truncated {
		t.Fatal("the run ceiling bound and the report does not say so")
	}
	if report.DeliveriesMarked != 20 {
		t.Fatalf("marked %d, want the ceiling of 20", report.DeliveriesMarked)
	}
	// The budget was spent on the bulk. Reaching the delivery sweep as well
	// would take the pass past MaxDeletesPerRun, which is the number that
	// exists to stop the first run after this ships from becoming an incident.
	if len(db.deliveryLimits) != 0 {
		t.Fatalf("delivery sweep ran %d statements after the budget was spent", len(db.deliveryLimits))
	}
}

// The remaining budget must NARROW the last batch, not merely stop the loop
// after it. Otherwise a run configured for 20 deletes issues a full 1,000-row
// statement and deletes 1,000.
func TestTheLastBatchIsNarrowedToTheRemainingBudget(t *testing.T) {
	cfg := testConfig()
	cfg.BatchSize = 10
	cfg.MaxDeletesPerRun = 14

	db := &fakeDB{attemptBatches: []attemptBatch{{attempts: 20, marked: 10}, {attempts: 5, marked: 4}}}
	s, err := New(db, cfg, quiet())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := db.attemptLimits; len(got) != 2 || got[0] != 10 || got[1] != 4 {
		t.Fatalf("limits issued = %v, want [10 4]", got)
	}
}

// A terminal delivery that was never attempted - cancelled by an operator, or
// exhausted behind an open breaker with no attempt row - contributes a mark and
// ZERO attempt rows. Stopping the loop on a zero attempt count would leave
// exactly those deliveries unmarked, so every subsequent pass would re-select
// them, delete nothing, and never make progress.
func TestABatchOfDeliveriesWithNoAttemptRowsStillCounts(t *testing.T) {
	cfg := testConfig()
	cfg.BatchSize = 3
	cfg.MaxDeletesPerRun = 100

	db := &fakeDB{attemptBatches: []attemptBatch{{attempts: 0, marked: 3}, {attempts: 0, marked: 1}}}
	s, err := New(db, cfg, quiet())
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.DeliveriesMarked != 4 {
		t.Fatalf("marked %d, want 4", report.DeliveriesMarked)
	}
	if len(db.attemptLimits) != 2 {
		t.Fatalf("issued %d statements, want 2 - the full batch must not stop on a zero attempt count",
			len(db.attemptLimits))
	}
}

// Each sweep is issued with ITS OWN horizon. Crossing them would either delete
// attempt detail that should still be here or, far worse, delete delivery rows
// at the shorter horizon.
func TestEachSweepUsesItsOwnHorizon(t *testing.T) {
	cfg := testConfig()
	cfg.AttemptAge = 48 * time.Hour
	cfg.DeliveryAge = 96 * time.Hour

	db := &fakeDB{}
	s, err := New(db, cfg, quiet())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := db.attemptIntervals; len(got) != 1 || got[0] != "172800 seconds" {
		t.Fatalf("attempt interval = %v, want [172800 seconds]", got)
	}
	if got := db.deliveryIntervals; len(got) != 1 || got[0] != "345600 seconds" {
		t.Fatalf("delivery interval = %v, want [345600 seconds]", got)
	}
}

// A failing attempt sweep must not silently hand its budget to the DELETE. The
// delivery sweep is the destructive one; a pass that could not complete the
// cheap half has no business running the expensive half.
func TestAFailedAttemptSweepStopsThePass(t *testing.T) {
	db := &fakeDB{attemptErr: errors.New("boom")}
	s, err := New(db, testConfig(), quiet())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunOnce(context.Background()); err == nil {
		t.Fatal("expected the pass to fail")
	}
	if len(db.deliveryLimits) != 0 {
		t.Fatal("the delivery sweep ran after the attempt sweep failed")
	}
}

// Run returns nil on cancellation and never ticks before the first interval:
// the scheduler also owns lease reclaim, and a crash-looping pod must not run a
// retention pass per restart.
func TestRunDoesNotSweepBeforeItsFirstTickAndReturnsNilOnCancel(t *testing.T) {
	cfg := testConfig()
	cfg.Interval = time.Hour

	db := &fakeDB{}
	s, err := New(db, cfg, quiet())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Run(ctx); err != nil {
		t.Fatalf("Run returned %v, want nil on cancellation", err)
	}
	if len(db.attemptLimits) != 0 || len(db.deliveryLimits) != 0 {
		t.Fatal("Run swept before its first tick")
	}
}

func TestRunIsANoOpWhenDisabled(t *testing.T) {
	cfg := testConfig()
	cfg.Enabled = false

	db := &fakeDB{}
	s, err := New(db, cfg, quiet())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(db.attemptLimits) != 0 || len(db.deliveryLimits) != 0 {
		t.Fatal("a disabled sweeper deleted something")
	}
}

// New refuses an unusable policy rather than correcting it. Every field bounds
// how much of the delivery ledger is destroyed, so a silently substituted
// default is the wrong failure mode.
func TestNewRefusesAnInvalidPolicy(t *testing.T) {
	cfg := testConfig()
	cfg.DeliveryAge = time.Hour
	if _, err := New(&fakeDB{}, cfg, quiet()); err == nil {
		t.Fatal("expected a horizon below the floor to be refused")
	}
	if _, err := New(nil, DefaultConfig(), quiet()); err == nil {
		t.Fatal("expected a nil DB to be refused")
	}
}
