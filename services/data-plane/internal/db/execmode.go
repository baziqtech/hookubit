package db

import "github.com/jackc/pgx/v5"

// Set as a named constant so the PgBouncer trade-off is documented in one place.
// Switch to pgx.QueryExecModeSimpleProtocol if fronting with PgBouncer in
// statement-pooling mode.
const queryExecModeCacheStatement = pgx.QueryExecModeCacheStatement
