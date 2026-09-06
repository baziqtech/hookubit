// Package metrics declares the platform's Prometheus instruments
// (ARCHITECTURE.md 44).
//
// No metric here is labelled with an event, delivery or endpoint ID. Those are
// unbounded in cardinality and would take the metrics backend down long before
// they answered anything useful; per-entity questions belong in the delivery
// log, which is what the operator UI queries.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	EventsIngested = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "events_ingested_total",
		Help: "Events durably accepted by the ingest API.",
	}, []string{"project_environment"})

	EventsIngestionFailed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "events_ingestion_failed_total",
		Help: "Ingest requests rejected, by reason.",
	}, []string{"reason"})

	DeliveriesCreated = promauto.NewCounter(prometheus.CounterOpts{
		Name: "deliveries_created_total",
		Help: "Delivery rows materialised by the router.",
	})

	DeliveriesCompleted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "deliveries_completed_total",
		Help: "Deliveries reaching a terminal state, by outcome.",
	}, []string{"outcome"}) // succeeded | failed | exhausted | cancelled

	DeliveriesRetried = promauto.NewCounter(prometheus.CounterOpts{
		Name: "deliveries_retried_total",
		Help: "Delivery attempts scheduled as retries.",
	})

	DeliveryLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "delivery_latency_seconds",
		Help:    "Event acceptance to first successful delivery.",
		Buckets: prometheus.ExponentialBuckets(0.05, 2, 14),
	})

	AttemptLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "delivery_attempt_latency_seconds",
		Help:    "Duration of a single outbound HTTP attempt.",
		Buckets: prometheus.ExponentialBuckets(0.01, 2, 14),
	}, []string{"outcome"})

	HTTPResponses = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "egress_http_responses_total",
		Help: "Outbound responses bucketed by status class.",
	}, []string{"class"}) // 2xx | 3xx | 4xx | 5xx | error

	QueueDepth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "queue_depth",
		Help: "Deliveries awaiting work, by state.",
	}, []string{"state"})

	WorkersActive = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "worker_active_count",
		Help: "Delivery attempts currently in flight in this process.",
	})

	RateLimitHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "rate_limit_hits_total",
		Help: "Requests or deliveries deferred by a rate limit, by scope.",
	}, []string{"scope"})

	CircuitBreakerOpened = promauto.NewCounter(prometheus.CounterOpts{
		Name: "circuit_breaker_open_total",
		Help: "Transitions of an endpoint breaker into the open state.",
	})

	EgressBlocked = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "egress_blocked_total",
		Help: "Destinations refused by the SSRF guard, by reason.",
	}, []string{"reason"})

	OutboxLag = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "outbox_pending_age_seconds",
		Help: "Age of the oldest unprocessed outbox row. Sustained growth means the router is not keeping up.",
	})

	// --- Claim path (ADR-0007) -------------------------------------------
	//
	// The `strategy` label is bounded to the values of queue.Strategy, so it
	// stays low cardinality. Nothing below is labelled by organisation,
	// project, endpoint, event or delivery: a per-tenant label grows with the
	// customer list, which is exactly the cardinality trap this package's
	// header warns about. Per-tenant fairness questions are answered from the
	// delivery log, not from Prometheus.

	// QueueHeadOfLineDelay is THE fairness SLI. It is how long a delivery sat
	// ready before any worker claimed it - scheduling delay only, measured by
	// the database at claim time, excluding the attempt itself.
	//
	// This is the number that decides whether the tenant-fair claim strategy
	// gets promoted from opt-in to default: FIFO starves small tenants behind a
	// large one's burst, and starvation shows up here as a p99 that tracks the
	// burst's drain time while p50 stays flat.
	QueueHeadOfLineDelay = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "queue_head_of_line_delay_seconds",
		Help:    "Time a delivery was ready before a worker claimed it. Scheduling delay only; excludes the attempt.",
		Buckets: prometheus.ExponentialBuckets(0.01, 3, 12), // 10ms .. ~15h
	})

	// QueueClaimDuration is the cost of the claim statement itself. ADR-0007
	// requires the tenant-fair plan to be measurably no worse than FIFO in the
	// single-tenant case, and this is the measurement.
	QueueClaimDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "queue_claim_duration_seconds",
		Help:    "Duration of one claim round trip, by claim strategy.",
		Buckets: prometheus.ExponentialBuckets(0.0005, 2, 14), // 0.5ms .. ~4s
	}, []string{"strategy"}) // fifo | tenant_fair

	// QueueClaimBatchSize is how many deliveries a claim actually returned.
	// Persistently hitting the limit means the pool is saturated; persistently
	// returning zero means the poll interval is the bottleneck, not the query.
	QueueClaimBatchSize = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "queue_claim_batch_size",
		Help:    "Deliveries returned by one claim, by claim strategy.",
		Buckets: []float64{0, 1, 2, 5, 10, 25, 50, 100, 200, 500},
	}, []string{"strategy"})

	// QueueClaimTenants is K: the number of distinct tenants a claim drew
	// from. Zero for a FIFO claim. Read alongside the batch size it gives the
	// derived per-tenant cap, which is the knob ADR-0007 says must never
	// become a constant.
	QueueClaimTenants = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "queue_claim_tenants",
		Help:    "Distinct tenants drawn from by one tenant-fair claim (0 for a FIFO claim).",
		Buckets: []float64{0, 1, 2, 4, 8, 16, 32, 64, 128, 256},
	})

	// LeasesReclaimed counts deliveries recovered from an expired lease by the
	// scheduler sweep. Sustained non-zero means workers are dying mid-attempt
	// or the lease is shorter than the attempt timeout.
	LeasesReclaimed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "queue_leases_reclaimed_total",
		Help: "Deliveries returned to the ready set because their lease expired.",
	})

	// LeasesLost counts leases a worker discovered it no longer held, at renew
	// or release time. Every increment is an attempt abandoned to avoid a
	// duplicate delivery - and a signal that the lease duration is too short
	// for the attempt timeout, or that the database is stalling renewals.
	LeasesLost = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "queue_leases_lost_total",
		Help: "Leases found to be no longer held by this worker, by the operation that discovered it.",
	}, []string{"operation"}) // renew | release
)
