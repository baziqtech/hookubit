package metrics

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	dto "github.com/prometheus/client_model/go"
)

func gaugeValue(t *testing.T, state string) float64 {
	t.Helper()
	var m dto.Metric
	if err := QueueDepth.WithLabelValues(state).Write(&m); err != nil {
		t.Fatalf("read queue_depth{state=%q}: %v", state, err)
	}
	return m.GetGauge().GetValue()
}

// fakeRows is the smallest thing that satisfies pgx.Rows. Only Next, Scan, Err
// and Close carry behaviour; the rest exist because the interface says so.
type fakeRows struct {
	rows [][2]any // state, count
	i    int
	err  error
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return r.err }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Values() ([]any, error)                       { return nil, nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }

func (r *fakeRows) Next() bool {
	if r.i >= len(r.rows) {
		return false
	}
	r.i++
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	row := r.rows[r.i-1]
	*(dest[0].(*string)) = row[0].(string)
	*(dest[1].(*int64)) = row[1].(int64)
	return nil
}

type fakeQuerier struct {
	answers []*fakeRows
	err     error
	calls   int
}

func (q *fakeQuerier) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	if q.err != nil {
		return nil, q.err
	}
	rows := q.answers[q.calls]
	q.calls++
	return rows, nil
}

// The zeroing behaviour is the whole reason this is not two lines of code. A
// state that stops appearing in the result - the last in-flight delivery
// finishing - must be published as 0 rather than left at its last value, or the
// dashboard keeps showing work that finished minutes ago until something
// restarts the process.
func TestRefreshPublishesEveryStateIncludingTheOnesThatVanish(t *testing.T) {
	q := &fakeQuerier{answers: []*fakeRows{
		{rows: [][2]any{{StateReady, int64(7)}, {StateInFlight, int64(3)}}},
		{rows: nil},
	}}
	c := NewQueueDepthCollector(q, 0, nil)

	if err := c.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if got := gaugeValue(t, StateReady); got != 7 {
		t.Fatalf("queue_depth{state=ready} = %v, want 7", got)
	}
	if got := gaugeValue(t, StateInFlight); got != 3 {
		t.Fatalf("queue_depth{state=in_flight} = %v, want 3", got)
	}
	// Absent from the result set, so it must be published as an explicit zero.
	if got := gaugeValue(t, StateDelayed); got != 0 {
		t.Fatalf("queue_depth{state=delayed} = %v, want 0", got)
	}

	if err := c.Refresh(context.Background()); err != nil {
		t.Fatalf("second Refresh: %v", err)
	}
	for _, state := range []string{StateReady, StateDelayed, StateInFlight} {
		if got := gaugeValue(t, state); got != 0 {
			t.Fatalf("queue_depth{state=%s} = %v after an empty queue, want 0: a state that stops "+
				"appearing is being left at its last value", state, got)
		}
	}
}

// A database that cannot be queried is not evidence that the queue is empty.
// Publishing zero on a failed refresh would turn a database incident into a
// green backlog graph, which is the one moment an operator most needs the
// number to be honest.
func TestAFailedRefreshLeavesTheLastKnownDepthAlone(t *testing.T) {
	ok := &fakeQuerier{answers: []*fakeRows{{rows: [][2]any{{StateReady, int64(42)}}}}}
	if err := NewQueueDepthCollector(ok, 0, nil).Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	broken := NewQueueDepthCollector(&fakeQuerier{err: errors.New("connection refused")}, 0, nil)
	if err := broken.Refresh(context.Background()); err == nil {
		t.Fatal("Refresh reported success against a database that refused the query")
	}
	if got := gaugeValue(t, StateReady); got != 42 {
		t.Fatalf("queue_depth{state=ready} = %v after a failed refresh, want the last known 42", got)
	}
}

// Run must survive a broken database and must exit cleanly on cancellation: a
// metrics refresher that returns an error kills whichever role hosts it, which
// would mean an unreachable database takes out the scheduler for the sake of a
// gauge.
func TestRunStopsOnCancellationWithoutReportingAnError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := NewQueueDepthCollector(&fakeQuerier{err: errors.New("connection refused")}, 0, nil)
	cancel()
	if err := c.Run(ctx); err != nil {
		t.Fatalf("Run returned %v on a cancelled context, want nil", err)
	}
}
