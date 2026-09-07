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
