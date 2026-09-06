# Architecture decision records

One file per decision. Every record answers the four questions ARCHITECTURE.md
requires of an architectural choice:

- **Why it exists**
- **What failure or problem it prevents**
- **How it scales**
- **What the future migration path is**

A decision is superseded by a new record, never by editing an old one.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-stack-and-plane-split.md) | React + NestJS control plane, Go data plane | Accepted |
| [0002](0002-prisma-owns-ddl.md) | Prisma owns all DDL; Go never migrates | Accepted |
| [0003](0003-postgres-as-the-queue.md) | PostgreSQL `SKIP LOCKED` is the MVP queue | Accepted |
| [0004](0004-ordering-deferred.md) | `ordering_key` stored, enforcement deferred | Accepted |
| [0005](0005-single-go-binary.md) | One `webhookd` binary, roles by subcommand | Accepted |
| [0006](0006-no-default-credentials.md) | No default account; bootstrap is explicit | Accepted |
| [0007](0007-tenant-fairness.md) | Tenant fairness is a per-project cap in the claim query | Accepted |
