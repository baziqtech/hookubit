package retention

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Retention instruments.
//
// They live in this package rather than in internal/metrics for the same reason
// the router's do (see internal/router/metrics.go): they register against the
// same default registry promhttp.Handler() serves, so they are indistinguishable
// at /metrics, and folding them into internal/metrics is a move rather than a
// rewrite. HANDOFF asks for that consolidation once both branches have landed.
//
// Neither is labelled by organisation, project or endpoint. Retention is a
// platform-wide reclamation and a per-tenant label here would grow a time series
// per customer forever, including churned ones.
//
// COUNTERS, not gauges. "How much of the ledger have we destroyed" is a
// cumulative fact, and the derivative is what an operator wants: a rate that
// jumps is a horizon someone shortened, and a rate that goes to zero while the
// table grows is a sweep that has stopped running.
var (
	// AttemptsPruned counts delivery_attempts rows removed at the SHORT
	// horizon. Rows cascaded away by a delivery delete are NOT counted here -
	// they are implied by DeliveriesPruned - so the two counters never
	// double-count the same row.
	AttemptsPruned = promauto.NewCounter(prometheus.CounterOpts{
		Name: "retention_delivery_attempts_pruned_total",
		Help: "delivery_attempts rows deleted by the retention sweep at the attempt horizon.",
	})

	// DeliveriesPruned counts delivery rows removed at the LONG horizon.
	//
	// This is the one to alert on. Sustained zero while the table grows means
	// the sweep is not running (the scheduler role is down, or
	// RETENTION_ENABLED is false); a step change means a horizon was shortened,
	// which is irreversible and worth noticing on the day it happens rather
	// than the day someone asks for a delivery that is gone.
	DeliveriesPruned = promauto.NewCounter(prometheus.CounterOpts{
		Name: "retention_deliveries_pruned_total",
		Help: "deliveries rows deleted by the retention sweep at the delivery horizon.",
	})
)
