package router

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Router instruments.
//
// These live in this package rather than in internal/metrics only to keep the
// router and the worker off the same file while both are being written; they
// register against the same default registry that promhttp.Handler() serves, so
// they are indistinguishable at the /metrics endpoint. HANDOFF.md asks for them
// to be folded into internal/metrics once both branches have landed.
//
// Nothing below is labelled by organisation, project, endpoint, event or
// delivery. Those are unbounded in cardinality; per-entity questions are
// answered from the delivery ledger, which is what the operator UI queries.
var (
	// OutboxClaimed counts outbox rows leased by this process. Compare with
	// EventsRouted: a persistent gap is rows being claimed and released, which
	// means something is failing mid-transaction.
	OutboxClaimed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "router_outbox_claimed_total",
		Help: "Outbox rows leased by the router.",
	})

	// EventsRouted is the outcome of one outbox row, and the counter to alert
	// on. `routed` and `no_subscriptions` are both healthy; everything else
	// means an event did not turn into the deliveries someone expected.
	EventsRouted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "router_events_routed_total",
		Help: "Outbox rows resolved by the router, by outcome.",
	}, []string{"outcome"}) // routed | no_subscriptions | event_missing | lease_lost | parked | retried

	// FanOutSize is deliveries created per event. The p99 is what turns
	// materialised fan-out from cheap into expensive: at 10 subscribers this
	// is free, at 10,000 it is the dominant write on the system.
	FanOutSize = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "router_fan_out_size",
		Help:    "Delivery rows created for one event.",
		Buckets: []float64{0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500},
	})

	// SubscriptionsSkipped explains why a subscription did not receive an
	// event. This is the metric that answers "we configured it, why is nothing
	// arriving" without a database session.
	SubscriptionsSkipped = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "router_subscriptions_skipped_total",
		Help: "Subscriptions considered but not delivered to, by reason.",
	}, []string{"reason"})

	// OutboxParked counts rows removed from the queue without being routed.
	// Every increment is an event that will never be delivered until a human
	// intervenes, so this should alert at any non-zero rate.
	OutboxParked = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "router_outbox_parked_total",
		Help: "Outbox rows parked as failed and removed from the queue, by reason.",
	}, []string{"reason"})

	// RouteDuration is the cost of one event's fan-out transaction: load,
	// match, insert N deliveries, mark the event and the outbox row, commit.
	RouteDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "router_route_duration_seconds",
		Help:    "Duration of one event's fan-out transaction.",
		Buckets: prometheus.ExponentialBuckets(0.001, 2, 14), // 1ms .. ~8s
	})
)
