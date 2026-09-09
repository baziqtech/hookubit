// Package failure holds the failure-injection integration suite: the tests that
// prove the recovery strategy claimed for each scenario in ARCHITECTURE.md 57
// is the behaviour the code actually has.
//
// It deliberately contains no production code. Everything lives in the external
// test package `failure_test`, which forces every assertion to go through the
// exported surface a real deployment uses - queue.PostgresQueue, worker.Worker,
// router.Router, ingest.PostgresStore - rather than through internals a
// refactor could quietly change.
//
// A "crash" here is simulated, never literal: a transaction abandoned before
// COMMIT, a lease left to lapse, a claimed row dropped without being advanced,
// an attempt context cancelled mid-flight. Those are the states a killed
// process leaves in PostgreSQL, and PostgreSQL is the only place this platform
// is allowed to keep anything it cannot afford to lose (ADR-0003).
//
// The suite needs a database. testsupport.Pool SKIPS rather than fails when
// DATABASE_URL is unset, and that contract is preserved here.
package failure
