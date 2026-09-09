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
// # An unexplained anomaly, recorded rather than hidden
//
// On 2026-09-09, TestScenario06_SchedulerCrashes failed three times inside
// full-suite runs with "claimed 5 deliveries with the scheduler down, want 1".
// An instrumented run confirmed it is not a bad assertion: with five rows in the
// database and queue.Claim called with a limit of 1, five Lease values came back
// AND five rows in `deliveries` were left carrying that call's locked_by. The
// database really did update five rows through a statement whose subquery ends
// in LIMIT $3.
//
// It has not reproduced since, across thirteen consecutive full-suite runs
// including four at load average 21, a 25-iteration tight loop around the same
// claim, and runs with pgx statement caching disabled. So the mechanism is
// unknown. Ruled out by observation, not by argument: a wrong assertion, the
// test's own seeding, tests inside this package running in parallel (none call
// t.Parallel), and cross-run database theft (which the testsupport guard now
// refuses outright, and which produces a different symptom).
//
// It reproduced twice more on 2026-09-09 - once in a full ./... run and once at
// package level - and then not once in 16 consecutive attempts under the same
// conditions. It appears only when the package runs as a whole, never for the
// single test, which points at an interaction with the tests before it rather
// than at the claim in isolation.
//
// TestScenario06 now dumps the row count, the count carrying the claim's
// locked_by, and the size of the ready set on the failure path. Those reads cost
// nothing while it passes. If you see it again, read that output rather than
// re-running - and add pg_stat_activity for the statement as the server received
// it, which is the one thing still missing.
// A claim that overruns its limit in production would let a worker hold more
// leases than its pool can run, which breaks the bound WORKER_CONCURRENCY is
// supposed to give.
package failure
