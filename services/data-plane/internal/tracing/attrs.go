package tracing

import (
	"strings"

	"go.opentelemetry.io/otel/attribute"
)

// Span attribute keys.
//
// WHAT MAY NEVER APPEAR HERE, and why the list is short:
//
//   - Payload bodies, request bodies and response bodies. They are the
//     customer's data, they are unbounded, and the delivery ledger already
//     stores a bounded, redacted copy for the one question they answer.
//   - Signing secrets, API keys, key ids and encryption envelopes. Obvious, and
//     the reason internal/logging redacts by key name too.
//   - Request or response HEADERS. The outbound set carries the signature; the
//     endpoint's custom headers are operator-supplied and routinely carry a
//     bearer token.
//   - FULL ENDPOINT URLS. A customer's endpoint URL can carry a token in its
//     query string - this is exactly why internal/worker logs hostOf(url) and
//     not url. Spans get the host and nothing else, through EndpointHost below.
//   - Idempotency keys. Customer-chosen, and routinely a customer's own order
//     or invoice identifier.
//
// Identifiers (event, delivery, endpoint, project, organisation) ARE here. They
// are opaque ULIDs, they are the only way to find a trace from the operator UI,
// and unlike the Prometheus label sets in internal/metrics a span attribute has
// no cardinality cost.
const (
	AttrEventID        = attribute.Key("webhook.event.id")
	AttrEventType      = attribute.Key("webhook.event.type")
	AttrDeliveryID     = attribute.Key("webhook.delivery.id")
	AttrEndpointID     = attribute.Key("webhook.endpoint.id")
	AttrSubscriptionID = attribute.Key("webhook.subscription.id")
	AttrProjectID      = attribute.Key("webhook.project.id")
	AttrOrganizationID = attribute.Key("webhook.organization.id")
	AttrOutboxID       = attribute.Key("webhook.outbox.id")

	AttrAttempt        = attribute.Key("webhook.delivery.attempt")
	AttrMaxAttempts    = attribute.Key("webhook.delivery.max_attempts")
	AttrDeliveryState  = attribute.Key("webhook.delivery.state")
	AttrDeliveryReason = attribute.Key("webhook.delivery.reason")
	AttrErrorCode      = attribute.Key("webhook.delivery.error_code")
	AttrOutcome        = attribute.Key("webhook.outcome")
	AttrDeliveriesMade = attribute.Key("webhook.fan_out.deliveries_created")
	AttrFanOutPlanned  = attribute.Key("webhook.fan_out.planned")
	AttrPayloadBytes   = attribute.Key("webhook.payload.bytes")
	AttrPayloadStored  = attribute.Key("webhook.payload.offloaded")
	AttrEventAgeMS     = attribute.Key("webhook.event.age_ms")

	// Standard-ish HTTP and network keys, kept as raw strings for the same
	// reason buildResource does: pinning a semconv version turns a dependency
	// bump into a rename of every attribute.
	AttrHTTPMethod     = attribute.Key("http.request.method")
	AttrHTTPStatus     = attribute.Key("http.response.status_code")
	AttrHTTPRoute      = attribute.Key("http.route")
	AttrServerAddress  = attribute.Key("server.address")
	AttrErrorType      = attribute.Key("error.type")
	AttrRequestID      = attribute.Key("webhook.request.id")
	AttrResponseStatus = attribute.Key("webhook.response.code")

	// AttrSampleIn is read by the Sampler in sampler.go. Its VALUE is the
	// reason, so a span that was kept against the odds says why it was kept -
	// which is the difference between a trace an operator trusts and a trace
	// they suspect is a coincidence. See sampler.go for the whole argument.
	AttrSampleIn = attribute.Key("webhook.trace.sample_in")
)

// Reasons carried by AttrSampleIn.
const (
	// SampleInUpstream: the stored trace context says the stage before this one
	// was sampled, so keeping this one completes a story we have already paid
	// to record.
	SampleInUpstream = "upstream_sampled"
	// SampleInRetry: this is not the first attempt. Retries are rare relative
	// to first attempts and are the only ones anybody asks about.
	SampleInRetry = "retry"
	// SampleInRecovery: the row is being re-processed after a failure the
	// platform recorded (an outbox release, a reclaim).
	SampleInRecovery = "recovery"
)

// EndpointHost reduces a customer's endpoint URL to its host, which is the most
// that may ever reach a span.
//
// It is the same reduction internal/worker.hostOf performs for logs, duplicated
// deliberately rather than exported from there: the worker's copy is on the
// delivery path and this one is on the telemetry path, and a future change to
// either must not silently change the other.
func EndpointHost(raw string) string {
	if i := strings.Index(raw, "://"); i >= 0 {
		raw = raw[i+3:]
	}
	if i := strings.IndexAny(raw, "/?#"); i >= 0 {
		raw = raw[:i]
	}
	// Credentials in the authority (https://user:pass@host/) are rare and
	// wrong, but they are not ours to leak into a telemetry backend.
	if i := strings.LastIndex(raw, "@"); i >= 0 {
		raw = raw[i+1:]
	}
	return raw
}
