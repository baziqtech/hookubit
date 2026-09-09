// Package payloadstore is the S3-compatible object store behind
// ARCHITECTURE.md 32: payloads at or above PAYLOAD_INLINE_MAX_BYTES do not sit
// in PostgreSQL, they sit in a bucket and `events.payload_location` points at
// them.
//
// It is one package rather than two halves because ingest WRITES the object and
// the worker READS it, and the two must agree byte for byte on the key. When
// they disagree every large event is accepted at ingest and fails at delivery -
// the worst possible split, because the platform has already promised the
// customer 202. Putting the key layout in one function that both sides call is
// the cheapest way to make that disagreement impossible.
package payloadstore

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
)

// DefaultPrefix is the top-level key namespace. Everything the platform writes
// lives under it, so a bucket policy, a lifecycle rule or the orphan sweep can
// name one prefix and be sure it covers exactly the platform's objects and
// nothing an operator put in the bucket by hand.
const DefaultPrefix = "events"

// Sentinel outcomes. The DIFFERENCE between them is the whole point: the
// delivery path treats them as three different situations and an operator
// reading `last_error` gets three different sentences.
var (
	// ErrObjectNotFound means the bucket answered, definitively, that this key
	// does not exist. Expired, swept, or never written. Retrying cannot help.
	ErrObjectNotFound = errors.New("payloadstore: object does not exist")

	// ErrObjectTooLarge means the stored object exceeded the read ceiling. The
	// ceiling is applied to the BYTES READ, never to the length the store
	// reports, so a lying or corrupted Content-Length cannot make this process
	// allocate without bound.
	ErrObjectTooLarge = errors.New("payloadstore: object exceeds the maximum readable size")

	// ErrUnavailable means we could not find out. A timeout, a connection
	// refused, a 5xx. The object may well be there; this is our problem, not
	// the customer's and not the endpoint's.
	ErrUnavailable = errors.New("payloadstore: object storage is unavailable")
)

// Key is the object key for one event's payload:
//
//	<prefix>/<project_id>/<event_id>
//
// Three properties are load-bearing, and all three are about failure rather
// than about tidiness:
//
//  1. The event ID is the LAST segment and is a prefixed ULID, so the age of an
//     object is derivable FROM ITS KEY. Reconcile therefore never has to HEAD
//     an object to find out whether it is old enough to consider deleting -
//     which is what makes an orphan sweep cheap enough to actually run.
//  2. The project ID is a path segment, so a bucket policy or a lifecycle rule
//     can be scoped per tenant later without a migration.
//  3. It is derived purely from (project, event) with no clock and no counter,
//     so the writer and the reader compute the same key from the same row
//     forever - including after a replay, which reuses the original event.
func Key(prefix, projectID, eventID string) string {
	return strings.Trim(prefix, "/") + "/" + projectID + "/" + eventID
}

// Location renders the value written to events.payload_location.
//
// The bucket is part of the stored value on purpose. Reading the object back
// through whatever S3_BUCKET happens to say TODAY would silently break every
// historical event the day an operator moves buckets; the row records where the
// bytes actually went.
func Location(bucket, key string) string {
	return "s3://" + bucket + "/" + key
}

// Ref is a parsed payload_location.
type Ref struct {
	Bucket string
	Key    string
}

// ParseLocation splits a stored location back into bucket and key.
//
// It is strict. A location this function cannot parse is a corrupt row, and the
// delivery path must say so distinctly rather than guessing at a bucket and
// fetching whatever answers.
func ParseLocation(location string) (Ref, error) {
	rest, ok := strings.CutPrefix(location, "s3://")
	if !ok {
		return Ref{}, fmt.Errorf("payload_location %q does not start with s3://", location)
	}
	bucket, key, ok := strings.Cut(rest, "/")
	if !ok || bucket == "" || key == "" {
		return Ref{}, fmt.Errorf("payload_location %q is not s3://<bucket>/<key>", location)
	}
	return Ref{Bucket: bucket, Key: key}, nil
}

// ParsedKey is a key decomposed back into the row it belongs to.
type ParsedKey struct {
	ProjectID string
	EventID   string
	// CreatedAt is the event ULID's embedded timestamp - the moment ingest
	// minted the ID, which is within one request of when the object was
	// written.
	CreatedAt time.Time
}

// ParseKey is the inverse of Key, and it is deliberately unforgiving.
//
// Reconcile DELETES what this function accepts, so anything that is not exactly
// the shape this package writes - a hand-uploaded file, a key from some future
// layout, a directory marker - must be rejected and left alone. The event ID is
// validated as a real `evt_` ULID rather than pattern-matched, which is also
// where CreatedAt comes from.
func ParseKey(prefix, key string) (ParsedKey, error) {
	trimmed, ok := strings.CutPrefix(key, strings.Trim(prefix, "/")+"/")
	if !ok {
		return ParsedKey{}, fmt.Errorf("key %q is not under the %q prefix", key, prefix)
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 {
		return ParsedKey{}, fmt.Errorf("key %q is not <prefix>/<project_id>/<event_id>", key)
	}
	projectID, eventID := parts[0], parts[1]
	if _, err := ids.Parse(projectID, ids.Project); err != nil {
		return ParsedKey{}, fmt.Errorf("key %q: %w", key, err)
	}
	parsed, err := ids.Parse(eventID, ids.Event)
	if err != nil {
		return ParsedKey{}, fmt.Errorf("key %q: %w", key, err)
	}
	return ParsedKey{
		ProjectID: projectID,
		EventID:   eventID,
		CreatedAt: ulid.Time(parsed.Time()).UTC(),
	}, nil
}
