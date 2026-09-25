package payloadstore

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// payloadReferencedSQL is a primary-key lookup, which is what makes the sweep
// affordable: one index probe per candidate object.
//
// `payload_location IS NOT NULL` is part of the predicate rather than assumed.
// An events row that exists but has no location does not reference this object,
// and treating "row exists" as "referenced" would make the sweep unable to
// clean up after a future change that moved a payload back inline.
const payloadReferencedSQL = `
SELECT EXISTS (
    SELECT 1 FROM events WHERE id = $1 AND payload_location IS NOT NULL
)
`

// PostgresEventLookup answers the sweep's one question.
type PostgresEventLookup struct {
	pool *pgxpool.Pool
}

func NewPostgresEventLookup(pool *pgxpool.Pool) *PostgresEventLookup {
	return &PostgresEventLookup{pool: pool}
}

var _ EventLookup = (*PostgresEventLookup)(nil)

// PayloadReferenced implements EventLookup.
func (l *PostgresEventLookup) PayloadReferenced(ctx context.Context, eventID string) (bool, error) {
	var exists bool
	if err := l.pool.QueryRow(ctx, payloadReferencedSQL, eventID).Scan(&exists); err != nil {
		return false, fmt.Errorf("check payload reference for %s: %w", eventID, err)
	}
	return exists, nil
}
