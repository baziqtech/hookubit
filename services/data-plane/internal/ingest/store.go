package ingest

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
)

// ErrNotFound is returned by lookups that found nothing. Callers translate it;
// the store never decides an HTTP status.
var ErrNotFound = errors.New("not found")

// APIKeyRecord is the credential joined to the project it belongs to. One query
// answers authentication and project resolution together: they are two steps in
// the contract but there is no reason to pay two round trips on the hot path.
type APIKeyRecord struct {
	ID                 string
	ProjectID          string
	OrganizationID     string
	KeyEnvironment     string
	ProjectEnvironment string
	ProjectStatus      string
	RevokedAt          *time.Time
	ExpiresAt          *time.Time
	// ProjectAllowedIPs is the project's publish allowlist. Empty permits every
	// address, which is the default. It rides this query rather than costing
	// one of its own: the handler needs it on every published event, and the
	// join to `projects` is already here.
	ProjectAllowedIPs []string
}

// CreateEventParams is everything the ingest transaction writes.
type CreateEventParams struct {
	EventID        string
	OrganizationID string
	ProjectID      string
	EventType      string
	IdempotencyKey string

	// Payload is the exact request bytes, or nil when offloaded. It is written
	// verbatim to events.payload_raw (bytea), which is the AUTHORITATIVE
	// payload that signing and delivery read, and additionally parsed into the
	// jsonb events.payload as a queryable, NON-AUTHORITATIVE projection.
	Payload         []byte
	PayloadLocation string
	PayloadSize     int
	PayloadHash     string
	Headers         []byte

	// RequestHash and IdempotencyExpiresAt are ignored when IdempotencyKey is
	// empty.
	RequestHash          string
	IdempotencyExpiresAt time.Time

	// TraceContext is the W3C `traceparent` of the ingest request, written to
	// event_outbox.trace_context INSIDE this transaction (ARCHITECTURE.md 44).
	//
	// It goes on the OUTBOX row and not on the event, because it describes the
	// WORK - and the work is what the router claims. It commits with the event,
	// so a rolled-back transaction leaves no context describing an acceptance
	// that never happened. Empty writes NULL, which is what every row written
	// with tracing off carries and what the router treats as "no upstream".
	TraceContext string
}

// Store is the ingest API's whole database surface. Narrow on purpose: it makes
// the handler testable with a fake, and it makes the set of statements that run
// on the hot path something you can read in one screen.
type Store interface {
	// FindAPIKey resolves a SHA-256 key hash to its key and project.
	FindAPIKey(ctx context.Context, keyHash string) (*APIKeyRecord, error)
	// FindIdempotency returns the stored record for a (project, key) pair.
	FindIdempotency(ctx context.Context, projectID, key string) (*IdempotencyRecord, error)
	// CreateEvent writes the idempotency claim, the event and its outbox row in
	// ONE transaction. It reports false when a live idempotency claim already
	// exists, in which case nothing was written and the caller re-reads it.
	CreateEvent(ctx context.Context, p CreateEventParams) (bool, error)
	// TouchAPIKey records last use. Best effort: it is observability, not
	// authorisation, and must never fail a request.
	TouchAPIKey(ctx context.Context, keyID string) error
}

// PostgresStore is the production Store.
type PostgresStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

const findAPIKeySQL = `
SELECT k.id, k.project_id, k.revoked_at, k.expires_at, k.environment::text,
       p.organization_id, p.environment::text, p.status::text, p.allowed_ips
FROM api_keys k
JOIN projects p ON p.id = k.project_id
WHERE k.key_hash = $1
`

func (s *PostgresStore) FindAPIKey(ctx context.Context, keyHash string) (*APIKeyRecord, error) {
	var rec APIKeyRecord
	err := s.pool.QueryRow(ctx, findAPIKeySQL, keyHash).Scan(
		&rec.ID, &rec.ProjectID, &rec.RevokedAt, &rec.ExpiresAt, &rec.KeyEnvironment,
		&rec.OrganizationID, &rec.ProjectEnvironment, &rec.ProjectStatus, &rec.ProjectAllowedIPs,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find api key: %w", err)
	}
	return &rec, nil
}

const findIdempotencySQL = `
SELECT "key", request_hash, COALESCE(event_id, ''), expires_at
FROM idempotency_keys
WHERE project_id = $1 AND "key" = $2
`

func (s *PostgresStore) FindIdempotency(ctx context.Context, projectID, key string) (*IdempotencyRecord, error) {
	var rec IdempotencyRecord
	err := s.pool.QueryRow(ctx, findIdempotencySQL, projectID, key).Scan(
		&rec.Key, &rec.RequestHash, &rec.EventID, &rec.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("find idempotency key: %w", err)
	}
	return &rec, nil
}

// claimIdempotencySQL takes the (project_id, key) slot or reports that someone
// else holds it.
//
// The conditional DO UPDATE is what makes an EXPIRED key reusable: without it
// the unique index would reject the insert forever and a client that reuses a
// key next month would get a permanent conflict. A LIVE row is left untouched
// and no id comes back.
//
// It is also the concurrency fix. Two simultaneous requests with the same key
// serialise on the index: the second blocks until the first commits, then finds
// no row returned, rolls back, re-reads and replays. Only one event is ever
// created.
const claimIdempotencySQL = `
INSERT INTO idempotency_keys (id, project_id, "key", request_hash, event_id, expires_at, created_at)
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT (project_id, "key") DO UPDATE
SET id           = EXCLUDED.id,
    request_hash = EXCLUDED.request_hash,
    event_id     = EXCLUDED.event_id,
    expires_at   = EXCLUDED.expires_at,
    created_at   = now()
WHERE idempotency_keys.expires_at <= now()
RETURNING id
`

// insertEventSQL writes the payload TWICE, on purpose.
//
// payload_raw is bytea and holds the exact bytes received. jsonb does not
// preserve whitespace, key order or duplicate keys, so a signature computed
// over a jsonb round trip would not verify against what the publisher sent
// (ARCHITECTURE.md 28). payload_raw is therefore the authoritative column and
// the only one any signing or delivery path may read; payload is the queryable
// projection for filtering and the operator UI.
//
// payload_hash is the SHA-256 of payload_raw, which makes the invariant
// testable: HashPayload(payload_raw) == payload_hash.
const insertEventSQL = `
INSERT INTO events (
    id, organization_id, project_id, event_type, idempotency_key,
    payload_raw, payload, payload_location, payload_size, payload_hash, headers, status, created_at
) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7::jsonb, $8, $9, $10, $11::jsonb, 'received', now()
)
`

// insertOutboxSQL is the second half of the transactional outbox
// (ARCHITECTURE.md 15). It commits with the event; the router picks it up
// afterwards. Nothing is published anywhere before this COMMIT.
const insertOutboxSQL = `
INSERT INTO event_outbox (id, event_id, type, status, attempts, available_at, created_at, trace_context)
VALUES ($1, $2, 'event.created', 'pending', 0, now(), now(), $3)
`

func (s *PostgresStore) CreateEvent(ctx context.Context, p CreateEventParams) (created bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin ingest transaction: %w", err)
	}
	defer func() {
		// Rollback on any path that did not commit. It is a no-op after a
		// successful commit.
		_ = tx.Rollback(ctx)
	}()

	if p.IdempotencyKey != "" {
		var claimID string
		claimErr := tx.QueryRow(ctx, claimIdempotencySQL,
			ids.New(ids.Idempotency),
			p.ProjectID,
			p.IdempotencyKey,
			p.RequestHash,
			p.EventID,
			p.IdempotencyExpiresAt,
		).Scan(&claimID)
		if errors.Is(claimErr, pgx.ErrNoRows) {
			// A live claim exists. Nothing was written.
			return false, nil
		}
		if claimErr != nil {
			return false, fmt.Errorf("claim idempotency key: %w", claimErr)
		}
	}

	var payloadRaw any
	var payloadJSON any
	if p.Payload != nil {
		// bytea: byte for byte what arrived on the wire.
		payloadRaw = p.Payload
		// Passed as text with an explicit ::jsonb cast so the exact bytes are
		// what PostgreSQL parses. What comes back out is normalised, which is
		// why payload_raw exists.
		payloadJSON = string(p.Payload)
	}
	var location any
	if p.PayloadLocation != "" {
		location = p.PayloadLocation
	}
	var idempotencyKey any
	if p.IdempotencyKey != "" {
		idempotencyKey = p.IdempotencyKey
	}
	var headers any
	if len(p.Headers) > 0 {
		headers = string(p.Headers)
	}

	if _, err := tx.Exec(ctx, insertEventSQL,
		p.EventID, p.OrganizationID, p.ProjectID, p.EventType, idempotencyKey,
		payloadRaw, payloadJSON, location, p.PayloadSize, p.PayloadHash, headers,
	); err != nil {
		return false, fmt.Errorf("insert event: %w", err)
	}

	var traceContext any
	if p.TraceContext != "" {
		traceContext = p.TraceContext
	}
	if _, err := tx.Exec(ctx, insertOutboxSQL, ids.New(ids.Outbox), p.EventID, traceContext); err != nil {
		return false, fmt.Errorf("insert event outbox: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit ingest transaction: %w", err)
	}
	return true, nil
}

const touchAPIKeySQL = `UPDATE api_keys SET last_used_at = now() WHERE id = $1`

func (s *PostgresStore) TouchAPIKey(ctx context.Context, keyID string) error {
	if _, err := s.pool.Exec(ctx, touchAPIKeySQL, keyID); err != nil {
		return fmt.Errorf("touch api key: %w", err)
	}
	return nil
}
