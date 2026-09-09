package worker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/payloadstore"
)

// fakeFetcher stands in for object storage on the delivery path.
type fakeFetcher struct {
	mu        sync.Mutex
	objects   map[string][]byte
	err       error
	locations []string
}

func newFakeFetcher() *fakeFetcher { return &fakeFetcher{objects: map[string][]byte{}} }

func (f *fakeFetcher) Get(_ context.Context, location string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.locations = append(f.locations, location)
	if f.err != nil {
		return nil, f.err
	}
	body, ok := f.objects[location]
	if !ok {
		return nil, fmt.Errorf("%w: %s", payloadstore.ErrObjectNotFound, location)
	}
	return body, nil
}

func withFetcher(f PayloadFetcher) func(*Options) {
	return func(o *Options) { o.Payloads = f }
}

// The load-bearing case: an offloaded payload is fetched and the EXACT bytes
// that came out of object storage are what gets signed and sent. Not a
// re-encoding, not the jsonb projection.
func TestOffloadedPayloadIsFetchedAndDeliveredByteForByte(t *testing.T) {
	// Whitespace, key order and a duplicate-ish shape that jsonb would
	// normalise. If anything in the path re-serialises, this body changes.
	stored := []byte(`{ "b" : 1 ,   "a":2, "nested":{"z":[3,2,1]} }`)

	var (
		mu      sync.Mutex
		gotBody []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(buf)
		mu.Lock()
		gotBody = buf
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	fetcher := newFakeFetcher()
	const location = "s3://webhook-payloads/events/proj_01TEST/evt_01TEST"
	fetcher.objects[location] = stored

	h := newHarness(t, srv.URL, withFetcher(fetcher))
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = location
	h.store.job.PayloadHash = ingest.HashPayload(stored)
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateSucceeded {
		t.Fatalf("state = %s (%s), want succeeded", got.Next.State, got.Next.Reason)
	}
	mu.Lock()
	defer mu.Unlock()
	if string(gotBody) != string(stored) {
		t.Fatalf("delivered %q, want the exact stored bytes %q", gotBody, stored)
	}
}

// Object storage down at delivery time: DEFER. No attempt row, no failure, no
// retry-budget spend. The endpoint is fine; we are not.
func TestObjectStorageUnavailableDefersWithoutBurningAnAttempt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a delivery whose payload could not be fetched was sent anyway")
	}))
	defer srv.Close()

	fetcher := newFakeFetcher()
	fetcher.err = fmt.Errorf("%w: connection refused", payloadstore.ErrUnavailable)

	h := newHarness(t, srv.URL, withFetcher(fetcher))
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = "s3://webhook-payloads/events/proj_01TEST/evt_01TEST"
	h.worker.handle(context.Background(), h.lease())

	completions, defers := h.store.counts()
	if completions != 0 {
		t.Fatalf("completions = %d; an outage of OURS must not record an attempt or a terminal state", completions)
	}
	if defers != 1 {
		t.Fatalf("defers = %d, want 1", defers)
	}
	got := h.store.lastDefer(t)
	if got.State != StateScheduled {
		t.Fatalf("state = %s, want scheduled", got.State)
	}
	if got.Reason != ReasonPayloadUnavailable {
		t.Fatalf("reason = %s, want %s", got.Reason, ReasonPayloadUnavailable)
	}
	if got.AttemptCount != 0 {
		t.Fatalf("attempt_count = %d; a deferral must not charge the retry budget", got.AttemptCount)
	}
}

// No object-storage client configured at all, but rows reference one. Same
// treatment: it is a misconfiguration on our side, recoverable, so defer.
func TestNoPayloadFetcherConfiguredDefers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a delivery with an unreadable payload_location was sent anyway")
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = "s3://webhook-payloads/events/proj_01TEST/evt_01TEST"
	h.worker.handle(context.Background(), h.lease())

	if completions, _ := h.store.counts(); completions != 0 {
		t.Fatalf("completions = %d, want 0", completions)
	}
	if got := h.store.lastDefer(t); got.Reason != ReasonPayloadUnavailable {
		t.Fatalf("reason = %s, want %s", got.Reason, ReasonPayloadUnavailable)
	}
}

// The object is gone: expired, swept, or never written. That is a definitive,
// terminal failure with its OWN reason - it must never read as though the
// customer's endpoint rejected the delivery.
func TestMissingObjectFailsTerminallyWithItsOwnReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a delivery whose payload object is missing was sent anyway")
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL, withFetcher(newFakeFetcher())) // empty bucket
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = "s3://webhook-payloads/events/proj_01TEST/evt_01TEST"
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateFailed {
		t.Fatalf("state = %s, want failed: a missing object cannot be conjured back by a retry", got.Next.State)
	}
	if got.Next.Reason != ReasonPayloadGone {
		t.Fatalf("reason = %s, want %s", got.Next.Reason, ReasonPayloadGone)
	}
	if got.Attempt == nil {
		t.Fatal("a definitive payload failure must still leave an attempt row")
	}
	if got.Attempt.ErrorCode != "payload_object_missing" {
		t.Fatalf("error code = %q, want payload_object_missing", got.Attempt.ErrorCode)
	}
	if got.Attempt.HTTPStatus != 0 {
		t.Fatalf("http_status = %d; nothing was sent, so the ledger must not imply the endpoint answered", got.Attempt.HTTPStatus)
	}
}

// THE regression test for the bug this project has already had once: bytes that
// do not hash to events.payload_hash are never signed and never sent.
func TestPayloadThatDoesNotMatchTheStoredHashIsRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a payload that does not match events.payload_hash was signed and sent")
	}))
	defer srv.Close()

	original := []byte(`{ "b" : 1 ,  "a":2}`)
	// What jsonb would give back: same JSON, different bytes.
	normalised := []byte(`{"a": 2, "b": 1}`)

	fetcher := newFakeFetcher()
	const location = "s3://webhook-payloads/events/proj_01TEST/evt_01TEST"
	fetcher.objects[location] = normalised

	h := newHarness(t, srv.URL, withFetcher(fetcher))
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = location
	h.store.job.PayloadHash = ingest.HashPayload(original)
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateFailed {
		t.Fatalf("state = %s, want failed", got.Next.State)
	}
	if got.Next.Reason != ReasonPayloadCorrupt {
		t.Fatalf("reason = %s, want %s", got.Next.Reason, ReasonPayloadCorrupt)
	}
	if got.Attempt.ErrorCode != "payload_hash_mismatch" {
		t.Fatalf("error code = %q, want payload_hash_mismatch", got.Attempt.ErrorCode)
	}
}

// An inline payload is verified against the same hash by the same code path, so
// the two storage routes give identical guarantees.
func TestInlinePayloadIsAlsoVerifiedAgainstTheStoredHash(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a mismatched inline payload was sent")
	}))
	defer srv.Close()

	h := newHarness(t, srv.URL)
	h.store.job.PayloadHash = ingest.HashPayload([]byte(`{"something":"else"}`))
	h.worker.handle(context.Background(), h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.Reason != ReasonPayloadCorrupt {
		t.Fatalf("reason = %s, want %s", got.Next.Reason, ReasonPayloadCorrupt)
	}
}

// A row from before payload_hash was populated must still deliver. Refusing
// would turn a missing column into an outage.
func TestEmptyStoredHashSkipsVerification(t *testing.T) {
	if err := verifyPayload([]byte(`{"a":1}`), ""); err != nil {
		t.Fatalf("an empty payload_hash must not fail verification: %v", err)
	}
}

func TestPayloadSentinelsAreClassifiedPermanent(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"gone", fmt.Errorf("%w: wrapped", ErrPayloadGone)},
		{"corrupt", fmt.Errorf("%w: wrapped", ErrPayloadCorrupt)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var permanent interface{ PermanentDeliveryError() bool }
			if !errors.As(tc.err, &permanent) || !permanent.PermanentDeliveryError() {
				t.Fatal("the retry classifier would retry this forever; it can never succeed")
			}
		})
	}
}
