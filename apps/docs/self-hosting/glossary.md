# Glossary

Operator vocabulary, in the sense these pages use it.

| Term | Meaning |
|---|---|
| **Control plane** | The REST API and dashboard: organizations, projects, endpoints, subscriptions, policies, the delivery log, mail. Never in the delivery hot path; can be down without stopping deliveries. |
| **Data plane** | The Go binary that accepts, routes, retries and sends. Four roles from one image. |
| **Ingest** | The data-plane role that accepts `POST .../events` and writes the event durably. A `202` means stored, not delivered. The public write path, on port 8080. |
| **Router** | The data-plane role that turns one stored event into one delivery row per matching subscription (the fan-out). |
| **Scheduler** | The singleton data-plane role that promotes due retries, sweeps the ledger (retention), sweeps orphan payloads and refreshes the queue-depth gauge. |
| **Worker** | The data-plane role that claims delivery rows, decrypts the endpoint's signing secret, signs and sends. The throughput dial. |
| **Event** | One published message. Stored once. |
| **Outbox** | The table of accepted events not yet fanned out. `outbox_pending_age_seconds` is how far behind the router is. A **parked** outbox row is an event that will not fan out until an operator requeues it. |
| **Delivery** | One row per (event, endpoint): the record of what should be delivered, written before any attempt is made. Has its own retry chain and terminal state (`succeeded`, `failed`, `exhausted`, `cancelled`). |
| **Attempt** | One outbound HTTP call for a delivery, with request headers, response status, truncated body, duration and trace id. |
| **Materialised fan-out** | Writing N delivery rows for an event with N matching subscriptions, rather than computing recipients at send time. What makes per-endpoint replay and "did finance ever get this" possible. |
| **Lease** | A worker's claim on a delivery, `DELIVERY_LEASE_SECONDS` long. A lapsed lease makes the row claimable by another worker; that is how a dead worker's work resumes. |
| **Ready set** | Delivery rows due now and not leased. `queue_depth{state="ready"}` growing while attempts stay flat is the one visible sign of work that is not happening. |
| **Head-of-line delay** | Time a ready delivery waits before being claimed. The measurement that shows tenant starvation. |
| **Exhausted** | A delivery that used its whole retry budget. It will not be attempted again without a manual replay. |
| **Replay** | Re-delivering an event to an endpoint by creating a new delivery row. Consumers see a duplicate; they must be idempotent. |
| **Circuit breaker** | Per-endpoint state machine: consecutive failures open it, deliveries are held without attempts while open, a half-open probe tests recovery. `circuit_breaker_open_total` counts openings; there is no gauge of breakers currently open. |
| **Auto-disable** | The control plane disabling an endpoint whose breaker has been continuously open for `ENDPOINT_AUTO_DISABLE_AFTER_HOURS` (72 h). New events stop creating delivery rows for it. Re-enabling arms one probe rather than releasing the whole backlog. |
| **Concurrency gate** | Per-process ceilings on in-flight attempts: global, per organization, per project, per endpoint. Ceilings, not reservations. |
| **Rate limit (delivery)** | Per-endpoint requests-per-window limit, enforced fleet-wide through Redis or per replica without it. |
| **Rate limit (ingest)** | Two layers on publishes: per source address before authentication, and per API key after it. |
| **Per-replica (degraded)** | Rate limits enforced inside each worker process because Redis is absent or unreachable; an endpoint's limit is multiplied by the replica count. |
| **SSRF guard** | The check that refuses endpoint URLs resolving to private, loopback, link-local, metadata or reserved addresses. Mirrored in the kernel by the NetworkPolicies. |
| **Private allowlist** | `EGRESS_PRIVATE_ALLOWLIST`: specific CIDRs the guard lets through, for internal consumers. The supported alternative to turning the guard off. |
| **Payload offload** | Storing an event body at or above `PAYLOAD_INLINE_MAX_BYTES` in object storage instead of the row. |
| **Orphan payload** | An object in the bucket no event row references, left by a process that died between upload and commit. Swept by the scheduler. |
| **Signing secret** | The per-endpoint HMAC key. Stored encrypted under `ENCRYPTION_KEY`; the worker decrypts it to sign each attempt. Rotation keeps two valid at once. |
| **Encryption key / key id / retired keys** | `ENCRYPTION_KEY` (current), `ENCRYPTION_KEY_ID` (its name inside ciphertext), `ENCRYPTION_KEYS_RETIRED` (older keys accepted for decryption). A database backup without the matching key cannot sign a single webhook. |
| **Retention** | Scheduled deletion of old ledger rows: attempt rows at `RETENTION_ATTEMPT_AGE_DAYS`, delivery rows at `RETENTION_DELIVERY_AGE_DAYS`, both floored at 48 h. |
| **Migration job** | The explicit, one-shot run of schema migrations. Never triggered by application start or by `helm upgrade` on its own. |
| **Direct URL** | `DIRECT_DATABASE_URL`: a connection that bypasses PgBouncer, for migrations. |
| **Bootstrap** | Creating the first owner, organization and membership in one transaction from `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`, `BOOTSTRAP_ORG`. Refuses to run if any user exists. There is no default account. |
| **Open registration** | `ALLOW_OPEN_REGISTRATION=true`: anyone who can reach the API can create an account and an organization. Off by default. |
| **Starting / draining** | What `/health/ready` reports with a 503 before a role has connected to the database (`starting`) and after it received SIGTERM (`draining`). Opposite operator stories; same status code. |
| **Trust proxy hops** | `TRUST_PROXY_HOPS` (control API) and `INGEST_TRUSTED_PROXY_HOPS` (ingest): the exact number of reverse proxies in front of the process, used to read the client address for per-IP limits. Never inferred. |
| **Existing secret** | A Kubernetes Secret you manage (External Secrets, Vault, SOPS) that the chart references instead of rendering secret values itself. |

---

**Where this comes from.** `docs/FAILURE_RECOVERY.md`, `docs/BACKUP_RESTORE.md`, `.env.example`, `services/data-plane/internal/httpx/health.go`, `deployments/observability/README.md`.
