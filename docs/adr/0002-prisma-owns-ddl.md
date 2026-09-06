# 0002 — Prisma owns all DDL; the Go data plane never migrates

Status: Accepted

## Decision

`apps/control-api/prisma/schema.prisma` is the single definition of the
database. Migrations are generated and applied only by Prisma, as an explicit
job. The Go services issue hand-written SQL through pgx against an
already-migrated schema and ship no migration tool at all.

## Why it exists

Two languages share one database. Two migration tools sharing one database is a
race with no winner: divergent version tables, competing advisory locks, and a
schema whose true state is whichever service started last.

## What it prevents

- Concurrent, conflicting DDL from two runtimes.
- Silent drift between the Go SQL and the live schema — CI runs
  `prisma migrate diff` and fails the build when the committed migrations and
  `schema.prisma` disagree.
- Startup migrations. Migrations run as a deliberate job, never on boot, so a
  rolling deploy cannot half-apply DDL under live traffic
  (ARCHITECTURE.md 41, engineering rule 21).

## How it scales

Unchanged by load: one migration job, run once per release, before the new
images roll.

## Migration path

If Prisma is ever outgrown, the migration history is plain SQL and can be handed
to Atlas, Flyway or golang-migrate. The rule that survives is *one* owner, not
*which* owner. Expansion-then-contraction stays mandatory either way: add
columns, deploy code that tolerates both shapes, backfill, then drop.
