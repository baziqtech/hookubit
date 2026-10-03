package payloadstore

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ORPHANED OBJECTS - the decision, and why.
//
// ingest uploads the payload BEFORE the transaction that writes the events row,
// because the key contains the event ID and the row carries the location, and
// because holding a transaction open across an S3 round trip is exactly what
// ARCHITECTURE.md forbids on the hot path. So there is a window in which an
// object exists and no row will ever reference it.
//
// It is closed from both ends rather than left as an accepted leak:
//
//  1. COMPENSATING DELETE (internal/ingest). Every path where ingest knows,
//     unambiguously, that no events row was written - a lost idempotency race,
//     a failure before the INSERT - deletes the object it just wrote. That is
//     the cause the original note recorded ("one orphaned object per lost
//     race, forever"), and it is now cleaned up in the same request, in
//     milliseconds, with the key already in hand. The delete is deliberately
//     NOT done when CreateEvent returns an error, because a commit that times
//     out may still have landed and deleting then would destroy a live event's
//     payload. Leaking an object is recoverable; deleting a customer's payload
//     is not.
//
//  2. THIS SWEEP, for the residue. What (1) cannot cover is the process dying
//     between the PUT and the COMMIT - a window of at most INGEST_DB_TIMEOUT_MS.
//     Nothing in the request survives to compensate, so reconciliation has to
//     come from outside.
//
// A bucket lifecycle rule was considered and rejected as the primary mechanism:
// orphans and live payloads share a prefix and are indistinguishable by age
// alone, so any expiry broad enough to catch orphans also deletes payloads that
// events still point at. A lifecycle rule remains useful as a backstop AFTER
// event retention, not instead of this.
//
// The sweep is cheap because of the key layout: the event ID is a ULID, so an
// object's age comes from its key and no HEAD request is needed to decide
// whether it is even a candidate, and the existence check is a primary-key
// lookup.
//
// It is also deliberately timid, because the failure mode of a sweep is
// deleting customer data:
//
//   - only keys matching the exact layout this package writes are considered;
//   - only objects older than MinAge (hours, not seconds) are considered;
//   - any database error SKIPS the object rather than deleting it;
//   - each run deletes at most MaxDeletes objects.
//
// Two replicas sweeping at once is harmless - a delete of an already-deleted key
// succeeds - so it needs no lease.

// EventLookup is the sweep's database surface: does an events row still claim
// this object?
type EventLookup interface {
	// PayloadReferenced reports whether an events row with this id exists AND
	// still carries a payload_location. Any error must be returned, never
	// swallowed into "false" - a false negative here deletes a live payload.
	PayloadReferenced(ctx context.Context, eventID string) (bool, error)
}

// ReconcileOptions bounds one sweep.
type ReconcileOptions struct {
	// MinAge is how old an object must be before it is even a candidate.
	// It must comfortably exceed INGEST_DB_TIMEOUT_MS - an object younger than
	// the ingest deadline may belong to a request that is between its PUT and
	// its COMMIT right now.
	MinAge time.Duration
	// MaxDeletes caps one run. A sweep that deletes ten thousand objects is
	// either finding a real problem or being wrong about one; either way it
	// should stop and be looked at.
	MaxDeletes int
	// MaxKeys caps how many keys one run examines, so a bucket with millions
	// of objects cannot turn the sweep into an unbounded job.
	MaxKeys int
	Now     func() time.Time
	Logger  *slog.Logger
}

// MinAgeFloor is the hard lower bound on ReconcileOptions.MinAge, whatever
// configuration asks for. Anything shorter races the ingest path itself.
const MinAgeFloor = time.Hour

// ReconcileReport is what one run did.
type ReconcileReport struct {
	Examined   int
	Skipped    int // wrong shape, too young, or a lookup that failed
	Referenced int
	Deleted    int
}

// Reconcile deletes objects under the store's prefix that no events row
// references. It returns what it did even when it also returns an error, so a
// partial run is still reportable.
func (s *Store) Reconcile(ctx context.Context, lookup EventLookup, opts ReconcileOptions) (ReconcileReport, error) {
	if lookup == nil {
		return ReconcileReport{}, errors.New("payloadstore: reconcile needs an event lookup")
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	minAge := opts.MinAge
	if minAge < MinAgeFloor {
		minAge = MinAgeFloor
	}
	maxDeletes := opts.MaxDeletes
	if maxDeletes <= 0 {
		maxDeletes = 1000
	}
	maxKeys := opts.MaxKeys
	if maxKeys <= 0 {
		maxKeys = 100000
	}

	cutoff := now().Add(-minAge)
	prefix := s.cfg.Prefix + "/"

	var report ReconcileReport
	var token *string
	for {
		out, err := s.api.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(s.cfg.Bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: token,
			MaxKeys:           aws.Int32(1000),
		})
		if err != nil {
			return report, fmt.Errorf("%w: list %s: %v", classify(err), prefix, err)
		}

		for _, obj := range out.Contents {
			if obj.Key == nil {
				continue
			}
			report.Examined++

			parsed, err := ParseKey(s.cfg.Prefix, *obj.Key)
			if err != nil {
				// Not something this package wrote. Leave it alone; the bucket
				// is not necessarily ours alone.
				report.Skipped++
				continue
			}
			// Age from the key, corroborated by the object's own mtime when the
			// store supplies one. Whichever is YOUNGER wins, so a key whose
			// ULID was minted long ago but whose object was written a moment
			// ago (a replay writing the same key) is still protected.
			age := parsed.CreatedAt
			if obj.LastModified != nil && obj.LastModified.After(age) {
				age = obj.LastModified.UTC()
			}
			if age.After(cutoff) {
				report.Skipped++
				continue
			}

			referenced, err := lookup.PayloadReferenced(ctx, parsed.EventID)
			if err != nil {
				// Never delete on a failed lookup.
				log.Warn("orphan sweep could not check an event; leaving the object in place",
					"event_id", parsed.EventID, "error", err)
				report.Skipped++
				continue
			}
			if referenced {
				report.Referenced++
				continue
			}

			if err := s.Delete(ctx, Location(s.cfg.Bucket, *obj.Key)); err != nil {
				log.Warn("orphan sweep could not delete an object",
					"event_id", parsed.EventID, "error", err)
				report.Skipped++
				continue
			}
			report.Deleted++
			log.Info("deleted an orphaned payload object",
				"event_id", parsed.EventID, "project_id", parsed.ProjectID, "age", now().Sub(age).String())

			if report.Deleted >= maxDeletes {
				return report, nil
			}
		}

		if report.Examined >= maxKeys {
			return report, nil
		}
		if out.IsTruncated == nil || !*out.IsTruncated || out.NextContinuationToken == nil {
			return report, nil
		}
		token = out.NextContinuationToken

		if err := ctx.Err(); err != nil {
			return report, err
		}
	}
}
