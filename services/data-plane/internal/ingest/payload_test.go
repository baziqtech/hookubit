package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"testing"
)

type fakePayloadStore struct {
	stored   []byte
	location string
	err      error
	calls    int
}

func (f *fakePayloadStore) Put(_ context.Context, projectID, eventID string, body []byte) (string, error) {
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	f.stored = body
	if f.location == "" {
		f.location = "s3://payloads/" + projectID + "/" + eventID
	}
	return f.location, nil
}

func testLimits() PayloadLimits { return PayloadLimits{InlineMax: 64, Max: 256} }

func TestCheckSizeRejectsOverTheHardCeiling(t *testing.T) {
	l := testLimits()
	if err := l.CheckSize(256); err != nil {
		t.Fatalf("exactly at the maximum must be accepted, got %v", err)
	}
	err := l.CheckSize(257)
	if err == nil {
		t.Fatal("expected a rejection one byte over the maximum")
	}
	if err.Code != CodePayloadTooLarge || err.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %s/%d, want payload_too_large/413", err.Code, err.Status)
	}
}

func TestNeedsOffloadBoundary(t *testing.T) {
	l := testLimits()
	if l.NeedsOffload(63) {
		t.Fatal("below the inline limit must stay inline")
	}
	// At the limit, not above it: "payloads at/over PAYLOAD_INLINE_MAX_BYTES".
	if !l.NeedsOffload(64) {
		t.Fatal("at the inline limit must be offloaded")
	}
	if !l.NeedsOffload(65) {
		t.Fatal("above the inline limit must be offloaded")
	}
}

func TestPlanPayloadInlinesSmallBodiesAndHashesExactBytes(t *testing.T) {
	store := &fakePayloadStore{}
	// Whitespace and key order preserved: the hash is of what arrived, not of a
	// re-encoding.
	body := []byte(`{ "event_type" : "order.created" ,  "data":{"b":1,"a":2}}`)
	plan, err := PlanPayload(context.Background(), store, testLimits(), "proj_1", "evt_1", body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(plan.Inline) != string(body) {
		t.Fatalf("inline payload = %q, want the exact request bytes", plan.Inline)
	}
	if plan.Location != "" {
		t.Fatalf("location = %q, want empty for an inline payload", plan.Location)
	}
	if plan.Size != len(body) {
		t.Fatalf("size = %d, want %d", plan.Size, len(body))
	}
	sum := sha256.Sum256(body)
	if plan.Hash != hex.EncodeToString(sum[:]) {
		t.Fatal("hash is not the SHA-256 of the exact bytes")
	}
	if store.calls != 0 {
		t.Fatal("object storage was called for an inline payload")
	}
}

func TestPlanPayloadOffloadsLargeBodies(t *testing.T) {
	store := &fakePayloadStore{}
	body := []byte(strings.Repeat("x", 100))
	plan, err := PlanPayload(context.Background(), store, testLimits(), "proj_1", "evt_1", body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if plan.Inline != nil {
		t.Fatal("an offloaded payload must not also be stored inline")
	}
	if plan.Location != "s3://payloads/proj_1/evt_1" {
		t.Fatalf("location = %q", plan.Location)
	}
	if plan.Size != 100 {
		t.Fatalf("size = %d, want 100", plan.Size)
	}
	if string(store.stored) != string(body) {
		t.Fatal("object storage did not receive the exact bytes")
	}
	// The hash covers the bytes wherever they ended up, so an offloaded payload
	// is still verifiable at signing time.
	sum := sha256.Sum256(body)
	if plan.Hash != hex.EncodeToString(sum[:]) {
		t.Fatal("hash is not the SHA-256 of the exact bytes")
	}
}

func TestPlanPayloadRejectsOversizedBeforeTouchingStorage(t *testing.T) {
	store := &fakePayloadStore{}
	body := []byte(strings.Repeat("x", 257))
	_, err := PlanPayload(context.Background(), store, testLimits(), "proj_1", "evt_1", body)
	if err == nil || err.Code != CodePayloadTooLarge {
		t.Fatalf("err = %v, want payload_too_large", err)
	}
	if store.calls != 0 {
		t.Fatal("oversized payload was written to object storage before being rejected")
	}
}

// Without a bucket the effective maximum is the inline limit. Saying so is more
// useful than a 500, and does not pretend the event was accepted.
func TestPlanPayloadWithoutObjectStorageIsPayloadTooLarge(t *testing.T) {
	body := []byte(strings.Repeat("x", 100))
	_, err := PlanPayload(context.Background(), NewUnconfiguredPayloadStore(), testLimits(), "proj_1", "evt_1", body)
	if err == nil {
		t.Fatal("expected a rejection")
	}
	if err.Code != CodePayloadTooLarge || err.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %s/%d, want payload_too_large/413", err.Code, err.Status)
	}
}

func TestPlanPayloadStorageFaultIsInternalError(t *testing.T) {
	store := &fakePayloadStore{err: errors.New("s3 timeout")}
	body := []byte(strings.Repeat("x", 100))
	_, err := PlanPayload(context.Background(), store, testLimits(), "proj_1", "evt_1", body)
	if err == nil || err.Code != CodeInternalError {
		t.Fatalf("err = %v, want internal_error", err)
	}
}

func TestHashPayloadOfEmptyBody(t *testing.T) {
	if got := HashPayload(nil); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("HashPayload(nil) = %s", got)
	}
}
