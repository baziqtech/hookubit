package worker

import (
	"context"
	"errors"
	"fmt"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ingest"
	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
	"github.com/shaq/webhook-platform/services/data-plane/internal/payloadstore"
)

// PayloadFetcher reads an offloaded payload back out of object storage.
// *payloadstore.Store satisfies it.
type PayloadFetcher interface {
	// Get returns the EXACT stored bytes for a payload_location, or one of the
	// payloadstore sentinels: ErrObjectNotFound, ErrObjectTooLarge,
	// ErrUnavailable.
	Get(ctx context.Context, location string) ([]byte, error)
}

// resolvePayload returns the bytes this delivery must sign and send.
//
// There are exactly two authoritative sources and the row says which:
//
//   - payload_location empty  -> events.payload_raw, the exact request bytes.
//   - payload_location set    -> the object, whose bytes are equally exact.
//
// The jsonb `payload` column is never either of them. It is a normalised
// projection; PostgreSQL reorders keys and drops whitespace, so a signature
// computed over it verifies nowhere. That bug has already been had once
// (HANDOFF.md), which is why the check below is not just "did we get bytes" but
// "are these THE bytes": SHA-256 of what came back must equal
// events.payload_hash, which ingest computed over what the customer actually
// sent. It is the one assertion that catches a truncated read, a mis-keyed
// object, a re-encoded object, or a bucket that answered with somebody else's
// data - all of which otherwise present as "the consumer says our signature is
// wrong", months later, with no way to tell which side is lying.
func (w *Worker) resolvePayload(ctx context.Context, job *Job) ([]byte, error) {
	if job.PayloadLocation == "" {
		if len(job.Payload) == 0 {
			return nil, ErrNoPayload
		}
		// An inline payload is verified too. It costs one SHA-256 over at most
		// PAYLOAD_INLINE_MAX_BYTES and it is the same tripwire.
		if err := verifyPayload(job.Payload, job.PayloadHash); err != nil {
			return nil, err
		}
		return job.Payload, nil
	}

	if w.payloads == nil {
		// Offloaded payloads exist in this deployment but this process has no
		// object-storage client. That is a misconfiguration, not an endpoint
		// problem, and it is recoverable by fixing the configuration - so the
		// delivery DEFERS rather than failing.
		metrics.PayloadFetches.WithLabelValues("unavailable").Inc()
		return nil, fmt.Errorf("%w: no object storage client is configured", ErrPayloadStoreUnavailable)
	}

	// The object fetch gets its OWN budget, not the database one. They are set
	// by different knobs and bound different resources, and running this on
	// w.dbTimeout meant an operator who raised PAYLOAD_DOWNLOAD_TIMEOUT_MS above
	// INGEST_DB_TIMEOUT_MS got the smaller of the two with nothing said about
	// it - the delivery failed on a deadline they had explicitly moved.
	fetchCtx, cancel := context.WithTimeout(ctx, w.payloadTimeout)
	defer cancel()

	body, err := w.payloads.Get(fetchCtx, job.PayloadLocation)
	switch {
	case err == nil:
	case errors.Is(err, payloadstore.ErrObjectNotFound), errors.Is(err, payloadstore.ErrObjectTooLarge):
		// The bucket answered definitively. Retrying cannot conjure the object
		// back, and an oversized object is not going to shrink.
		metrics.PayloadFetches.WithLabelValues("missing").Inc()
		return nil, fmt.Errorf("%w: %v", ErrPayloadGone, err)
	default:
		metrics.PayloadFetches.WithLabelValues("unavailable").Inc()
		return nil, fmt.Errorf("%w: %v", ErrPayloadStoreUnavailable, err)
	}

	if err := verifyPayload(body, job.PayloadHash); err != nil {
		metrics.PayloadFetches.WithLabelValues("corrupt").Inc()
		return nil, err
	}
	metrics.PayloadFetches.WithLabelValues("fetched").Inc()
	return body, nil
}

// verifyPayload is the byte-fidelity check. An empty stored hash (a row from
// before payload_hash was populated) skips it rather than failing every legacy
// delivery; there is nothing to compare against and refusing would turn a
// missing column into an outage.
func verifyPayload(body []byte, want string) error {
	if len(body) == 0 {
		return ErrNoPayload
	}
	if want == "" {
		return nil
	}
	if got := ingest.HashPayload(body); got != want {
		return fmt.Errorf("%w: payload_hash is %s but the bytes hash to %s", ErrPayloadCorrupt, want, got)
	}
	return nil
}
