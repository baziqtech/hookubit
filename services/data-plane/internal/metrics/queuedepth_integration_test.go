package metrics

import (
	"context"
	"testing"

	"github.com/shaq/webhook-platform/services/data-plane/internal/testsupport"
)

// The depth query names five status values, three columns and one table, and
// every one of them belongs to a Prisma schema this module does not own
// (ADR-0002). A rename in the control plane would leave this collector logging
// a warning every fifteen seconds while the gauge sat at its last value - which
// looks exactly like a quiet queue.
//
// So this runs the real SQL against the real migrated schema. It skips rather
// than fails when there is no database, the same convention as internal/queue.
func TestQueueDepthSQLMatchesTheMigratedSchema(t *testing.T) {
	pool := testsupport.Pool(t)

	c := NewQueueDepthCollector(pool, 0, nil)
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh queue depth against the real schema: %v", err)
	}

	// This package's own database has no deliveries in it, so every state must
	// be published as an explicit zero. That is a real assertion, not a tautology:
	// it proves the query ran, returned no rows, and still produced all three
	// series - an exporter that publishes nothing until the first delivery
	// exists is one an alert rule cannot be written against.
	for _, state := range []string{StateReady, StateDelayed, StateInFlight} {
		if got := gaugeValue(t, state); got != 0 {
			t.Fatalf("queue_depth{state=%s} = %v on an empty database, want 0", state, got)
		}
	}
}
