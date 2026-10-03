package retention

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeDB answers the two retention statements from a scripted list of batch
// outcomes, so the batching, the per-run ceiling and the stop conditions can be
// asserted without a database. The SQL itself is exercised against a real
// PostgreSQL in retention_postgres_test.go; these two suites deliberately do
// not overlap.
type fakeDB struct {
	mu sync.Mutex

	// attemptBatches is consumed one entry per prune-attempts statement.
	attemptBatches []attemptBatch
	// deliveryBatches is consumed one entry per prune-deliveries statement.
	deliveryBatches []int64

	// limits records the LIMIT each statement was issued with, in order, so a
	// test can prove the per-run budget really narrows the last batch rather
	// than only stopping the loop afterwards.
	attemptLimits  []int
	deliveryLimits []int

	// intervals records the interval literal each statement was issued with.
	attemptIntervals  []string
	deliveryIntervals []string

	attemptErr  error
	deliveryErr error
}

type attemptBatch struct {
	attempts int64
	marked   int64
}

func (f *fakeDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !strings.Contains(sql, "delivery_attempts") {
		return nil, fmt.Errorf("unexpected Query: %s", sql)
	}
	f.attemptIntervals = append(f.attemptIntervals, args[0].(string))
	f.attemptLimits = append(f.attemptLimits, args[1].(int))
	if f.attemptErr != nil {
		return nil, f.attemptErr
	}
	if len(f.attemptBatches) == 0 {
		return &fakeRows{batch: attemptBatch{}}, nil
	}
	next := f.attemptBatches[0]
	f.attemptBatches = f.attemptBatches[1:]
	return &fakeRows{batch: next}, nil
}

func (f *fakeDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !strings.Contains(sql, "DELETE FROM deliveries") {
		return pgconn.CommandTag{}, fmt.Errorf("unexpected Exec: %s", sql)
	}
	f.deliveryIntervals = append(f.deliveryIntervals, args[0].(string))
	f.deliveryLimits = append(f.deliveryLimits, args[1].(int))
	if f.deliveryErr != nil {
		return pgconn.CommandTag{}, f.deliveryErr
	}
	var n int64
	if len(f.deliveryBatches) > 0 {
		n = f.deliveryBatches[0]
		f.deliveryBatches = f.deliveryBatches[1:]
	}
	return pgconn.NewCommandTag(fmt.Sprintf("DELETE %d", n)), nil
}

// fakeRows is the single-row, two-column result the prune-attempts statement
// produces. Everything the interface requires beyond that is a stub, because
// nothing in this package calls it.
type fakeRows struct {
	batch    attemptBatch
	consumed bool
	closed   bool
}

func (r *fakeRows) Close()                                       { r.closed = true }
func (r *fakeRows) Err() error                                   { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Values() ([]any, error)                       { return nil, errors.New("not used") }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }

func (r *fakeRows) Next() bool {
	if r.consumed {
		return false
	}
	r.consumed = true
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	if len(dest) != 2 {
		return fmt.Errorf("expected 2 destinations, got %d", len(dest))
	}
	*(dest[0].(*int64)) = r.batch.attempts
	*(dest[1].(*int64)) = r.batch.marked
	return nil
}
