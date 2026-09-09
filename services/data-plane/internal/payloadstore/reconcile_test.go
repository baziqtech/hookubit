package payloadstore

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/oklog/ulid/v2"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
)

// fakeS3 is an in-memory bucket. It is enough for the sweep, whose logic is all
// about which keys it decides to touch.
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	listErr error
	deleted []string
}

func newFakeS3() *fakeS3 { return &fakeS3{objects: map[string][]byte{}} }

func (f *fakeS3) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	return nil, errors.New("not used")
}

func (f *fakeS3) GetObject(_ context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	return nil, errors.New("not used")
}

func (f *fakeS3) DeleteObject(_ context.Context, in *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, *in.Key)
	delete(f.objects, *in.Key)
	return &s3.DeleteObjectOutput{}, nil
}

func (f *fakeS3) ListObjectsV2(_ context.Context, in *s3.ListObjectsV2Input, _ ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	keys := make([]string, 0, len(f.objects))
	for k := range f.objects {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := &s3.ListObjectsV2Output{}
	for _, k := range keys {
		out.Contents = append(out.Contents, types.Object{Key: aws.String(k)})
	}
	return out, nil
}

func (f *fakeS3) deletedKeys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.deleted...)
}

// referencedSet answers from a fixed set of event ids.
type referencedSet struct {
	known map[string]bool
	err   error
}

func (r referencedSet) PayloadReferenced(_ context.Context, eventID string) (bool, error) {
	if r.err != nil {
		return false, r.err
	}
	return r.known[eventID], nil
}

// eventIDAt mints an event id whose embedded ULID timestamp is `age` old, which
// is how the sweep decides whether an object is even a candidate.
func eventIDAt(age time.Duration) string {
	ts := ulid.Timestamp(time.Now().Add(-age))
	return ids.Event + "_" + ulid.MustNew(ts, ulid.DefaultEntropy()).String()
}

func sweepStore(api S3API) *Store {
	return NewWithAPI(api, Config{Bucket: "webhook-payloads", Prefix: DefaultPrefix, MaxObjectBytes: 1 << 20})
}

func TestReconcileDeletesOnlyUnreferencedOldObjects(t *testing.T) {
	project := ids.New(ids.Project)
	orphan := eventIDAt(48 * time.Hour)
	live := eventIDAt(48 * time.Hour)
	young := eventIDAt(time.Minute)

	api := newFakeS3()
	for _, id := range []string{orphan, live, young} {
		api.objects[Key(DefaultPrefix, project, id)] = []byte("{}")
	}
	// Something a human put in the bucket. It is not ours and must survive.
	api.objects["backups/2026-01-01.tar.gz"] = []byte("x")

	report, err := sweepStore(api).Reconcile(context.Background(),
		referencedSet{known: map[string]bool{live: true}},
		ReconcileOptions{MinAge: 24 * time.Hour})
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	deleted := api.deletedKeys()
	if len(deleted) != 1 || deleted[0] != Key(DefaultPrefix, project, orphan) {
		t.Fatalf("deleted = %v, want only the orphan %s", deleted, orphan)
	}
	if report.Deleted != 1 || report.Referenced != 1 {
		t.Fatalf("report = %+v", report)
	}
}

// MinAge is the guard against racing an ingest request that is between its
// upload and its COMMIT. It is floored regardless of what configuration says.
func TestReconcileNeverDeletesAnObjectYoungerThanTheFloor(t *testing.T) {
	project := ids.New(ids.Project)
	recent := eventIDAt(30 * time.Minute)

	api := newFakeS3()
	api.objects[Key(DefaultPrefix, project, recent)] = []byte("{}")

	// Ask for a reckless one-second window. The floor must override it.
	report, err := sweepStore(api).Reconcile(context.Background(),
		referencedSet{known: map[string]bool{}},
		ReconcileOptions{MinAge: time.Second})
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if report.Deleted != 0 || len(api.deletedKeys()) != 0 {
		t.Fatalf("deleted an object younger than %s; that races the ingest path", MinAgeFloor)
	}
}

// A database that cannot answer must never be read as "no row references this".
func TestReconcileSkipsRatherThanDeletesWhenTheLookupFails(t *testing.T) {
	project := ids.New(ids.Project)
	api := newFakeS3()
	api.objects[Key(DefaultPrefix, project, eventIDAt(48*time.Hour))] = []byte("{}")

	report, err := sweepStore(api).Reconcile(context.Background(),
		referencedSet{err: errors.New("connection refused")},
		ReconcileOptions{MinAge: 24 * time.Hour})
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if report.Deleted != 0 {
		t.Fatal("a failed existence check must skip the object, never delete it")
	}
	if report.Skipped != 1 {
		t.Fatalf("report = %+v", report)
	}
}

func TestReconcileStopsAtMaxDeletes(t *testing.T) {
	project := ids.New(ids.Project)
	api := newFakeS3()
	for i := 0; i < 10; i++ {
		api.objects[Key(DefaultPrefix, project, eventIDAt(48*time.Hour))] = []byte("{}")
	}

	report, err := sweepStore(api).Reconcile(context.Background(),
		referencedSet{known: map[string]bool{}},
		ReconcileOptions{MinAge: 24 * time.Hour, MaxDeletes: 3})
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if report.Deleted != 3 {
		t.Fatalf("deleted %d, want the run to stop at 3", report.Deleted)
	}
}

func TestReconcileReportsAListFailureRatherThanClaimingSuccess(t *testing.T) {
	api := newFakeS3()
	api.listErr = errors.New("bucket unreachable")
	_, err := sweepStore(api).Reconcile(context.Background(), referencedSet{}, ReconcileOptions{})
	if err == nil {
		t.Fatal("a sweep that could not list must report it")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want an unavailability", err)
	}
}

func TestReconcileNeedsALookup(t *testing.T) {
	if _, err := sweepStore(newFakeS3()).Reconcile(context.Background(), nil, ReconcileOptions{}); err == nil {
		t.Fatal("reconciling with no way to check references would delete everything")
	}
}
