// Package outage holds the infrastructure-outage half of the failure-injection
// suite: ARCHITECTURE.md 57 scenarios 7, 8, 9 and 18 (Redis, PostgreSQL, the
// queue and the connection pool going away) and 13-16 (DNS failure, DNS to
// private space, redirects into private space, DNS rebinding).
//
// It contains no production code. Every assertion runs from the external test
// package `outage_test` and goes through the exported surface a real deployment
// uses - ingest.Handler over ingest.PostgresStore, queue.PostgresQueue,
// worker.PostgresStore, egress.Client - so a refactor of an internal cannot
// quietly invalidate the proof.
//
// Outages are simulated IN PROCESS and never by touching a real service: an
// in-process TCP relay in front of PostgreSQL that the test can close and
// reopen, a Redis client pointed at a closed port, a pool of one connection
// with that connection already checked out. Nothing here stops the developer's
// PostgreSQL, Redis or MinIO, because other packages and other agents are using
// them at the same time.
//
// The database tests SKIP rather than fail when DATABASE_URL is unset, which is
// the contract internal/testsupport establishes and every other integration
// package in this service keeps.
package outage
