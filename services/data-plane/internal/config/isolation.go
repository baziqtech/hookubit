package config

import (
	"errors"
	"fmt"
)

// This file holds the two configuration relationships that decide whether a
// promise the architecture makes is actually kept, and that nothing else in the
// product states, enforces or surfaces.

// IsolationEndpointFloor is how many endpoints, each sitting at
// MAX_CONCURRENCY_PER_ENDPOINT, it should take to fill the worker pool before
// the arithmetic stops being worth warning about.
//
// It is a judgement, not a measurement, and eight is the judgement: below that,
// isolation depends on fewer than eight endpoints behaving at once, which on a
// multi-tenant platform is not isolation, it is luck. No single value is right
// for every deployment - which is exactly why this produces a warning and
// nothing in this file refuses to start.
const IsolationEndpointFloor = 8

// Advisory is a startup warning: something an operator should know and act on,
// which is nonetheless not grounds to refuse to start.
//
// Fields are slog key/value pairs, so the caller logs it as
// log.Warn(a.Message, a.Fields...) and the arithmetic lands in the structured
// record rather than only in a sentence.
type Advisory struct {
	Message string
	Fields  []any
}

// ConcurrencyAdvisories reports where the configured ceilings cannot honour the
// isolation the architecture claims from them.
//
// ARCHITECTURE.md 24 says the concurrency ceilings exist to prevent noisy
// neighbours, and its acceptance list says flatly "One tenant cannot starve
// others." endpoints.max_concurrency bounds what ONE endpoint may hold; nothing
// RESERVES capacity for anyone else. The sentence is therefore true only while
//
//	sum(max_concurrency of endpoints that can be slow)  <  WORKER_CONCURRENCY
//
// and until this function existed that rule was stated nowhere, enforced
// nowhere and visible in no metric. It is measured, not theorised:
// docs/LOAD_TESTING.md 7 has the scenario failing at 12,660 ms with caps
// summing to 96 against a pool of 64, and passing at 1,782 ms with caps
// summing to 24.
//
// WARNINGS, NOT REFUSALS, deliberately. The failure this describes is slow
// webhooks for some tenants; refusing to start is no webhooks for all of them,
// which is strictly worse than the starvation it would be protecting against.
// An operator is also entitled to run over-provisioned on purpose - a
// deployment whose endpoints are all fast has nothing to isolate from. So the
// message carries the arithmetic and the remedy, and the decision stays with
// the person who can see the traffic.
//
// The remaining fix, a reserved share of the pool that slow endpoints cannot
// cross, is a design change rather than a patch and is deliberately not
// attempted here: without the occupancy data these warnings and the
// concurrency_gate_* gauges produce, any reservation number would be a guess.
func (c *Config) ConcurrencyAdvisories() []Advisory {
	var out []Advisory
	if c.WorkerConcurrency <= 0 || c.MaxConcurrencyEndpoint <= 0 {
		// Load already refuses a non-positive WORKER_CONCURRENCY; there is
		// nothing to divide by and nothing useful to say.
		return nil
	}

	// How many endpoints at the ceiling it takes to hold every slot in the
	// pool. This is the whole of G13 in one integer.
	toFillPool := c.WorkerConcurrency / c.MaxConcurrencyEndpoint
	if toFillPool < IsolationEndpointFloor {
		out = append(out, Advisory{
			Message: "per-endpoint concurrency is a CEILING, not a reservation: a small number of slow endpoints can hold the whole delivery pool and fast endpoints will queue behind them",
			Fields: []any{
				"endpoints_to_fill_the_pool", toFillPool,
				"max_concurrency_per_endpoint", c.MaxConcurrencyEndpoint,
				"worker_concurrency", c.WorkerConcurrency,
				"arithmetic", fmt.Sprintf("%d endpoints x MAX_CONCURRENCY_PER_ENDPOINT=%d >= WORKER_CONCURRENCY=%d",
					toFillPool, c.MaxConcurrencyEndpoint, c.WorkerConcurrency),
				"rule", "isolation holds only while sum(max_concurrency of endpoints that can be slow) < WORKER_CONCURRENCY",
				"remedy", "lower MAX_CONCURRENCY_PER_ENDPOINT, raise WORKER_CONCURRENCY, or add worker replicas",
				"observe", "concurrency_gate_slots_in_use, concurrency_gate_busiest_key_slots and worker_pool_slots_in_use",
			},
		})
	}

	// Every ceiling at or above the pool size is a ceiling that can never
	// refuse anything: the pool runs out first. Reported as one advisory
	// because it is one fact - a knob that reads like the process ceiling and
	// is not - and because three near-identical warnings at startup is how
	// operators learn to skim them.
	var inert []any
	if c.MaxConcurrencyGlobal >= c.WorkerConcurrency {
		inert = append(inert, "max_concurrency_global", c.MaxConcurrencyGlobal)
	}
	if c.MaxConcurrencyPerOrg >= c.WorkerConcurrency {
		inert = append(inert, "max_concurrency_per_org", c.MaxConcurrencyPerOrg)
	}
	if c.MaxConcurrencyProject >= c.WorkerConcurrency {
		inert = append(inert, "max_concurrency_per_project", c.MaxConcurrencyProject)
	}
	if len(inert) > 0 {
		out = append(out, Advisory{
			Message: "concurrency ceilings at or above WORKER_CONCURRENCY cannot bind; the worker pool is the real per-process ceiling on in-flight attempts",
			Fields: append(inert,
				"worker_concurrency", c.WorkerConcurrency,
				"effective_ceiling", c.WorkerConcurrency,
				"effect", "one tenant at the listed ceiling is entitled to the entire pool",
			),
		})
	}
	return out
}

// ValidateDeliveryRateLimitScope refuses a PRODUCTION worker whose endpoint
// delivery rate limits would silently be per-replica.
//
// With no REDIS_URL the worker falls back to its in-process token bucket, so a
// customer's configured limit of N is enforced N x (worker replicas) times over
// - and the number they actually get changes whenever the Deployment is scaled.
// That is a customer-visible guarantee quietly weaker than the one the control
// plane accepted, which is the same class of problem as
// EGRESS_ALLOW_PRIVATE_NETWORKS, and it gets the same treatment: refused in
// production, allowed anywhere else, with an explicit acknowledgement available
// for an operator who means it.
//
// This gates CONFIGURATION, never the runtime. Delivery must never depend on
// Redis being up and does not: the limiter fails open, the in-process bucket is
// the fallback, and the import guard in internal/failure/outage asserts the
// delivery path cannot even reach a Redis client. A Redis that is configured
// and then dies costs the fleet-wide scope and nothing else; this only refuses
// a Redis that was never configured at all.
func (c *Config) ValidateDeliveryRateLimitScope() error {
	if c.RedisURL != "" || c.DeliveryRateLimitAllowPerReplica || c.AppEnv != "production" {
		return nil
	}
	return errors.New(
		"REDIS_URL is not set, so endpoint delivery rate limits would be enforced PER WORKER REPLICA: " +
			"a customer's configured limit of N becomes N x the worker replica count, and changes when the " +
			"Deployment is scaled. Set REDIS_URL, or set DELIVERY_RATE_LIMIT_ALLOW_PER_REPLICA=true to take " +
			"per-replica limits deliberately")
}
