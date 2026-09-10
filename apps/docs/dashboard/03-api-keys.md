# API keys

An API key is what your backend authenticates with when it publishes an event
to a project. Keys are server-to-server credentials: one per integration, not
one per person.

## The list

`/orgs/:orgId/projects/:projectId/api-keys` shows every key the project has
ever had, revoked and expired ones included:

| Column | Meaning |
|---|---|
| Key | The name you gave it, and its **prefix** - the first 12 characters (`wk_live_` or `wk_test_` plus four). The prefix identifies a key in logs and audit entries and is never enough to reconstruct it. |
| Status | `active`, `expired` or `revoked`, derived from the key's timestamps at the moment you look, exactly as the ingest path derives it. Revoked outranks expired. Beside it, the environment badge. |
| Last used | Best-effort, written by the data plane. Never a basis for a security decision. |
| Created | When it was issued. |

Read the pager before concluding you have seen every key. The reason to read
this list is usually "what can currently authenticate as us?", and a page that
looked complete while the server held more would answer that wrongly.

Reading the list needs `api-keys.read`, which **viewers do not hold**: the
inventory of live credentials is not read-only-user data.

## Creating a key

**Create key** asks for a name ("what holds this key - an integration, not a
person"). The environment is not a choice: it is taken from the project, so a
`wk_live_` key cannot exist under a `test` project.

The key is shown once, in the dialog, with a copy button and this warning:

> Copy this now - you will not see it again. Only a hash is stored, so this
> value cannot be shown again or recovered by anyone, including support. If
> you lose it, you must revoke and re-issue.

That is literal. The plaintext exists for one response; the platform stores a
SHA-256 hash and nothing can reproduce the key from it. The dashboard never
writes the plaintext into its cache, the URL or browser storage.

Keys are 32 random characters after the prefix. Creation is rate limited (10
a minute per address) and subject to a ceiling of **50 un-revoked keys per
project** by default. Expired keys still count; revoke them to free a slot.

::: info The API accepts two things the dialog does not ask for
`POST /v1/projects/:projectId/api-keys` also takes `expires_at` (an ISO
timestamp in the future, after which the key stops authenticating with no
further action) and `scopes` (see below). A key created from the dashboard
has no expiry and no scopes, which is what an ingest-only key wants.
:::

## Scopes and effective scopes

A key carries two lists, and they answer different questions.

**`scopes`** is what the key was **minted with**. It is a snapshot of the
issuer's authority at that instant: a key cannot be created with a permission
its creator does not hold, so a developer cannot mint a key carrying
`members.write`. Nothing re-checks this list afterwards, which is why it is
history rather than authority.

**`effective_scopes`** is what the key **may do now**:

```
effective_scopes = scopes ∩ permissions of the issuer's CURRENT role
```

The key records who minted it (`created_by_user_id`,
`created_by_membership_id`) and reports the issuer's role as it is now
(`created_by_role`). So:

| What happened to the issuer | Effective scopes |
|---|---|
| Nothing | Equal to `scopes`. |
| Demoted (developer to viewer, say) | Only the scopes a viewer holds. |
| Removed from the organization | **Empty.** The membership reference goes null, and "we no longer know whose authority this was" means no authority, not all of it. |

This is a derivation, not a stored value, so it takes effect on the next use
with no sweep to miss. It degrades authority rather than destroying it: the
key is bound to the project, not to a person, so an ingest credential is not
taken offline because someone left the company.

**Ingest does not consult scopes at all.** Publishing an event is
authenticated on the key, its project and its environment. A key with an
empty scope list is a normal ingest key, and a key whose issuer has gone
still publishes; it just carries no control-plane authority. Scopes only
matter for control-plane operations performed with a key, which the
dashboard does not do.

## Revoking a key

Revocation takes effect immediately - the ingest path refuses the key on its
next request - and is idempotent: revoking an already-revoked key returns it
unchanged and records nothing new. The row is kept forever with its
`revoked_at`, so the events it published stay attributable.

Revocation is the only thing that frees a slot against the per-project
ceiling, and it is the tool for "this credential must die". It is rate
limited loosely (60 a minute) on purpose, because it is the operation an
operator reaches for under pressure, often from a script.

::: info Not in the dashboard yet
There is no Revoke button in the list. Revoke through the API:
`POST /v1/projects/:projectId/api-keys/:apiKeyId/revoke`.
:::

There is no update route and there will not be one: widening a key's scopes,
extending its expiry or renaming it would change what a credential already in
the wild can do while its holder and its audit trail stay the same. Revoke
and issue a new one.

## Rate limiting of keys

Two different limits apply to keys, and they are enforced in different
places:

- **Publishing with the key** is subject to rate-limit policies at the
  `ingest` scope. A policy with a specific `resource_id` names one API key and
  caps that credential on its own; a policy with a null resource is a shared
  budget for every key in the project. Project- and organization-scope
  policies are charged as well - they are nested budgets, not fallbacks. See
  [Retry and rate-limit policies](./06-retry-and-rate-limit-policies.md#rate-limit-policies).
  A refused publish gets a 429 with `Retry-After`.
- **Managing keys** through the dashboard or control API is throttled per
  source address as described above.

## What "active" does not promise

A key marked `active` still fails to authenticate if its project has been
deleted or suspended, or if the project's environment does not match the
key's prefix (which cannot happen to a key created here). The status is a
fact about the key row alone.

---

**Where this comes from** (for maintainers):
`apps/dashboard/src/features/api-keys/ApiKeysPage.tsx`, `api.ts`,
`apps/dashboard/src/components/SecretReveal.tsx`,
`apps/control-api/src/api-keys/api-keys.controller.ts`, `api-keys.service.ts`,
`api-key-state.ts`, `api-key-limits.ts` (`API_KEYS_PER_PROJECT`, throttles),
`effective-scopes.ts`, `dto/create-api-key.dto.ts`, `dto/api-key-response.dto.ts`,
`apps/control-api/src/common/api-key.ts` (prefix and secret length),
`services/data-plane/internal/ratelimit/policy.go` (`ResolveIngest`),
`services/data-plane/cmd/webhookd/ratelimit.go`.
