# 0005 — One `webhookd` binary, roles selected by subcommand

Status: Accepted

## Decision

`ingest`, `router`, `scheduler` and `worker` are separate packages compiled into
one binary and selected at runtime: `webhookd worker`. Production runs them as
separate containers from the same image; `webhookd all` runs everything in one
process for development.

## Why it exists

ARCHITECTURE.md 4 asks for logical separation without unnecessary
microservices, and engineering rule 24 forbids splitting services to make a
diagram look impressive. One image means one build, one version, one set of
credentials to rotate — while the roles remain independently scalable, which is
the property that actually matters.

## What it prevents

- Four build pipelines and four image tags that can drift out of step.
- Version skew between components that share the same database schema.
- The developer setup tax of running four processes to see one event delivered.

## How it scales

Scaling is a replica count per role, exactly as if they were separate services:
`--scale worker=8` leaves one scheduler and one router untouched. The roles
share no in-process state, so nothing about the packaging constrains scaling.

## Migration path

Splitting into separate images is a Dockerfile target and a manifest change; the
Go packages are already independent. Do it when a role needs its own release
cadence or its own base image, not before.
