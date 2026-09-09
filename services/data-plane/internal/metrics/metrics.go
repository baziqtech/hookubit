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
	}, []string{"scope"}) // source_ip | ingest | project | organization | endpoint

	// RateLimiterDegraded is THE alert for the limiter.
	//
	// The limiter fails open by design (ARCHITECTURE.md 14), so a Redis outage
	// costs no traffic and produces no errors - which means nothing else in the
	// system would ever tell an operator that fleet-wide ceilings have silently
	// become per-replica ones. Any sustained non-zero rate here means the
	// configured limits are not the limits in force.
	RateLimiterDegraded = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "rate_limiter_degraded_total",
		Help: "Rate limit decisions taken without the shared store, by cause. Limits are per replica while this is non-zero.",
	}, []string{"cause"}) // redis | policy_lookup

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

	// PayloadOffloads counts events whose payload went to object storage
	// instead of inline into PostgreSQL, by outcome. A rising `error` is an
	// ingest outage in the making: an offload that fails is a 500, never a 202.
	PayloadOffloads = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "payload_offloads_total",
		Help: "Payloads written to object storage at ingest, by outcome.",
	}, []string{"outcome"}) // stored | error

	// PayloadFetches counts reads of an offloaded payload on the delivery
	// path. `missing` means the object is gone and the delivery failed
	// distinctly; `unavailable` means the bucket did not answer and the
	// delivery was DEFERRED without burning an attempt.
	PayloadFetches = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "payload_fetches_total",
		Help: "Reads of an offloaded payload on the delivery path, by outcome.",
	}, []string{"outcome"}) // fetched | missing | unavailable | corrupt

	// PayloadOrphans counts objects uploaded by a request that then wrote no
	// events row. `deleted` is the compensating delete succeeding in-request;
	// `leaked` is one left for the sweep; `swept` is one the sweep reclaimed.
	PayloadOrphans = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "payload_orphan_objects_total",
		Help: "Unreferenced payload objects, by how they were dealt with.",
	}, []string{"outcome"}) // deleted | leaked | swept
)

// --- Concurrency occupancy (G13) -----------------------------------------
//
// rate_limit_hits_total{scope="endpoint_concurrency"} counts REFUSALS. It says
// that something was turned away; it cannot say what was holding the capacity,
// and the whole difficulty of G13 is that the symptom (one tenant's webhooks
// are slow) points nowhere near the cause (a different tenant's endpoints are
// sitting on the pool). These gauges are the occupancy behind that counter.
//
// CARDINALITY. None of them is labelled by endpoint, project or organisation
// id, and none of them may become so. A label whose value set grows with the
// customer list is an outage of its own on a busy platform, and this package's
// header says so. The per-key question - WHICH endpoint is holding the slots -
// is answered by concurrency_gate_busiest_key_slots, which is the largest
// single key's holding with the key itself left out: enough to see one endpoint
// eating the pool, not enough to build a series per customer. The identity of
// that endpoint is a log and a delivery-log query, deliberately.
//
// The `scope` label is the four gate ceilings, matching the values
// rate_limit_hits_total already uses for the tenant gate (global, organization,
// project) plus `endpoint`, which that counter spells `endpoint_concurrency`
// because it shares a metric with the endpoint RATE limit. Joining the two on
// scope therefore needs that one rename; it is not worth changing a shipped
// counter's label value to avoid.
var (
	// WorkerPoolSlotsInUse and WorkerPoolSlotsCapacity are the REAL ceiling on
	// in-flight attempts in this process: the worker pool. At the shipped
	// defaults MAX_CONCURRENCY_GLOBAL (512) sits eight times above
	// WORKER_CONCURRENCY (64), so the gate that reads as the process ceiling
	// can never bind and this pair is the one to alarm on.
	WorkerPoolSlotsInUse = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "worker_pool_slots_in_use",
		Help: "Worker pool slots held by claimed deliveries in this process.",
	})

	WorkerPoolSlotsCapacity = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "worker_pool_slots_capacity",
		Help: "Worker pool size (WORKER_CONCURRENCY) in this process.",
	})

	// GateSlotsInUse is the sum of the slots held at one scope. For the keyed
	// scopes it is a sum ACROSS keys, so it can exceed GateSlotsCapacity, which
	// is a PER-KEY ceiling - that is not a bug, it is the shape of the gate.
	GateSlotsInUse = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "concurrency_gate_slots_in_use",
		Help: "Concurrency gate slots currently held, summed across keys, by scope.",
	}, []string{"scope"}) // global | organization | project | endpoint

	// GateSlotsCapacity is the configured ceiling: process-wide for `global`,
	// per key for the rest (MAX_CONCURRENCY_PER_ORG / _PER_PROJECT /
	// _PER_ENDPOINT). It is published so a dashboard can show occupancy against
	// the limit without an operator having to know the deployment's env.
	GateSlotsCapacity = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "concurrency_gate_slots_capacity",
		Help: "Configured concurrency ceiling by scope: process-wide for global, per key otherwise.",
	}, []string{"scope"})

	// GateKeysActive is how many distinct organisations / projects / endpoints
	// hold capacity right now. Read against WorkerPoolSlotsInUse it answers the
	// question G13 exists for: are the pool's slots spread across many
	// endpoints, or concentrated in a handful?
	GateKeysActive = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "concurrency_gate_keys_active",
		Help: "Distinct keys holding capacity at this scope (0 for the unkeyed global scope).",
	}, []string{"scope"})

	// GateBusiestKeySlots is the largest single key's holding at this scope -
	// the concentration signal, without a per-tenant label. One endpoint at
	// MAX_CONCURRENCY_PER_ENDPOINT against a small pool is the measured G13
	// failure, and this is the series that shows it.
	GateBusiestKeySlots = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "concurrency_gate_busiest_key_slots",
		Help: "Slots held by the single busiest key at this scope. Concentration signal; the key itself is deliberately not a label.",
	}, []string{"scope"})

	// DeliveryRateLimitFleetWide is 1 when endpoints.rate_limit is charged
	// against a shared store and 0 when it is charged per replica (G17). Zero
	// means every customer's configured limit is multiplied by the worker
	// replica count, which is a customer-visible guarantee quietly weaker than
	// the one the control plane accepted.
	//
	// Distinct from rate_limiter_degraded_total, which counts a shared store
	// that was configured and then failed. This one says it was never
	// configured, so that counter will sit at a confident zero.
	DeliveryRateLimitFleetWide = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "delivery_rate_limit_fleet_wide",
		Help: "1 when endpoint delivery rate limits are enforced fleet-wide, 0 when they are per replica.",
	})
)
