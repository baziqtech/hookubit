# 0001 — React + NestJS control plane, Go data plane

Status: Accepted

## Decision

The control plane is NestJS + Prisma + PostgreSQL. The data plane is Go + pgx.
The dashboard is React/Vite consuming a client generated from the control
plane's OpenAPI document. NestJS is never in the webhook delivery hot path.

## Why it exists

Delivery and configuration have opposite shapes. Configuration is CRUD over a
relational model with rich authorization — a framework with modules, DI,
validation and generated OpenAPI pays for itself. Delivery is tens of thousands
of concurrent, mostly-idle outbound HTTP calls with per-tenant concurrency
ceilings — a goroutine-per-attempt runtime with explicit bounded pools pays for
itself, and a request/response framework does not.

## What it prevents

- **A slow endpoint stalling unrelated work.** Per-endpoint concurrency needs
  cheap concurrency primitives; a shared request-worker pool starves.
- **Control-plane availability becoming a delivery prerequisite.** With NestJS
  out of the hot path, deploying, restarting or breaking the control plane
  cannot stop already-accepted deliveries (ARCHITECTURE.md 54).
- **Duplicated API types.** The dashboard's types are generated, so a contract
  change surfaces at compile time rather than at runtime.

## How it scales

The two planes scale on different axes. Throughput is the worker count; the
control plane sizes to human and API traffic and can sit at one or two replicas
while workers scale to dozens.

## Migration path

The plane boundary is the durable schema plus the queue interface, not a
language. Either side can be replaced without touching the other; that is the
point of putting the boundary in PostgreSQL.
