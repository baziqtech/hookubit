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
// # A claim that returned five rows for LIMIT 1
//
// TestScenario06_SchedulerCrashes failed intermittently on 2026-09-09 with
// "claimed 5 deliveries with the scheduler down, want 1", only when the package
// ran as a whole and roughly one run in thirteen. It was a real bug, in
// production code, and it is fixed; this note stays because the failure mode is
// instructive and the trigger is easy to recreate.
//
// The claim was `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT
// $3)`. When pg_class said the table was tiny - relpages 6, reltuples 0, which
// is what autovacuum leaves after an earlier test bloats and then empties the
// table - the planner put the subquery on the inner side of a nested-loop semi
// join and re-executed it for every outer row. Each re-execution re-locked the
// first sorted row; a row this same UPDATE had already modified is
// TM_SelfModified, which LockRows treats as deleted and skips, so the next tied
// row became that turn's winner and matched the next outer row. Five tied rows,
// five turns, five updates. Under any other statistics the planner hashed the
// subquery once and the LIMIT held, which is why the same test passed alone
// (fresh statistics from the template) and mostly passed in the package
// (autovacuum had not yet visited).
//
// The fix is in queue.claimFIFOSQL, claimTenantFairSQL and
// router.claimOutboxSQL: the batch is fixed in a MATERIALIZED CTE before the
// UPDATE joins to it, so it is bounded by construction. The failure path of
// TestScenario06 still logs pg_class statistics, because "which statistics
// state was the planner looking at" was the question that took longest.
package failure
