package ingest

import (
	"testing"
	"time"
)

func TestDecideNoRecordProceeds(t *testing.T) {
	if got := Decide(nil, "hash", time.Now()); got != DecideProceed {
		t.Fatalf("decision = %v, want DecideProceed", got)
	}
}

func TestDecideSameKeySameBodyReplays(t *testing.T) {
	now := time.Now()
	rec := &IdempotencyRecord{
		Key:         "order_123_created_v1",
		RequestHash: "abc",
		EventID:     "evt_01",
		ExpiresAt:   now.Add(time.Hour),
	}
	if got := Decide(rec, "abc", now); got != DecideReplay {
		t.Fatalf("decision = %v, want DecideReplay", got)
	}
}

func TestDecideSameKeyDifferentBodyConflicts(t *testing.T) {
	now := time.Now()
	rec := &IdempotencyRecord{
		RequestHash: "abc",
		EventID:     "evt_01",
		ExpiresAt:   now.Add(time.Hour),
	}
	if got := Decide(rec, "def", now); got != DecideConflict {
		t.Fatalf("decision = %v, want DecideConflict", got)
	}
}

// A conflict must win over every other consideration: silently aliasing a
// second, different operation onto the first event is the failure mode this
// whole mechanism exists to prevent.
func TestDecideConflictOutranksMissingEventID(t *testing.T) {
	now := time.Now()
	rec := &IdempotencyRecord{RequestHash: "abc", EventID: "", ExpiresAt: now.Add(time.Hour)}
	if got := Decide(rec, "different", now); got != DecideConflict {
		t.Fatalf("decision = %v, want DecideConflict", got)
	}
}

func TestDecideClaimedButUncommittedIsInFlight(t *testing.T) {
	now := time.Now()
	rec := &IdempotencyRecord{RequestHash: "abc", EventID: "", ExpiresAt: now.Add(time.Hour)}
	if got := Decide(rec, "abc", now); got != DecideInFlight {
		t.Fatalf("decision = %v, want DecideInFlight", got)
	}
}

func TestDecideExpiredRecordProceedsEvenOnADifferentBody(t *testing.T) {
	now := time.Now()
	rec := &IdempotencyRecord{
		RequestHash: "abc",
		EventID:     "evt_01",
		ExpiresAt:   now.Add(-time.Second),
	}
	if got := Decide(rec, "abc", now); got != DecideProceed {
		t.Fatalf("same body, expired: decision = %v, want DecideProceed", got)
	}
	if got := Decide(rec, "def", now); got != DecideProceed {
		t.Fatalf("different body, expired: decision = %v, want DecideProceed", got)
	}
}

// Expiry is exclusive: a record expiring exactly now is already gone, so the
// boundary can never produce a conflict a client cannot recover from.
func TestDecideExpiryBoundaryIsExclusive(t *testing.T) {
	now := time.Now()
	rec := &IdempotencyRecord{RequestHash: "abc", EventID: "evt_01", ExpiresAt: now}
	if got := Decide(rec, "abc", now); got != DecideProceed {
		t.Fatalf("decision = %v, want DecideProceed at the exact expiry instant", got)
	}
	rec.ExpiresAt = now.Add(time.Nanosecond)
	if got := Decide(rec, "abc", now); got != DecideReplay {
		t.Fatalf("decision = %v, want DecideReplay one nanosecond before expiry", got)
	}
}

func TestDefaultIdempotencyTTLIsBounded(t *testing.T) {
	if DefaultIdempotencyTTL <= 0 || DefaultIdempotencyTTL > 7*24*time.Hour {
		t.Fatalf("TTL of %s is not a sane retention window", DefaultIdempotencyTTL)
	}
}
