// Package queue is the boundary between "what work is ready" and "how we learn
// about it".
//
// The MVP implementation is PostgreSQL itself, using SELECT ... FOR UPDATE SKIP
// LOCKED (ADR-0003). That satisfies two requirements at once: the outbox needs
// exactly this locking primitive anyway (ARCHITECTURE.md 15), and durable state
// must survive Redis disappearing entirely (ARCHITECTURE.md 14). Redis and,
// later, SQS/Kafka/NATS can implement this interface as a latency optimisation
// in front of the same durable rows - never as the record itself.
package queue

import (
	"context"
	"errors"
	"time"
)

// ErrLeaseLost reports that a lease this worker believed it held is no longer
// its own: it expired and was reclaimed, or the delivery was moved on by
// something else. It is not a transport failure and retrying the call will not
// recover the lease.
//
// A worker that sees this MUST abandon the in-flight attempt's bookkeeping. The
// row is now another worker's to finish, and writing a delivery_attempts row or
// a status transition against it is how one webhook gets delivered twice with a
// terminal status decided by whichever process committed last.
var ErrLeaseLost = errors.New("queue: lease is no longer held by this worker")

// DeliveryJob is the internal contract between scheduler and worker
// (ARCHITECTURE.md 56). It carries identifiers, never payloads: the worker
// fetches event bodies from PostgreSQL or object storage. Putting a 1 MB
// payload into a queue message makes the queue the second source of truth.
type DeliveryJob struct {
	DeliveryID     string    `json:"delivery_id"`
	EventID        string    `json:"event_id"`
	EndpointID     string    `json:"endpoint_id"`
	OrganizationID string    `json:"organization_id"`
	ProjectID      string    `json:"project_id"`
	Attempt        int       `json:"attempt"`
	ScheduledAt    time.Time `json:"scheduled_at"`
	OrderingKey    string    `json:"ordering_key,omitempty"`
}

// Lease is a time-bounded claim on a job. A worker that dies mid-delivery
// simply stops renewing; the lease expires and another worker's ordinary Claim
// picks the row up again. This is the recovery mechanism for "worker crashes
// during delivery" (ARCHITECTURE.md 57, case 4), and it depends on Claim
// treating a leased-but-expired row as claimable - see claimStatuses in
// postgres.go, which must include the leased status for that to be true.
type Lease struct {
	Job       DeliveryJob
	WorkerID  string
	ExpiresAt time.Time
	// HeadOfLineDelay is how long the job was ready before it was claimed,
	// measured by the database at claim time. Scheduling delay only: it
	// excludes the attempt itself. This is the fairness SLI of ADR-0007.
	HeadOfLineDelay time.Duration
}

// Queue is the work source. Implementations must be safe for concurrent use by
// many workers across many processes.
type Queue interface {
	// Claim atomically leases up to limit ready jobs to workerID. It must never
	// hand the same delivery to two workers concurrently, and it must treat a
	// row whose lease has expired as ready again - crash recovery is the same
	// query as normal operation (ADR-0003).
	Claim(ctx context.Context, workerID string, limit int, lease time.Duration) ([]Lease, error)

	// Renew extends the leases held by workerID and reports which of them are
	// no longer held by it. A worker renews while an attempt is still in flight so a
	// slow-but-alive delivery is not stolen.
	//
	// The returned slice holds the delivery IDs whose leases were NOT renewed,
	// because the row is no longer leased to workerID. That is not an error -
	// it is the normal outcome of a renewal that arrived too late, e.g. after a
	// database failover ate a renewal round - but it is a signal the caller
	// must act on: the attempts for those IDs must be abandoned without writing
	// any attempt row or status transition. Silently returning nil here is how
	// two workers deliver the same webhook and race over its terminal status.
	//
	// The error return is reserved for actually failing to ask.
	Renew(ctx context.Context, workerID string, deliveryIDs []string, lease time.Duration) (lost []string, err error)

	// Release returns a job without completing it, so it can be retried
	// immediately rather than waiting for the lease to lapse. It returns
	// ErrLeaseLost if the lease had already been reclaimed, so a caller can
	// tell "I gave it back" from "it was taken from me".
	Release(ctx context.Context, workerID string, deliveryID string) error
}
