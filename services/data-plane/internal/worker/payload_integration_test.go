package worker

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
	"github.com/shaq/hookubit/services/data-plane/internal/payloadstore"
	"github.com/shaq/hookubit/services/data-plane/internal/signing"
)

// requireLivePayloadStore gates on a real S3-compatible endpoint, exactly as
// the payloadstore and ratelimit live tests do.
func requireLivePayloadStore(t *testing.T) *payloadstore.Store {
	t.Helper()
	endpoint := env("S3_TEST_ENDPOINT", "S3_ENDPOINT")
	bucket := env("S3_TEST_BUCKET", "S3_BUCKET")
	if endpoint == "" || bucket == "" {
		t.Skip("S3_TEST_ENDPOINT/S3_TEST_BUCKET are not set; skipping the live object storage delivery test")
	}
	store, err := payloadstore.New(context.Background(), payloadstore.Config{
		Endpoint:       endpoint,
		Bucket:         bucket,
		Region:         "us-east-1",
		AccessKey:      env("S3_TEST_ACCESS_KEY", "S3_ACCESS_KEY"),
		SecretKey:      env("S3_TEST_SECRET_KEY", "S3_SECRET_KEY"),
		ForcePathStyle: true,
		Prefix:         "test-" + ids.New("run"),
		MaxObjectBytes: 1 << 20,
	})
	if err != nil {
		t.Fatalf("build payload store: %v", err)
	}
	return store
}

func env(names ...string) string {
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	return ""
}

// The two halves, joined, against a real bucket: ingest's PlanPayload writes the
// object and computes events.payload_hash; the worker's delivery path reads it
// back, verifies it and signs it; the endpoint receives it.
//
// Three assertions, and they are the whole reason this test exists:
//
//  1. the body the endpoint receives is byte-identical to what ingest was given;
//  2. it hashes to the value that would be in events.payload_hash;
//  3. the signature on the wire verifies AGAINST THOSE BYTES - which is what a
//     consumer will actually do, and what silently stopped being true the last
//     time something in this path re-encoded a payload.
func TestLiveOffloadedPayloadIsDeliveredAndSignedOverTheStoredBytes(t *testing.T) {
	store := requireLivePayloadStore(t)
	ctx := context.Background()

	var (
		mu      sync.Mutex
		gotBody []byte
		gotHdrs http.Header
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotBody = body
		gotHdrs = r.Header.Clone()
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Whitespace and key order that a jsonb round trip would not survive.
	body := []byte("{  \"z\":1,\n  \"a\" : [1,2,3] ,  \"note\":\"café\"  }")

	projectID := ids.New(ids.Project)
	eventID := ids.New(ids.Event)
	plan, apiErr := ingest.PlanPayload(ctx, store,
		ingest.PayloadLimits{InlineMax: 8, Max: 1 << 20}, projectID, eventID, body)
	if apiErr != nil {
		t.Fatalf("PlanPayload: %v", apiErr)
	}
	t.Cleanup(func() { _ = store.Delete(context.Background(), plan.Location) })
	if plan.Location == "" {
		t.Fatal("the payload was not offloaded")
	}

	h := newHarness(t, srv.URL, withFetcher(store))
	// Exactly what internal/worker's Load would produce for an offloaded event:
	// payload_raw NULL, payload_location set, payload_hash from ingest.
	h.store.job.Payload = nil
	h.store.job.PayloadLocation = plan.Location
	h.store.job.PayloadHash = plan.Hash
	h.worker.handle(ctx, h.lease())

	got := h.store.lastCompletion(t)
	if got.Next.State != StateSucceeded {
		t.Fatalf("state = %s (%s), want succeeded", got.Next.State, got.Next.Reason)
	}

	mu.Lock()
	defer mu.Unlock()
	if !bytes.Equal(gotBody, body) {
		t.Fatalf("the endpoint received different bytes.\n sent: %q\n got:  %q", body, gotBody)
	}
	if h := ingest.HashPayload(gotBody); h != plan.Hash {
		t.Fatalf("delivered bytes hash to %s, but events.payload_hash is %s", h, plan.Hash)
	}

	// And the signature a consumer would check, over the bytes it received.
	sig := gotHdrs.Get(HeaderSignature)
	if sig == "" {
		t.Fatal("no Webhook-Signature header was sent")
	}
	if err := signing.Verify(sig, h.secret, gotBody, 5*time.Minute, time.Now()); err != nil {
		t.Fatalf("the delivered payload does not verify against its own signature: %v", err)
	}
}
