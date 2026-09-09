package payloadstore

import (
	"strings"
	"testing"
	"time"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
)

func TestKeyLayoutIsPrefixProjectEvent(t *testing.T) {
	got := Key("events", "proj_01HQ0000000000000000000000", "evt_01HQ0000000000000000000001")
	want := "events/proj_01HQ0000000000000000000000/evt_01HQ0000000000000000000001"
	if got != want {
		t.Fatalf("Key = %q, want %q", got, want)
	}
	// A prefix with stray slashes must not produce a doubled separator: an
	// empty path segment is a different object, and the writer and the reader
	// would then disagree about where the bytes are.
	if got := Key("/events/", "proj_x", "evt_y"); got != "events/proj_x/evt_y" {
		t.Fatalf("Key = %q; the prefix was not normalised", got)
	}
}

func TestKeyIsStableForTheSameEvent(t *testing.T) {
	// Nothing about the key may depend on the clock or on a counter, or a
	// replay would write to one key and read from another.
	a := Key("events", "proj_1", "evt_1")
	time.Sleep(2 * time.Millisecond)
	if b := Key("events", "proj_1", "evt_1"); a != b {
		t.Fatalf("Key is not deterministic: %q then %q", a, b)
	}
}

func TestLocationRoundTrip(t *testing.T) {
	key := Key(DefaultPrefix, "proj_1", "evt_1")
	loc := Location("webhook-payloads", key)
	if loc != "s3://webhook-payloads/events/proj_1/evt_1" {
		t.Fatalf("Location = %q", loc)
	}
	ref, err := ParseLocation(loc)
	if err != nil {
		t.Fatalf("ParseLocation: %v", err)
	}
	if ref.Bucket != "webhook-payloads" {
		t.Fatalf("bucket = %q", ref.Bucket)
	}
	if ref.Key != key {
		t.Fatalf("key = %q, want %q", ref.Key, key)
	}
}

func TestParseLocationRejectsAnythingItCannotBeSureOf(t *testing.T) {
	for _, bad := range []string{
		"",
		"webhook-payloads/events/proj_1/evt_1", // no scheme
		"https://example.com/x",                // wrong scheme: never fetch this
		"s3://",
		"s3://bucket",     // no key
		"s3://bucket/",    // empty key
		"s3:///events/x",  // empty bucket
		"S3://bucket/key", // scheme is case sensitive here on purpose
	} {
		if _, err := ParseLocation(bad); err == nil {
			t.Fatalf("ParseLocation(%q) succeeded; a location we cannot parse must fail loudly, not be guessed at", bad)
		}
	}
}

func TestParseKeyRecoversTheRowAndTheEventTimestamp(t *testing.T) {
	projectID := ids.New(ids.Project)
	before := time.Now().Add(-time.Second)
	eventID := ids.New(ids.Event)
	after := time.Now().Add(time.Second)

	parsed, err := ParseKey(DefaultPrefix, Key(DefaultPrefix, projectID, eventID))
	if err != nil {
		t.Fatalf("ParseKey: %v", err)
	}
	if parsed.ProjectID != projectID || parsed.EventID != eventID {
		t.Fatalf("ParseKey = %+v", parsed)
	}
	// The age of an object is derivable from its key alone. This is what makes
	// the orphan sweep affordable: no HEAD request per candidate.
	if parsed.CreatedAt.Before(before) || parsed.CreatedAt.After(after) {
		t.Fatalf("CreatedAt = %s, want between %s and %s", parsed.CreatedAt, before, after)
	}
}

// Reconcile DELETES what ParseKey accepts, so it has to reject everything that
// is not exactly the shape this package writes.
func TestParseKeyRejectsAnythingItDidNotWrite(t *testing.T) {
	valid := Key(DefaultPrefix, ids.New(ids.Project), ids.New(ids.Event))
	for _, bad := range []string{
		"",
		"other/proj_1/evt_1", // wrong prefix
		strings.TrimPrefix(valid, DefaultPrefix+"/"),                             // no prefix
		DefaultPrefix + "/",                                                      // nothing under it
		DefaultPrefix + "/proj_1",                                                // too few segments
		valid + "/extra",                                                         // too many segments
		DefaultPrefix + "/notaproject/evt_1",                                     // project id is not an id
		DefaultPrefix + "/" + ids.New(ids.Project) + "/x",                        // event id is not an id
		DefaultPrefix + "/" + ids.New(ids.Project) + "/" + ids.New(ids.Delivery), // right shape, wrong prefix
		DefaultPrefix + "/backup.tar.gz",                                         // somebody's file
	} {
		if _, err := ParseKey(DefaultPrefix, bad); err == nil {
			t.Fatalf("ParseKey(%q) succeeded; the sweep would delete it", bad)
		}
	}
}
