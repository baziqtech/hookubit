Absolutely. Below is a **single copy-paste prompt** you can give Claude. It contains the architecture, technology decisions, development rules, MVP scope, database approach, deployment model, and instructions for Claude to actually begin building rather than merely generating a design.

```text
You are the lead software architect and senior full-stack engineer responsible for designing and implementing a production-grade, multi-tenant webhook infrastructure platform similar in concept to Convoy.

The goal is to build a reliable webhook infrastructure product that can be offered as:

1. A hosted SaaS platform.
2. A self-hosted Docker/Kubernetes deployment.

The platform must be designed from the beginning for high reliability, horizontal scalability, security, observability, and multi-tenancy.

DO NOT treat this as a simple CRUD SaaS application. The webhook delivery engine is infrastructure software and must be designed around failure recovery, concurrency, backpressure, retries, idempotency, tenant isolation, and durable state.

==================================================
1. CORE ARCHITECTURAL DECISIONS
==================================================

These decisions are FINAL unless a compelling technical reason requires revisiting them.

Frontend:
- React
- TypeScript
- Vite
- React Router
- TanStack Query
- Zustand only where client-side state is genuinely needed
- React Hook Form
- Tailwind CSS
- Reusable internal UI component system

Control Plane:
- NestJS
- TypeScript
- Prisma
- PostgreSQL
- Redis

Data Plane:
- Go

Database:
- PostgreSQL

IMPORTANT:
PostgreSQL MUST NOT be bundled as a required production Docker container.

PostgreSQL is an external dependency.

The platform must support customer-provided PostgreSQL such as:
- AWS RDS/Aurora PostgreSQL
- Google Cloud SQL
- Azure Database for PostgreSQL
- Supabase
- Neon
- Self-managed PostgreSQL
- Other standard PostgreSQL deployments

Connection pooling:
- PgBouncer should be supported and recommended for production/high-concurrency deployments.

Cache/coordination:
- Redis

Redis must also be configurable as an external dependency.

For development convenience only, Docker Compose may include PostgreSQL and Redis.

Production Docker Compose MUST NOT require PostgreSQL to run inside the stack.

Object storage:
- S3-compatible object storage

Messaging:
- Start with Redis-based mechanisms where practical.
- Architect an abstraction that can later support:
  - AWS SQS
  - Kafka
  - NATS JetStream
  - Redis

Observability:
- OpenTelemetry
- Prometheus
- Grafana
- Loki or equivalent centralized logging

Deployment:
- Docker
- Docker Compose
- Kubernetes
- K3s
- Helm

CI/CD:
- GitHub Actions

==================================================
2. CONTROL PLANE VS DATA PLANE
==================================================

The most important architectural boundary is between the Control Plane and Data Plane.

CONTROL PLANE:

Responsible for:
- Authentication
- Users
- Organizations
- Teams
- RBAC
- Projects
- API keys
- Endpoint configuration
- Endpoint secrets
- Webhook subscriptions
- Retry policies
- Rate-limit configuration
- Billing
- Usage
- Audit logs
- Dashboard APIs
- Platform administration

Technology:
- NestJS
- Prisma
- PostgreSQL
- Redis

DATA PLANE:

Responsible for:
- Event ingestion
- Event persistence
- Event routing
- Subscription matching
- Delivery creation
- Scheduling
- Worker execution
- Retry processing
- Rate limiting
- Circuit breakers
- HTTP delivery
- Egress security
- Delivery state transitions

Technology:
- Go
- PostgreSQL
- Redis
- S3-compatible object storage
- Queue/broker abstraction

CRITICAL RULE:

NestJS MUST NOT be placed in the hot path for webhook delivery.

Do NOT build:

Customer → NestJS → Worker → Customer endpoint

Instead build:

Customer
    ↓
Go Ingest API
    ↓
PostgreSQL
    ↓
Queue/Scheduler
    ↓
Go Worker
    ↓
Go Egress
    ↓
Customer endpoint

NestJS manages configuration and business functionality.

Go handles the high-volume event/delivery pipeline.

==================================================
3. HIGH-LEVEL ARCHITECTURE
==================================================

Use this conceptual architecture:

                         ┌─────────────────────┐
                         │    React Dashboard  │
                         └──────────┬──────────┘
                                    │ HTTPS
                                    ▼
                         ┌─────────────────────┐
                         │      NestJS API     │
                         │    Control Plane    │
                         └──────────┬──────────┘
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                         ▼                     ▼
                 ┌───────────────┐     ┌──────────────┐
                 │  PostgreSQL   │     │    Redis     │
                 │ External DB   │     │ Cache/Coord. │
                 └───────┬───────┘     └──────┬───────┘
                         ▲                    ▲
                         │                    │
                         └────────┬───────────┘
                                  │
                           DATA PLANE
                                  │
                         ┌────────▼────────┐
                         │  Go Ingest API  │
                         └────────┬────────┘
                                  │
                                  ▼
                         Durable Event Store
                                  │
                                  ▼
                         ┌────────────────┐
                         │ Event Router   │
                         └───────┬────────┘
                                 │
                                 ▼
                         ┌────────────────┐
                         │   Scheduler    │
                         └───────┬────────┘
                                 │
                                 ▼
                         ┌────────────────┐
                         │ Go Workers     │
                         └───────┬────────┘
                                 │
                                 ▼
                         ┌────────────────┐
                         │ Go Egress      │
                         └───────┬────────┘
                                 │
                                 ▼
                         Customer Webhook
                            Endpoint


==================================================
4. MONOREPO
==================================================

Use a monorepo.

Recommended structure:

hookubit/
│
├── apps/
│   ├── dashboard/
│   │   ├── src/
│   │   ├── public/
│   │   └── tests/
│   │
│   └── control-api/
│       ├── src/
│       ├── prisma/
│       └── test/
│
├── services/
│   └── data-plane/
│       ├── ingest/
│       ├── router/
│       ├── scheduler/
│       ├── worker/
│       └── egress/
│
├── packages/
│   ├── api-client/
│   ├── types/
│   ├── contracts/
│   └── ui/
│
├── deployments/
│   ├── docker/
│   ├── compose/
│   ├── kubernetes/
│   └── helm/
│
├── docs/
│
├── scripts/
│
├── .github/
│   └── workflows/
│
└── README.md


Do not create unnecessary microservices.

The logical separation of components is important, but the first implementation can package some Go components together where that improves development and deployment simplicity.

The architecture must allow them to be separated later.

==================================================
5. FRONTEND
==================================================

Build the dashboard using:

- React
- TypeScript
- Vite
- React Router
- TanStack Query
- Zustand where needed
- React Hook Form
- Tailwind CSS

The dashboard is a standalone SPA.

Suggested structure:

apps/dashboard/

src/
├── app/
├── components/
├── features/
│   ├── auth/
│   ├── organizations/
│   ├── projects/
│   ├── endpoints/
│   ├── subscriptions/
│   ├── events/
│   ├── deliveries/
│   ├── api-keys/
│   ├── analytics/
│   ├── team/
│   ├── billing/
│   └── settings/
├── layouts/
├── routes/
├── hooks/
├── lib/
├── services/
└── types/

Use feature-oriented organization.

Do not put all components into one giant components folder.

The dashboard should feel like a professional developer infrastructure product.

Important pages:

Global:
- Login
- Register
- Forgot password
- Organization selection
- Organization settings
- Team
- Billing
- Usage
- Audit logs

Project:
- Overview
- Events
- Deliveries
- Endpoints
- Subscriptions
- API Keys
- Analytics
- Settings

Event:
- Event details
- Raw payload
- Matched endpoints
- Delivery statuses
- Timeline
- Replay

Delivery:
- Delivery details
- Attempts
- HTTP status
- Duration
- Response
- Error
- Retry information
- Replay

==================================================
6. NESTJS CONTROL API
==================================================

Use NestJS with modular architecture.

Suggested modules:

src/
├── auth/
├── users/
├── organizations/
├── memberships/
├── roles/
├── projects/
├── api-keys/
├── endpoints/
├── endpoint-secrets/
├── webhook-subscriptions/
├── retry-policies/
├── rate-limits/
├── events/
├── deliveries/
├── analytics/
├── usage/
├── billing/
├── audit/
├── admin/
├── health/
├── common/
└── infrastructure/

Each domain should contain its own:
- controller
- service
- DTOs
- guards/policies where applicable
- repository/data access logic where appropriate
- tests

Use dependency injection properly.

Avoid putting business logic inside controllers.

Controllers should be thin.

==================================================
7. API CONTRACT
==================================================

NestJS must expose OpenAPI documentation.

The frontend API client should be generated from OpenAPI.

Preferred architecture:

NestJS
   ↓
OpenAPI
   ↓
Generated TypeScript API client
   ↓
React

Do not manually duplicate API request/response types throughout the frontend.

Version the public API from the beginning:

/v1/

Example public ingestion API:

POST /v1/projects/{project_id}/events

Headers:

Authorization: Bearer <api-key>
Idempotency-Key: <unique-key>
Content-Type: application/json

Request:

{
  "event_type": "order.created",
  "data": {
    "order_id": "ord_123",
    "amount": 120.50
  }
}

Response:

{
  "id": "evt_01...",
  "status": "accepted"
}

The API must return after durable event persistence.

Do not wait for webhook delivery.

==================================================
8. MULTI-TENANCY
==================================================

Hierarchy:

Organization
    ↓
Project
    ↓
Endpoints
    ↓
Subscriptions
    ↓
Events
    ↓
Deliveries

Every tenant-owned resource must be properly scoped.

At minimum use:

organization_id
project_id

All queries must enforce tenant ownership.

Never trust organization_id/project_id provided by a client without authorization validation.

Initial SaaS model:

Shared PostgreSQL database
Shared schema
Tenant isolation through organization_id/project_id

The architecture must allow future dedicated database per enterprise tenant.

==================================================
9. AUTHENTICATION
==================================================

Implement:

- Registration
- Login
- Logout
- Email verification
- Password reset
- Session management

Use secure password hashing.

Prefer secure HTTP-only cookies for browser sessions where appropriate.

Do not store sensitive long-lived authentication credentials in localStorage.

Future features:
- MFA
- OIDC
- SAML
- Enterprise SSO

==================================================
10. RBAC
==================================================

Initial roles:

Owner
Admin
Developer
Viewer
Billing

Permissions should be explicit.

Examples:

projects.read
projects.write

endpoints.read
endpoints.write

events.read
events.replay

deliveries.read
deliveries.replay

members.read
members.write

billing.read
billing.write

Do not scatter authorization logic throughout controllers.

Use centralized NestJS guards/policies.

==================================================
11. API KEYS
==================================================

API keys are used for server-to-server event ingestion.

Requirements:

- Prefix keys for identification
- Hash keys where possible
- Support expiration
- Support revocation
- Support scopes
- Show secret only once after creation
- Never log complete keys

Example:

wk_live_...
wk_test_...

==================================================
12. CORE DATABASE MODEL
==================================================

Use PostgreSQL.

Initial tables:

organizations
users
organization_members
projects
api_keys
endpoints
endpoint_secrets
webhook_subscriptions
events
event_outbox
deliveries
delivery_attempts
retry_policies
rate_limit_policies
audit_logs
usage_records
plans
billing_subscriptions

Avoid ambiguous naming between webhook subscriptions and billing subscriptions.

==================================================
13. DATABASE SCHEMA
==================================================

organizations:

id
name
slug
status
plan_id
created_at
updated_at


organization_members:

id
organization_id
user_id
role
created_at
updated_at


projects:

id
organization_id
name
slug
environment
status
created_at
updated_at


api_keys:

id
project_id
name
key_hash
key_prefix
scopes
environment
expires_at
last_used_at
revoked_at
created_at
updated_at


endpoints:

id
project_id
name
url
status
enabled
timeout_ms
max_concurrency
rate_limit
created_at
updated_at


endpoint_secrets:

id
endpoint_id
secret_encrypted
version
active
created_at
expires_at
rotated_at


webhook_subscriptions:

id
project_id
endpoint_id
event_filter
enabled
created_at
updated_at


events:

id
organization_id
project_id
event_type
idempotency_key
payload
payload_location
payload_size
status
created_at
processed_at


event_outbox:

id
event_id
type
status
attempts
available_at
processed_at
created_at


deliveries:

id
event_id
endpoint_id
status
attempt_count
next_attempt_at
last_attempt_at
completed_at
ordering_key
created_at
updated_at


delivery_attempts:

id
delivery_id
attempt_number
started_at
completed_at
status
http_status
response_headers
response_body
error_code
error_message
duration_ms
created_at


audit_logs:

id
organization_id
user_id
action
resource_type
resource_id
metadata
ip_address
created_at


Use UUID/ULID-style IDs consistently.

Prefer sortable opaque identifiers such as:

org_...
proj_...
evt_...
del_...
ep_...

where appropriate.

==================================================
14. POSTGRESQL IS THE SOURCE OF TRUTH
==================================================

This is one of the most important rules.

PostgreSQL is the durable source of truth.

Redis is NOT the authoritative event store.

If Redis disappears, the platform must be able to recover durable event and delivery state from PostgreSQL.

Accepted events must never depend solely on Redis persistence.

==================================================
15. TRANSACTIONAL OUTBOX
==================================================

Implement the transactional outbox pattern.

Do NOT do:

INSERT event
COMMIT
then
PUBLISH TO REDIS

as the only durability mechanism.

Instead:

BEGIN TRANSACTION

INSERT event

INSERT outbox record

COMMIT

Then an asynchronous processor reads the outbox.

This prevents event loss when the application crashes between the database transaction and queue publishing.

Use PostgreSQL locking techniques such as:

FOR UPDATE SKIP LOCKED

where appropriate.

Outbox processing must be safe to retry.

==================================================
16. EVENT ACCEPTANCE
==================================================

Flow:

Customer
    ↓
Go Ingest API
    ↓
Authenticate API key
    ↓
Resolve project
    ↓
Validate request
    ↓
Apply rate limits
    ↓
Check idempotency
    ↓
BEGIN TRANSACTION
    ↓
Persist event
    ↓
Persist outbox record
    ↓
COMMIT
    ↓
Return accepted
    ↓
Asynchronous processing

The ingestion response must NOT wait for webhook delivery.

Once the response says:

accepted

the event must be durably recoverable.

==================================================
17. IDEMPOTENCY
==================================================

Support:

Idempotency-Key

Example:

Idempotency-Key: order_123_created_v1

Store enough information to determine whether a repeated request represents the same operation.

Repeated requests with the same valid key should resolve to the existing event rather than silently create another event.

Store:
- project
- idempotency key
- request hash
- event ID
- expiration

Handle conflicting reuse of an idempotency key safely.

==================================================
18. EVENT ROUTING
==================================================

An event can be delivered to multiple endpoints.

Example:

Event:
evt_123

Subscriptions:

Endpoint A
Endpoint B
Endpoint C

Router creates:

Delivery evt_123 → Endpoint A
Delivery evt_123 → Endpoint B
Delivery evt_123 → Endpoint C

Each delivery has an independent lifecycle.

One endpoint failing must never cause another endpoint's delivery to fail.

==================================================
19. DELIVERY STATE MACHINE
==================================================

Use explicit states.

Event states:

received
processing
processed
failed

Delivery states:

pending
scheduled
queued
processing
succeeded
failed
retrying
exhausted
cancelled

Do not represent important lifecycle state using a collection of ambiguous boolean fields.

Every state transition should have a clear reason.

==================================================
20. AT-LEAST-ONCE DELIVERY
==================================================

The platform guarantees:

AT-LEAST-ONCE DELIVERY

Do NOT promise exactly-once delivery.

External HTTP systems cannot guarantee exactly-once semantics.

Customers must be encouraged to use the delivery/event ID for deduplication.

The platform should make the delivery ID available in headers and dashboard records.

==================================================
21. RETRY ENGINE
==================================================

Implement configurable retry policies.

Use:

- Exponential backoff
- Jitter
- Maximum attempts
- Maximum retry duration
- Configurable delays

Example:

Attempt 1
→ immediate

Attempt 2
→ +5 seconds

Attempt 3
→ +30 seconds

Attempt 4
→ +2 minutes

Attempt 5
→ +10 minutes

These are examples only.

Do not hard-code them permanently.

Retry generally for:

- Connection failures
- DNS failures
- TLS failures
- Timeouts
- HTTP 408
- HTTP 429
- HTTP 5xx

By default, most 4xx responses should not be retried unless configured.

==================================================
22. SCHEDULER
==================================================

The scheduler identifies deliveries that are ready.

Important fields:

next_attempt_at
status
attempt_count

Scheduler must handle:

- delayed retries
- worker crashes
- abandoned jobs
- duplicate scheduling
- clock issues
- concurrency

Do not rely solely on in-memory timers.

If the scheduler process crashes, retry work must still be recoverable.

==================================================
23. WORKER SYSTEM
==================================================

Workers must be horizontally scalable.

Example:

Worker 1
Worker 2
Worker 3
Worker 4
...

Each worker should safely acquire jobs without processing the same delivery concurrently unless intentional.

Use database locking/queue semantics.

Worker pools must be bounded.

Do not spawn unlimited goroutines.

Every resource must have limits.

==================================================
24. TENANT FAIRNESS
==================================================

Prevent noisy neighbors.

Use multiple levels:

Global
 ↓
Organization
 ↓
Project
 ↓
Endpoint

Support:

- global concurrency
- organization concurrency
- project concurrency
- endpoint concurrency
- endpoint rate limits

A single tenant must not consume all worker capacity.

Implement fair/weighted scheduling where appropriate.

==================================================
25. RATE LIMITING
==================================================

Support:

- Ingestion rate limits
- Organization rate limits
- Project rate limits
- Endpoint rate limits
- Global limits

Redis can be used for distributed rate limiting.

Use a robust algorithm such as token bucket.

Rate-limit values should be configurable.

==================================================
26. CIRCUIT BREAKERS
==================================================

Endpoints should have health state.

Conceptual states:

healthy
 ↓
degraded
 ↓
open
 ↓
half-open
 ↓
healthy

If an endpoint repeatedly fails:

- reduce delivery pressure
- stop wasting workers
- delay further attempts
- probe periodically

Circuit-breaker state may live in Redis.

Important delivery state remains recoverable in PostgreSQL.

==================================================
27. ORDERING
==================================================

Do NOT promise global ordering.

Support optional ordering keys.

Example:

ordering_key = customer_123

When ordering is enabled for a key:

event 1
event 2
event 3

must not be delivered out of order.

Ordering should be opt-in because strict ordering reduces concurrency.

==================================================
28. WEBHOOK SIGNING
==================================================

Implement HMAC signing.

Recommended conceptual format:

Webhook-Signature:
t=<timestamp>,v1=<signature>

The signature should cover:

timestamp + "." + raw_payload

Use:

HMAC-SHA256

The signing implementation must operate on the exact raw payload bytes.

Support secret rotation.

Allow overlapping old/new secrets during rotation.

Never log secrets.

==================================================
29. REPLAY PROTECTION
==================================================

Include timestamp in signatures.

Customers should be able to reject old webhook requests.

Allow configurable tolerance.

==================================================
30. EGRESS SECURITY
==================================================

The Go egress layer is security-critical.

Protect against SSRF.

Block:

- localhost
- loopback IPv4
- loopback IPv6
- private IPv4 ranges
- private IPv6 ranges
- link-local addresses
- cloud metadata endpoints
- unsafe redirect destinations
- unsupported protocols

Only allow:

http
https

unless future features explicitly support more.

Validate DNS resolution.

Validate resolved IP addresses.

Protect against DNS rebinding.

Every redirect destination must be validated again.

Do not blindly follow redirects.

==================================================
31. OUTBOUND HTTP LIMITS
==================================================

Every outbound request must have explicit limits.

Configure:

- DNS timeout
- connection timeout
- TLS handshake timeout
- request/write timeout
- response header timeout
- overall timeout
- maximum response body size
- maximum headers
- maximum payload size

Never allow unbounded network operations.

==================================================
32. PAYLOAD STORAGE
==================================================

Small event payloads can be stored in PostgreSQL JSONB.

Large payloads should use:

PostgreSQL metadata
+
S3-compatible object storage

Store:

payload_size
payload_location

Define a configurable payload threshold.

Do not allow unlimited event size.

==================================================
33. DELIVERY ATTEMPTS
==================================================

Every attempt should record:

- attempt number
- start time
- end time
- duration
- HTTP status
- response headers
- bounded response body
- network error
- timeout
- error code

Response bodies must have a maximum size.

Large responses should be stored in object storage if necessary.

==================================================
34. REPLAY
==================================================

Support:

- Replay one delivery
- Replay event to one endpoint
- Replay event to all originally matched endpoints

Do not overwrite original delivery history.

Replay should create a new delivery/replay operation.

The original delivery remains immutable.

==================================================
35. DATABASE PERFORMANCE
==================================================

Use PostgreSQL carefully.

Use:

- proper indexes
- transactions
- foreign keys
- JSONB only when appropriate
- partial indexes
- query optimization
- connection pooling
- PgBouncer

Potential future partition candidates:

events
deliveries
delivery_attempts
audit_logs
usage_records

Do not partition everything immediately.

Partition based on actual scale and access patterns.

==================================================
36. POSTGRESQL DEPLOYMENT
==================================================

Production architecture:

Application
    ↓
PgBouncer
    ↓
External PostgreSQL

The application must never assume:

localhost:5432

Do not assume:

postgres:5432

The database host must come from configuration.

Example:

DATABASE_URL=postgresql://...

or:

DB_HOST
DB_PORT
DB_DATABASE
DB_USERNAME
DB_PASSWORD
DB_SSL_MODE

Support TLS.

==================================================
37. REDIS DEPLOYMENT
==================================================

Redis should be configurable through:

REDIS_URL

Development can use:

docker-compose.dev.yml

Production can use:

- ElastiCache
- Redis Cloud
- managed Redis
- customer-managed Redis

Do not make Redis the only durable store.

==================================================
38. SELF-HOSTED DEPLOYMENT
==================================================

Self-hosted production must look conceptually like:

Customer Infrastructure

Docker/Kubernetes:
- React Dashboard
- NestJS Control API
- Go Ingest
- Go Router
- Go Scheduler
- Go Workers
- Go Egress
- Redis optional

        ↓

Customer PostgreSQL

The customer supplies PostgreSQL.

The installation process should be:

1. Provision PostgreSQL.
2. Provide DATABASE_URL.
3. Optionally provide Redis.
4. Configure secrets.
5. Run migrations.
6. Start containers.

Example:

cp .env.example .env

docker compose up -d

The platform must NOT silently create a second database.

==================================================
39. DEVELOPMENT DOCKER
==================================================

Development may provide:

docker-compose.dev.yml

Services:

- postgres
- redis

This is for local development/testing only.

Production documentation must clearly distinguish development from production.

==================================================
40. PRODUCTION CONTAINERS
==================================================

Containers must be stateless.

Use multi-stage builds.

Go:

builder
 ↓
compile
 ↓
minimal runtime image

NestJS:

builder
 ↓
install dependencies
 ↓
build
 ↓
production runtime

React:

build static assets
 ↓
serve through suitable web server/CDN

Containers must not rely on persistent local files.

==================================================
41. DATABASE MIGRATIONS
==================================================

Migrations must be:

- versioned
- deterministic
- tested
- observable

Production migrations should run through a dedicated migration command/job.

Do not automatically run destructive migrations when the application starts.

Migration process should be explicit.

==================================================
42. CONFIGURATION
==================================================

Example:

APP_ENV=production

DATABASE_URL=

REDIS_URL=

S3_ENDPOINT=
S3_BUCKET=
S3_REGION=
S3_ACCESS_KEY=
S3_SECRET_KEY=

JWT_SECRET=

ENCRYPTION_KEY=

OTEL_EXPORTER_OTLP_ENDPOINT=

LOG_LEVEL=info

Never commit secrets.

Support external secret management.

Potential systems:

- AWS Secrets Manager
- HashiCorp Vault
- Kubernetes Secrets
- Cloud secret managers

==================================================
43. SECRET MANAGEMENT
==================================================

Protect:

- API keys
- endpoint signing secrets
- database credentials
- JWT/session secrets
- encryption keys

Never log secrets.

Use encryption at rest where appropriate.

Endpoint signing secrets should be encrypted.

API key secrets should preferably be stored as hashes when only verification is required.

==================================================
44. OBSERVABILITY
==================================================

Implement OpenTelemetry.

Trace:

HTTP ingestion
 ↓
DB transaction
 ↓
outbox
 ↓
router
 ↓
scheduler
 ↓
worker
 ↓
egress
 ↓
customer HTTP endpoint

Use Prometheus metrics.

Important metrics:

events_ingested_total
events_ingestion_failed_total

deliveries_created_total
deliveries_succeeded_total
deliveries_failed_total
deliveries_retried_total

delivery_latency_seconds
delivery_attempt_latency_seconds

queue_depth
worker_active_count

http_2xx_total
http_4xx_total
http_5xx_total

rate_limit_hits_total
circuit_breaker_open_total

postgres_query_latency
postgres_connections

redis_latency

Do NOT use high-cardinality values such as event IDs as Prometheus labels.

==================================================
45. LOGGING
==================================================

Use structured JSON logging.

Example:

{
  "level": "info",
  "service": "delivery-worker",
  "event": "delivery.completed",
  "delivery_id": "del_123",
  "endpoint_id": "ep_123",
  "status": 200,
  "duration_ms": 241
}

Never log:

- passwords
- API secrets
- signing secrets
- authorization headers
- database credentials

Do not log complete payloads by default.

==================================================
46. HEALTH CHECKS
==================================================

Every service exposes:

/health/live
/health/ready

Liveness:

"Is the process alive?"

Readiness:

"Can this service safely receive work?"

Liveness should NOT depend on PostgreSQL being available.

Readiness may verify required dependencies.

==================================================
47. GRACEFUL SHUTDOWN
==================================================

Every service must support graceful shutdown.

On SIGTERM:

1. Stop accepting new work.
2. Stop acquiring new jobs.
3. Finish safe in-flight work.
4. Release locks.
5. Close connections.
6. Flush telemetry.
7. Exit.

Configure Kubernetes termination grace periods appropriately.

==================================================
48. ERROR MODEL
==================================================

Public APIs should return consistent errors.

Example:

{
  "error": {
    "code": "invalid_request",
    "message": "event_type is required",
    "request_id": "req_123"
  }
}

Use stable machine-readable error codes.

==================================================
49. AUDIT LOGGING
==================================================

Audit important actions:

- login
- logout
- API key creation
- API key revocation
- endpoint creation
- endpoint deletion
- endpoint secret rotation
- project changes
- subscription changes
- member changes
- role changes
- replay
- billing changes
- administrative changes

Audit logs should be append-oriented.

==================================================
50. BILLING AND USAGE
==================================================

Design usage tracking for:

- events ingested
- deliveries
- delivery attempts
- data volume
- endpoint count
- retention
- replay volume
- advanced features

Do not put expensive usage aggregation inside the hot ingestion transaction.

Record usage asynchronously.

==================================================
51. RETENTION
==================================================

Make retention configurable.

Example only:

Free:
7 days

Starter:
30 days

Growth:
90 days

Enterprise:
custom

These values must be configuration/business rules, not hard-coded into the engine.

Retention jobs should clean:

- old events
- old deliveries
- old attempts
- old payload objects
- old audit/usage data according to policy

==================================================
52. HOSTED SAAS
==================================================

The hosted platform should eventually run on cloud infrastructure.

Conceptual:

Internet
   ↓
Load Balancer
   ↓
React CDN

Control plane:

React
 ↓
NestJS
 ↓
PostgreSQL

Data plane:

Go Ingest
 ↓
Router
 ↓
Scheduler
 ↓
Workers
 ↓
Egress
 ↓
Customer endpoints

Infrastructure may use:

- Managed PostgreSQL
- PgBouncer
- Managed Redis
- S3
- SQS/Kafka later
- Kubernetes/EKS when justified

Do not introduce Kubernetes or Kafka simply because they are popular.

==================================================
53. SCALING STRATEGY
==================================================

Stage 1:

React
NestJS
Go
PostgreSQL
Redis
S3

Stage 2:

PgBouncer
Read replicas
Partitioning
Worker autoscaling
Tenant fairness
Improved scheduling

Stage 3:

SQS/Kafka/NATS
Dedicated worker pools
Advanced routing
Static egress
Regional infrastructure

Stage 4:

Multi-region
Regional data planes
Global routing
Advanced analytics store
Dedicated tenant databases
Enterprise networking

Do not implement Stage 3/4 infrastructure during MVP unless required.

==================================================
54. CONTROL PLANE AVAILABILITY
==================================================

Already accepted webhook events must not disappear just because NestJS is unavailable.

Data plane should continue operating using durable state and cached configuration where possible.

Avoid:

Go Worker
   ↓
Synchronous NestJS request
   ↓
Deliver webhook

Instead:

Go Worker
   ↓
PostgreSQL/cache/configuration
   ↓
Deliver webhook

The control plane configures the system.

The data plane executes the system.

==================================================
55. CONFIGURATION CACHE
==================================================

Data plane may cache:

- endpoint URL
- endpoint secret
- timeout
- retry policy
- rate limit
- subscription filter
- circuit-breaker configuration

Cache invalidation should be:

- event-driven where possible
- time-bounded

Never allow stale configuration indefinitely.

==================================================
56. INTERNAL DATA PLANE CONTRACTS
==================================================

Define clear contracts between components.

Example delivery job:

{
  "delivery_id": "del_123",
  "event_id": "evt_123",
  "endpoint_id": "ep_123",
  "attempt": 1,
  "scheduled_at": "2026-09-06T12:00:00Z"
}

Prefer identifiers rather than placing complete payloads into queue messages.

Worker retrieves required state from PostgreSQL/cache/object storage.

==================================================
57. FAILURE RECOVERY
==================================================

The system must assume that processes and networks fail.

Explicitly handle:

1. Ingest crashes before DB commit.
2. Ingest crashes after DB commit.
3. Worker crashes before delivery.
4. Worker crashes during delivery.
5. Worker crashes after HTTP response but before DB update.
6. Scheduler crashes.
7. Redis becomes unavailable.
8. PostgreSQL becomes unavailable.
9. Queue becomes unavailable.
10. Customer endpoint times out.
11. Customer endpoint returns 500.
12. Customer endpoint returns 429.
13. DNS resolution fails.
14. DNS resolves to private IP.
15. Endpoint redirects to private IP.
16. DNS changes after initial validation.
17. Two workers attempt same delivery.
18. Database connection pool is exhausted.
19. Tenant creates huge burst.
20. Endpoint becomes permanently unhealthy.

Every scenario needs a defined recovery strategy.

==================================================
58. TESTING
==================================================

Unit tests:

- retry calculation
- idempotency
- routing
- HMAC signing
- signature verification
- rate limiting
- circuit breakers
- authorization
- validation
- state transitions

Integration tests:

- PostgreSQL
- Redis
- transactional outbox
- concurrent workers
- delivery persistence
- retry persistence
- duplicate ingestion
- worker recovery

End-to-end:

API
 ↓
PostgreSQL
 ↓
queue
 ↓
worker
 ↓
test webhook server

Load testing:

Use k6 or equivalent.

Test:

- high ingestion
- high fan-out
- slow endpoints
- failing endpoints
- high retry volume
- many tenants
- large payloads

==================================================
59. SECURITY TESTING
==================================================

Explicitly test SSRF against:

- localhost
- 127.0.0.1
- ::1
- RFC1918 ranges
- link-local ranges
- metadata services
- DNS rebinding
- malicious redirects

Also test:

- authentication bypass
- authorization bypass
- tenant data leakage
- API key abuse
- replay
- rate-limit bypass
- secret exposure
- injection
- malformed payloads
- oversized requests

==================================================
60. MVP
==================================================

Build the following first.

AUTH:
- Registration
- Login
- Logout
- Email verification
- Password reset

ORGANIZATIONS:
- Create organization
- Invite members
- RBAC

PROJECTS:
- Create project
- Environment
- API keys

ENDPOINTS:
- Create
- Update
- Enable/disable
- Delete
- Secret rotation
- Test endpoint

SUBSCRIPTIONS:
- Event filters
- Endpoint subscriptions

INGESTION:
- API key authentication
- Validation
- Idempotency
- Durable event storage
- Transactional outbox

DELIVERY:
- Routing
- HTTP delivery
- Timeouts
- Retry
- Backoff
- Attempts
- Delivery status

DASHBOARD:
- Overview
- Events
- Deliveries
- Endpoint management
- Delivery details
- Replay

SECURITY:
- HMAC
- SSRF protection
- Rate limiting
- RBAC
- Audit logging

OPERATIONS:
- Health checks
- Metrics
- Structured logging
- Docker
- External PostgreSQL
- External Redis support

==================================================
61. DO NOT BUILD YET
==================================================

Do not block MVP on:

- Kafka
- Multi-region
- ClickHouse
- Enterprise SSO
- SAML
- Static egress IP
- Private network connectors
- Dedicated tenant databases
- Advanced workflow transformations
- WASM
- Global routing
- Complex analytics infrastructure

Design interfaces that allow them later.

Do not implement unnecessary complexity now.

==================================================
62. DEVELOPMENT PHASES
==================================================

PHASE 1 — FOUNDATION

1. Create monorepo.
2. Set up React/Vite.
3. Set up NestJS.
4. Set up Go workspace.
5. Set up shared TypeScript packages.
6. Set up linting.
7. Set up formatting.
8. Set up tests.
9. Set up development Docker Compose.
10. Configure PostgreSQL.
11. Configure Redis.
12. Create base CI pipeline.

PHASE 2 — CONTROL PLANE

1. Users
2. Authentication
3. Organizations
4. Memberships
5. RBAC
6. Projects
7. API keys
8. Endpoints
9. Endpoint secrets
10. Subscriptions
11. Retry policies
12. Rate limits

PHASE 3 — DATA PLANE

1. Go Ingest
2. Event model
3. Idempotency
4. Transactional outbox
5. Router
6. Delivery creation
7. Scheduler
8. Workers
9. Retry engine
10. Attempts
11. State transitions

PHASE 4 — SECURITY

1. HMAC
2. Secret rotation
3. SSRF protection
4. Rate limiting
5. Circuit breakers
6. Payload limits
7. Audit logs

PHASE 5 — DASHBOARD

1. Overview
2. Events
3. Deliveries
4. Endpoints
5. Subscriptions
6. Delivery details
7. Attempts
8. Replay
9. Analytics
10. Team
11. Settings

PHASE 6 — PRODUCTION HARDENING

1. OpenTelemetry
2. Prometheus
3. Grafana dashboards
4. Structured logs
5. Graceful shutdown
6. Health probes
7. Load tests
8. Failure tests
9. Production Docker
10. Kubernetes
11. Helm
12. Migration jobs
13. Backup documentation

==================================================
63. DEFINITION OF DONE
==================================================

MVP is NOT complete merely because:

"webhooks can be sent."

MVP is complete only when:

- Accepted events survive process crashes.
- Duplicate ingestion is handled safely.
- Multiple workers cannot corrupt delivery state.
- Failed endpoints retry automatically.
- Retry state survives worker restarts.
- Delivery history is preserved.
- Replay does not destroy original history.
- One tenant cannot starve others.
- SSRF protection works.
- Secrets are protected.
- PostgreSQL is external.
- Redis can be external.
- Containers are stateless.
- Metrics exist.
- Structured logs exist.
- Health endpoints exist.
- Load testing has been performed.
- Failure scenarios have been tested.
- The platform can run without PostgreSQL inside Docker.
- The system can be destroyed and recreated against the same external PostgreSQL and recover its state.

==================================================
64. ENGINEERING RULES
==================================================

These rules are mandatory.

1. Reliability over convenience.

2. Do not use Redis as the sole durable event store.

3. PostgreSQL is the source of truth.

4. Do not put PostgreSQL inside production Docker.

5. Do not make NestJS part of the hot webhook delivery path.

6. Go services must be stateless.

7. Assume every process can crash at any point.

8. Assume every network can fail.

9. Assume customer webhook endpoints are unreliable.

10. Assume customer endpoints may be malicious.

11. Bound every resource:
    - payload size
    - response size
    - concurrency
    - goroutines
    - retries
    - DB connections
    - queue depth
    - memory

12. Never log secrets.

13. Never silently swallow errors.

14. Use explicit state machines.

15. Use database transactions for critical state transitions.

16. Make worker operations safe to retry.

17. Public APIs must be versioned.

18. Avoid breaking API contracts.

19. Add tests for reliability-critical behavior.

20. Use migrations for schema changes.

21. Do not perform destructive migrations automatically.

22. Keep infrastructure abstractions replaceable.

23. Do not introduce Kafka without a real requirement.

24. Do not introduce microservices merely to make architecture diagrams look impressive.

25. Prefer a small number of well-defined services.

26. Design for horizontal scaling.

27. Prefer asynchronous processing for expensive operations.

28. Do not perform synchronous delivery from the ingestion API.

29. Never allow unbounded outbound HTTP requests.

30. Never trust customer-provided URLs without SSRF validation.

31. Do not promise exactly-once delivery.

32. Do not promise global event ordering.

33. Do not make control-plane availability a prerequisite for already accepted delivery work.

34. Customer data must survive complete application/container replacement.

==================================================
65. CODING STYLE
==================================================

NestJS:

- Use modules by business domain.
- Thin controllers.
- Business logic in services.
- DTO validation.
- Guards/policies for authorization.
- Strong TypeScript types.
- Avoid any unless absolutely necessary.
- Use Prisma for persistence.
- Use transactions for multi-step state changes.

Go:

- Keep services simple.
- Favor explicit error handling.
- Avoid unnecessary abstractions.
- Use context.Context for request cancellation/deadlines.
- Use structured logging.
- Use bounded worker pools.
- Make concurrency explicit.
- Use pgx for PostgreSQL.
- Use interfaces at infrastructure boundaries, not everywhere.

React:

- Feature-oriented architecture.
- TanStack Query for server state.
- Avoid unnecessary global state.
- Reusable components.
- Accessible UI.
- Strong TypeScript types.
- API client generated from OpenAPI.

==================================================
66. INITIAL DEVELOPMENT BEHAVIOR
==================================================

Do not immediately generate thousands of lines of code.

First:

1. Create the repository structure.
2. Create architecture documentation.
3. Create environment configuration.
4. Create database schema.
5. Create initial migrations.
6. Create service skeletons.
7. Create CI.
8. Create development Docker Compose.
9. Create health endpoints.
10. Create basic authentication.
11. Create organization/project model.
12. Create endpoint model.
13. Create ingestion path.
14. Implement transactional outbox.
15. Implement delivery pipeline.
16. Add tests continuously.

After each major phase, verify that the project builds and tests pass.

==================================================
67. IMPORTANT ARCHITECTURAL PRINCIPLE
==================================================

The most important principle of this entire platform is:

"Containers are disposable. Customer data is not."

A customer should be able to:

1. Delete every application container.
2. Reinstall the application.
3. Point it at the same PostgreSQL database.
4. Restore access to their events, endpoints, deliveries, configurations, and history.

Therefore:

PostgreSQL = durable state

Redis = cache/coordination

S3 = large/archived payloads

Containers = disposable compute

==================================================
68. FINAL TECHNOLOGY STACK
==================================================

Frontend:
React
TypeScript
Vite
React Router
TanStack Query
Zustand
React Hook Form
Tailwind CSS

Control Plane:
NestJS
TypeScript
Prisma

Data Plane:
Go
pgx

Database:
PostgreSQL
External/managed

Connection Pool:
PgBouncer

Cache:
Redis
External or optional self-hosted

Object Storage:
S3-compatible

Messaging:
Redis initially
SQS/Kafka/NATS later

Observability:
OpenTelemetry
Prometheus
Grafana
Loki

Deployment:
Docker
Docker Compose
Kubernetes
K3s
Helm

CI/CD:
GitHub Actions

==================================================
69. YOUR FIRST TASK
==================================================

Begin by creating the project foundation.

Do NOT jump directly into implementing every feature.

First produce:

1. Final repository structure.
2. Architecture decision record.
3. Database ERD/model description.
4. Initial PostgreSQL schema.
5. NestJS module structure.
6. Go service structure.
7. React feature structure.
8. Docker development setup.
9. External PostgreSQL configuration.
10. External Redis configuration.
11. Environment variable specification.
12. Initial CI pipeline.
13. Initial API contract.
14. Initial development roadmap.

Then begin implementation in Phase 1.

For every architectural decision, explain:
- Why it exists.
- What failure/problem it prevents.
- How it scales.
- What the future migration path is.

When there are multiple reasonable implementation choices, prefer the simplest production-grade option that preserves the architecture.

Do not over-engineer.

Do not sacrifice reliability for simplicity.

The final result must be capable of evolving from an MVP into a serious webhook infrastructure platform.

Create a document to keep track of development so any ai model can continue development from in the future.
```
