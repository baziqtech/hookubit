# 0006 — No default account; bootstrap is explicit and atomic

Status: Accepted

## Decision

The platform never creates a user on first start. The first owner is created
either by open registration (when `ALLOW_OPEN_REGISTRATION=true`) or by running
the bootstrap command with real values supplied by the operator:

```
BOOTSTRAP_EMAIL=… BOOTSTRAP_PASSWORD=… BOOTSTRAP_ORG=… \
  pnpm --filter @webhook/control-api bootstrap
```

It refuses to run if any user already exists, and creates the organization, the
owner and the membership inside one transaction.

## Why it exists

This is a lesson from running Convoy on a real server, not a hypothetical. Its
community build silently creates `superuser@default.com` / `default` on first
start against an empty users table, and its own `bootstrap` command segfaults on
a nil licenser — leaving an orphan user and no organization.

## What it prevents

- **A shipped credential.** Every self-hosted install otherwise starts with the
  same publicly documented password, reachable by anyone who can route to it.
- **Half-created tenants.** A crash mid-bootstrap leaves a user with no
  organization and no route to recovery. One transaction makes that state
  unrepresentable.
- **Silent failure.** The command exits non-zero with a readable message; it
  never leaves a partial install looking successful.

## How it scales

Irrelevant to scale, relevant to every single install — which is the point.

## Migration path

SSO and SCIM provisioning (post-MVP) replace the bootstrap path for enterprise
tenants. The invariant that outlives it: no account exists that the operator did
not deliberately create.
