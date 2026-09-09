package worker

import "errors"

// ErrNoPayload means events.payload_raw held nothing to sign or send.
//
// payload_raw is authoritative: the jsonb `payload` column is a queryable
// projection that PostgreSQL normalises (key order, whitespace, duplicate
// keys), so bytes read back from it are NOT the bytes the customer sent and
// every signature computed over them would fail at the consumer. There is
// deliberately no fallback to it - failing the delivery is correct and
// debuggable; delivering an unverifiable payload is neither.
var ErrNoPayload = errors.New("worker: event has no raw payload bytes")

// ErrSigning wraps any failure to produce the signature header. Signing fails
// CLOSED: an endpoint momentarily holding zero active secrets fails its
// delivery rather than shipping it unsigned, because a header with no v1
// component is rejected by every correct consumer anyway.
var ErrSigning = errors.New("worker: cannot sign delivery")

// ErrDeferred is not a failure. It reports that the delivery was put back
// without an attempt being made - the breaker is open, a rate limit or a
// concurrency ceiling said no - so no attempt row is written and no attempt is
// burned from the retry budget.
var ErrDeferred = errors.New("worker: delivery deferred")

// ErrPayloadGone means events.payload_location points at an object that
// definitively does not exist - expired, swept, or never successfully written.
//
// It is PERMANENT on purpose. There is nothing to retry: no future attempt will
// find bytes that are not there, and spending a 24h retry budget proving it
// only delays the moment an operator sees the problem. It implements
// retry.IsPermanentError so the ordinary decision path reaches `failed` without
// a special case, and the delivery is reasoned `payload_gone` so it can never
// be mistaken for the customer's endpoint rejecting the request.
var ErrPayloadGone error = &permanentPayloadError{"worker: the stored payload object no longer exists"}

// ErrPayloadCorrupt means bytes came back but they are not the bytes the
// customer sent: SHA-256 of what was read does not equal events.payload_hash.
//
// Also permanent, and for a sharper reason - signing and delivering those bytes
// would produce a webhook the consumer cannot verify, and the platform would
// have laundered a corruption into a signature. Refusing is the only honest
// outcome.
var ErrPayloadCorrupt error = &permanentPayloadError{"worker: stored payload does not match events.payload_hash"}

// ErrPayloadStoreUnavailable means object storage did not answer. The endpoint
// is fine; WE are the problem.
//
// It is deliberately NOT a delivery failure. The delivery is deferred and
// retried without an attempt row and without charging the retry budget, exactly
// as an open circuit breaker or a concurrency ceiling does - burning attempts
// on our own outage would exhaust deliveries that were always deliverable.
var ErrPayloadStoreUnavailable = errors.New("worker: object storage is unavailable")

// permanentPayloadError makes the two sentinels above structurally permanent,
// using the same marker interface internal/retry uses for egress errors so
// neither package has to import the other. A caller that wraps one with
// fmt.Errorf("%w: ...") keeps the marker: errors.As walks the wrap chain.
type permanentPayloadError struct{ msg string }

func (e *permanentPayloadError) Error() string { return e.msg }

func (*permanentPayloadError) PermanentDeliveryError() bool { return true }
