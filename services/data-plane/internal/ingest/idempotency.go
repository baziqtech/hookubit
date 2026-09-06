package ingest

import "time"

// DefaultIdempotencyTTL bounds how long a key is remembered (ARCHITECTURE.md
// 17). Long enough to cover any sane client retry window, short enough that the
// ledger does not grow without limit. Retention sweeps expired rows; ingest
// also takes over an expired row in place, so a client reusing a key a week
// later gets a new event rather than a conflict.
const DefaultIdempotencyTTL = 24 * time.Hour

// IdempotencyRecord is the stored decision for one (project, key) pair.
type IdempotencyRecord struct {
	Key         string
	RequestHash string
	// EventID is empty only if a row was written without one, which the ingest
	// transaction never does - it is treated as an in-flight duplicate rather
	// than assumed to be a replay.
	EventID   string
	ExpiresAt time.Time
}

// Decision is the outcome of comparing a replayed idempotency key against what
// is already stored.
type Decision int

const (
	// DecideProceed: no live record. Create the event.
	DecideProceed Decision = iota
	// DecideReplay: same key, same request body. Return the original event
	// with 202 - a retry must not create a second event.
	DecideReplay
	// DecideConflict: same key, different body. This is a client bug (a key
	// reused across distinct operations) and is reported, never silently
	// aliased to the first request.
	DecideConflict
	// DecideInFlight: the key is claimed but no event ID is recorded yet, so a
	// concurrent request holds it. 409 with a retryable message beats
	// returning an ID that may never commit.
	DecideInFlight
)

// Decide is the whole idempotency rule, kept pure so it is testable without a
// database and readable without one.
//
// `now` is passed rather than read so expiry is deterministic in tests.
func Decide(existing *IdempotencyRecord, requestHash string, now time.Time) Decision {
	if existing == nil {
		return DecideProceed
	}
	if !existing.ExpiresAt.After(now) {
		// Expired records carry no promise; the key may be reused freely.
		return DecideProceed
	}
	if existing.RequestHash != requestHash {
		return DecideConflict
	}
	if existing.EventID == "" {
		return DecideInFlight
	}
	return DecideReplay
}
