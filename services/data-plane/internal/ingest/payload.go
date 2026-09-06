package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

// PayloadStore offloads payloads too large to sit inline in PostgreSQL
// (ARCHITECTURE.md 32). The S3 implementation is deliberately not here: ingest
// only needs the seam, and a fake makes the size rules testable without a
// bucket.
type PayloadStore interface {
	// Put stores the exact request bytes and returns a location string
	// (s3://bucket/key) for events.payload_location.
	Put(ctx context.Context, projectID, eventID string, body []byte) (string, error)
}

// ErrPayloadStoreUnavailable is returned when no object storage is configured.
// It is not an internal error: without a bucket the effective maximum event
// size is the inline limit, and the caller is told exactly that.
var ErrPayloadStoreUnavailable = errors.New("object storage is not configured")

// unconfiguredStore is the default when S3_BUCKET is unset. Failing loudly at
// the point of use beats silently truncating or inlining an oversized payload.
type unconfiguredStore struct{}

// NewUnconfiguredPayloadStore returns a store that refuses every write.
func NewUnconfiguredPayloadStore() PayloadStore { return unconfiguredStore{} }

func (unconfiguredStore) Put(context.Context, string, string, []byte) (string, error) {
	return "", ErrPayloadStoreUnavailable
}

// PayloadPlan is how one request body will be persisted.
type PayloadPlan struct {
	// Inline holds the exact request bytes when they are small enough to live
	// in events.payload; nil when the payload was offloaded.
	Inline []byte
	// Location is set instead of Inline for offloaded payloads.
	Location string
	Size     int
	// Hash is the SHA-256 of the EXACT request bytes, in both cases. Signing
	// operates on those bytes; re-serialising the JSON would not match
	// (docs/API.md), so the hash is the tripwire that says so.
	Hash string
}

// HashPayload returns the lowercase hex SHA-256 of the exact bytes given.
func HashPayload(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// PayloadLimits are the two thresholds from configuration.
type PayloadLimits struct {
	// InlineMax: payloads at or above this go to object storage.
	InlineMax int64
	// Max: payloads above this are refused outright. Unlimited event size is
	// not an option (ARCHITECTURE.md 32).
	Max int64
}

// CheckSize enforces the hard ceiling. Kept separate from planning because the
// HTTP layer must be able to reject before it has a full body in memory.
func (l PayloadLimits) CheckSize(size int64) *apiError {
	if size > l.Max {
		return errPayloadTooLarge(fmt.Sprintf(
			"Payload exceeds the maximum event size of %d bytes", l.Max))
	}
	return nil
}

// NeedsOffload reports whether a body of this size must go to object storage.
// The comparison is >=, matching PAYLOAD_INLINE_MAX_BYTES read as "the largest
// size that is NOT stored inline is anything at or above this".
func (l PayloadLimits) NeedsOffload(size int64) bool {
	return size >= l.InlineMax
}

// PlanPayload decides where the bytes go and computes the hash of the exact
// bytes received - never of a re-encoding.
func PlanPayload(
	ctx context.Context,
	store PayloadStore,
	limits PayloadLimits,
	projectID, eventID string,
	body []byte,
) (PayloadPlan, *apiError) {
	size := int64(len(body))
	if err := limits.CheckSize(size); err != nil {
		return PayloadPlan{}, err
	}

	plan := PayloadPlan{Size: len(body), Hash: HashPayload(body)}
	if !limits.NeedsOffload(size) {
		plan.Inline = body
		return plan, nil
	}

	location, err := store.Put(ctx, projectID, eventID, body)
	if err != nil {
		if errors.Is(err, ErrPayloadStoreUnavailable) {
			// Be honest about the effective limit rather than returning a 500
			// for what is a deployment configuration, not a fault.
			return PayloadPlan{}, errPayloadTooLarge(fmt.Sprintf(
				"Payloads of %d bytes or more require object storage, which is not configured; the current limit is %d bytes",
				limits.InlineMax, limits.InlineMax-1))
		}
		return PayloadPlan{}, errInternal()
	}
	plan.Location = location
	return plan, nil
}
