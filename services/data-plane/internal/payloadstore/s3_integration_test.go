package payloadstore

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
	"github.com/shaq/hookubit/services/data-plane/internal/ingest"
)

// requireS3 gates every test in this file on a real S3-compatible endpoint, the
// same way requireRedis gates the live token-bucket tests.
//
// Everything else in this package runs against fakeS3, which covers the
// decisions - key shape, age, reference checks, ceilings. What it CANNOT cover
// is whether the SDK is configured correctly for a non-AWS endpoint (path-style
// addressing, a custom base endpoint, static credentials), whether the bytes
// survive a real round trip, or whether a real 404 is classified as
// ErrObjectNotFound rather than as an outage. Those only fail against a bucket.
//
//	S3_TEST_ENDPOINT=http://localhost:9000 \
//	S3_TEST_BUCKET=webhook-payloads \
//	S3_TEST_ACCESS_KEY=minioadmin S3_TEST_SECRET_KEY=minioadmin \
//	go test ./internal/payloadstore/
func requireS3(t *testing.T, mutate ...func(*Config)) *Store {
	t.Helper()
	endpoint := firstEnv("S3_TEST_ENDPOINT", "S3_ENDPOINT")
	bucket := firstEnv("S3_TEST_BUCKET", "S3_BUCKET")
	if endpoint == "" || bucket == "" {
		t.Skip("S3_TEST_ENDPOINT/S3_TEST_BUCKET are not set; skipping the live object storage tests")
	}

	cfg := Config{
		Endpoint:  endpoint,
		Bucket:    bucket,
		Region:    firstEnvOr("us-east-1", "S3_TEST_REGION", "S3_REGION"),
		AccessKey: firstEnv("S3_TEST_ACCESS_KEY", "S3_ACCESS_KEY"),
		SecretKey: firstEnv("S3_TEST_SECRET_KEY", "S3_SECRET_KEY"),
		// MinIO is reached by host and port with no wildcard DNS, so
		// bucket-in-the-hostname addressing cannot resolve.
		ForcePathStyle: true,
		// Each test owns a prefix, so a shared bucket cannot make one test's
		// sweep delete another test's objects.
		Prefix:         "test-" + ids.New("run"),
		MaxObjectBytes: 1 << 20,
	}
	for _, fn := range mutate {
		fn(&cfg)
	}

	store, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("build store against %s: %v", endpoint, err)
	}
	return store
}

func firstEnv(names ...string) string {
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	return ""
}

func firstEnvOr(fallback string, names ...string) string {
	if v := firstEnv(names...); v != "" {
		return v
	}
	return fallback
}

// cleanup removes what a test wrote, so a shared bucket does not accumulate.
func cleanup(t *testing.T, s *Store, locations ...string) {
	t.Helper()
	t.Cleanup(func() {
		for _, loc := range locations {
			_ = s.Delete(context.Background(), loc)
		}
	})
}

// THE test. Ingest plans and uploads a payload exactly as the accept pipeline
// does; the delivery path reads it back through the same store; the bytes must
// be identical and must hash to what would have been written to
// events.payload_hash.
//
// That last assertion is the one that matters. It is the check that would have
// caught the jsonb normalisation bug: a path that re-encodes the JSON produces
// something that still parses, still looks right in a log, and produces a
// signature no consumer can verify.
func TestLiveRoundTripPreservesExactBytesAndHash(t *testing.T) {
	store := requireS3(t)
	ctx := context.Background()

	projectID := ids.New(ids.Project)
	eventID := ids.New(ids.Event)

	// Deliberately awkward: leading and trailing whitespace, non-alphabetical
	// key order, a duplicate key, a unicode escape and a raw multi-byte rune.
	// A jsonb round trip changes every one of these.
	body := []byte("  {\n  \"z\": 1,\n  \"a\": {\"b\":[3,2,1]},\n  \"a\": 2,\n" +
		"  \"unicode\": \"caf\\u00e9 café\",\n  \"trailing\": \"  spaces  \"\n}  \n")

	plan, apiErr := ingest.PlanPayload(ctx, store,
		ingest.PayloadLimits{InlineMax: 16, Max: 1 << 20}, projectID, eventID, body)
	if apiErr != nil {
		t.Fatalf("PlanPayload: %v", apiErr)
	}
	cleanup(t, store, plan.Location)

	if plan.Inline != nil {
		t.Fatal("a payload above the inline limit must not also be stored inline")
	}
	// The key layout the writer used is the one the reader will compute.
	wantLocation := Location(store.Bucket(), Key(store.Prefix(), projectID, eventID))
	if plan.Location != wantLocation {
		t.Fatalf("location = %q, want %q; ingest and the worker would look in different places",
			plan.Location, wantLocation)
	}

	got, err := store.Get(ctx, plan.Location)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("round trip changed the bytes.\n sent: %q\n got:  %q", body, got)
	}
	// events.payload_hash was computed over the request bytes before they were
	// stored. What comes back out must hash to the same value or the signature
	// the consumer verifies is over something we cannot account for.
	if h := ingest.HashPayload(got); h != plan.Hash {
		t.Fatalf("HashPayload(fetched) = %s, want events.payload_hash = %s", h, plan.Hash)
	}
}

// Byte fidelity for payloads that are not text at all. JSON is what the API
// accepts, but the store must not transform anything.
func TestLiveRoundTripIsBinarySafe(t *testing.T) {
	store := requireS3(t)
	ctx := context.Background()

	body := make([]byte, 0, 256)
	for i := 0; i < 256; i++ {
		body = append(body, byte(i))
	}

	location, err := store.Put(ctx, ids.New(ids.Project), ids.New(ids.Event), body)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	cleanup(t, store, location)

	got, err := store.Get(ctx, location)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatal("the store is not byte transparent")
	}
	if ingest.HashPayload(got) != ingest.HashPayload(body) {
		t.Fatal("hash mismatch after a binary round trip")
	}
}

// A missing object is a DEFINITIVE answer, and the delivery path depends on
// telling it apart from an outage: one fails the delivery, the other defers it.
func TestLiveMissingObjectIsNotFound(t *testing.T) {
	store := requireS3(t)
	location := Location(store.Bucket(), Key(store.Prefix(), ids.New(ids.Project), ids.New(ids.Event)))

	_, err := store.Get(context.Background(), location)
	if !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("err = %v, want ErrObjectNotFound; anything else defers the delivery forever", err)
	}
}

func TestLiveDeleteIsIdempotentAndRemovesTheObject(t *testing.T) {
	store := requireS3(t)
	ctx := context.Background()

	location, err := store.Put(ctx, ids.New(ids.Project), ids.New(ids.Event), []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := store.Delete(ctx, location); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	// The compensating delete on the ingest path and the sweep can both reach
	// the same key; deleting twice must not be an error.
	if err := store.Delete(ctx, location); err != nil {
		t.Fatalf("second Delete: %v", err)
	}
	if _, err := store.Get(ctx, location); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("object survived deletion: %v", err)
	}
}

// The read ceiling is enforced on bytes actually read. A stored object bigger
// than the largest event the platform accepts is refused rather than buffered.
func TestLiveReadCeilingRefusesAnOversizedObject(t *testing.T) {
	writer := requireS3(t)
	ctx := context.Background()

	body := bytes.Repeat([]byte("x"), 64<<10)
	location, err := writer.Put(ctx, ids.New(ids.Project), ids.New(ids.Event), body)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	cleanup(t, writer, location)

	// A reader configured with a smaller ceiling than the object it finds -
	// which is what a shrunk PAYLOAD_MAX_BYTES, or a tampered object, looks
	// like.
	reader := NewWithAPI(writer.api, Config{
		Bucket:         writer.Bucket(),
		Prefix:         writer.Prefix(),
		MaxObjectBytes: 1024,
	})
	if _, err := reader.Get(ctx, location); !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("err = %v, want ErrObjectTooLarge", err)
	}
}

// Object storage unreachable: every call must classify as an outage, not as a
// missing object. The delivery path defers on one and fails on the other.
func TestLiveUnreachableEndpointIsUnavailableNotNotFound(t *testing.T) {
	if firstEnv("S3_TEST_ENDPOINT", "S3_ENDPOINT") == "" {
		t.Skip("S3_TEST_ENDPOINT is not set; skipping the live object storage tests")
	}
	// A port nothing listens on, with timeouts short enough to keep the test
	// fast and bounded - which is also the property being checked.
	store, err := New(context.Background(), Config{
		Endpoint:        "http://127.0.0.1:1",
		Bucket:          "webhook-payloads",
		Region:          "us-east-1",
		AccessKey:       "x",
		SecretKey:       "y",
		ForcePathStyle:  true,
		UploadTimeout:   2 * time.Second,
		DownloadTimeout: 2 * time.Second,
		MaxAttempts:     1,
		MaxObjectBytes:  1 << 20,
	})
	if err != nil {
		t.Fatalf("build store: %v", err)
	}
	ctx := context.Background()

	started := time.Now()
	if _, err := store.Put(ctx, ids.New(ids.Project), ids.New(ids.Event), []byte(`{}`)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Put err = %v, want ErrUnavailable", err)
	}
	// Bounded: the timeout is the contract, not a suggestion.
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("Put took %s; the upload timeout did not bound it", elapsed)
	}

	_, err = store.Get(ctx, "s3://webhook-payloads/test/proj/evt")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Get err = %v, want ErrUnavailable; an outage must not be mistaken for a missing object", err)
	}
}

// The sweep, against a real bucket: it must find the orphan by listing, decide
// on it from the key, and leave everything else alone.
//
// Note the first run. Every object here was written seconds ago, and the sweep
// refuses to touch a freshly written object EVEN WHEN its key claims the event
// id is two days old - the object's own LastModified is the corroborating
// floor. That is the guard against deleting a payload belonging to a request
// that is between its upload and its COMMIT right now, and it is worth proving
// against a real bucket because it depends on the store returning LastModified.
func TestLiveReconcileDeletesOnlyTheOrphan(t *testing.T) {
	store := requireS3(t)
	ctx := context.Background()

	project := ids.New(ids.Project)
	orphan := eventIDAt(48 * time.Hour)
	referenced := eventIDAt(48 * time.Hour)

	var locations []string
	for _, id := range []string{orphan, referenced} {
		loc, err := store.Put(ctx, project, id, []byte(`{"a":1}`))
		if err != nil {
			t.Fatalf("Put %s: %v", id, err)
		}
		locations = append(locations, loc)
	}
	// Something a human put in the bucket, under our prefix but not our shape.
	// It must survive both runs.
	foreign := Location(store.Bucket(), store.Prefix()+"/notes.txt")
	if _, err := store.api.PutObject(ctx, putInput(store.Bucket(), store.Prefix()+"/notes.txt")); err != nil {
		t.Fatalf("seed foreign object: %v", err)
	}
	cleanup(t, store, append(locations, foreign)...)

	fresh, err := store.Reconcile(ctx,
		referencedSet{known: map[string]bool{referenced: true}},
		ReconcileOptions{MinAge: 24 * time.Hour})
	if err != nil {
		t.Fatalf("Reconcile (fresh): %v", err)
	}
	if fresh.Deleted != 0 {
		t.Fatalf("deleted %d freshly written objects; that races an ingest request mid-COMMIT", fresh.Deleted)
	}

	// Now with the clock moved past the window, which is what the hourly sweep
	// sees a day later.
	later := func() time.Time { return time.Now().Add(48 * time.Hour) }
	report, err := store.Reconcile(ctx,
		referencedSet{known: map[string]bool{referenced: true}},
		ReconcileOptions{MinAge: 24 * time.Hour, Now: later})
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if report.Deleted != 1 {
		t.Fatalf("deleted %d objects, want exactly the one orphan (report %+v)", report.Deleted, report)
	}

	orphanLoc := Location(store.Bucket(), Key(store.Prefix(), project, orphan))
	if _, err := store.Get(ctx, orphanLoc); !errors.Is(err, ErrObjectNotFound) {
		t.Fatal("the orphan was not deleted")
	}
	if _, err := store.Get(ctx, Location(store.Bucket(), Key(store.Prefix(), project, referenced))); err != nil {
		t.Fatalf("the sweep deleted a referenced payload: %v", err)
	}
	if _, err := store.Get(ctx, foreign); err != nil {
		t.Fatalf("the sweep deleted an object it did not write: %v", err)
	}
}

func putInput(bucket, key string) *s3.PutObjectInput {
	return &s3.PutObjectInput{
		Bucket:        aws.String(bucket),
		Key:           aws.String(key),
		Body:          bytes.NewReader([]byte("not a payload")),
		ContentLength: aws.Int64(int64(len("not a payload"))),
	}
}

// An offload that cannot be written must not become a 202. PlanPayload turns a
// store fault into an error the ingest handler answers 500 to; what it must
// never do is fall back to inline, truncate, or report success.
func TestLiveIngestRefusesWhenObjectStorageIsDown(t *testing.T) {
	if firstEnv("S3_TEST_ENDPOINT", "S3_ENDPOINT") == "" {
		t.Skip("S3_TEST_ENDPOINT is not set; skipping the live object storage tests")
	}
	store, err := New(context.Background(), Config{
		Endpoint: "http://127.0.0.1:1", Bucket: "webhook-payloads", Region: "us-east-1",
		AccessKey: "x", SecretKey: "y", ForcePathStyle: true,
		UploadTimeout: 2 * time.Second, MaxAttempts: 1, MaxObjectBytes: 1 << 20,
	})
	if err != nil {
		t.Fatalf("build store: %v", err)
	}

	plan, apiErr := ingest.PlanPayload(context.Background(), store,
		ingest.PayloadLimits{InlineMax: 8, Max: 1 << 20},
		ids.New(ids.Project), ids.New(ids.Event), []byte(strings.Repeat("x", 64)))
	if apiErr == nil {
		t.Fatal("an event whose payload is not durable was accepted")
	}
	if apiErr.Code != ingest.CodeInternalError {
		t.Fatalf("code = %s, want %s", apiErr.Code, ingest.CodeInternalError)
	}
	if plan.Location != "" || plan.Inline != nil {
		t.Fatalf("a failed offload produced a usable plan: %+v", plan)
	}
}
