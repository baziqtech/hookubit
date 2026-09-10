# Secrets and rotation

Every delivery is signed with the endpoint's secret. This page is how you get the secret, how you replace it without dropping a delivery, and who is allowed to see it.

## The secret

A signing secret looks like `whsec_` followed by 43 URL-safe base64 characters - 256 bits of randomness. The prefix is part of the key: your receiver must store and use the **whole string**.

Secrets are versioned per endpoint, starting at 1. At any moment an endpoint has a set of **active** secrets - usually one, two during a rotation - and every delivery's `Webhook-Signature` carries one `v1=` component per active secret.

The platform stores secrets encrypted with a key the API never hands out, and **returns the plaintext exactly once**: in the response to the call that created it. No list, read or audit route ever contains it. If it is lost, rotate.

## The first secret

`POST /v1/projects/{projectId}/endpoints` mints version 1 as part of creating the endpoint. The response is the endpoint plus:

| Field | Meaning |
|---|---|
| `secret` | The plaintext, **here and nowhere else**. `null` if the caller may not read secrets (see [roles](#who-can-see-secrets)). |
| `secret_version` | `1`. |
| `secret_pending` | `true` when `secret` is `null`: the endpoint was created **paused** so it does not sign with a key nobody holds. An owner or admin must rotate, hand over the new plaintext, then enable the endpoint. |

An endpoint cannot be enabled without an active secret (`POST …/enable` answers `409`). Signing fails closed: a delivery to an endpoint with no usable secret is recorded as an attempt with error code `signing_failed` and retried on the schedule - never sent unsigned.

## Rotation

`POST /v1/endpoints/{endpointId}/secrets/rotate` with an optional body:

```json
{ "overlap_seconds": 86400 }
```

| `overlap_seconds` | Effect |
|---|---|
| omitted | **24 hours** (the default). |
| `0` | The old secrets stop signing **now**. The leak button - use it for a compromise, not a routine rotation. |
| up to `2592000` (30 days) | The longest overlap allowed. Past that the old secret is not overlapping, it is just live. |

What happens, in this order:

1. A new secret (version *n*+1) is created, active, with no expiry.
2. Every previously active secret is given an expiry of *now + overlap*.

The order is the safety property: a failure between the two steps leaves the endpoint with two live secrets, never zero. Two concurrent rotations cannot both claim the same version; the loser gets a `409` and retries.

The response is the new secret's metadata plus:

| Field | Meaning |
|---|---|
| `secret` | The new plaintext. Once. |
| `version` | *n*+1. |
| `previous_secrets_expire_at` | The last moment **any** earlier version still signs. `null` when none does (overlap 0, or the first secret). |
| `overlapping_versions` | Every earlier version still signing after this rotation, newest first - including versions whose own, earlier expiry this rotation did not move. |

### What your receiver sees during the window

Until `previous_secrets_expire_at`, every delivery carries **two `v1=` components**, one per active secret, newest version first:

```
Webhook-Signature: t=1757155200,v1=<hmac with version n+1>,v1=<hmac with version n>
```

A receiver that computes one HMAC and accepts a match against **any** `v1` - which is what all four [samples](./04-receiving-webhooks.md#samples) do - verifies with either secret throughout the window. That is the whole mechanism, and why rotation costs no deliveries.

### Rolling a receiver without dropping a delivery

1. Rotate with the default overlap. Note `previous_secrets_expire_at`.
2. Deploy the receiver with the **new** secret. Do it at your own pace; every instance, old or new, verifies every delivery for the length of the window because both signatures are present.
3. Confirm that every instance has the new secret before `previous_secrets_expire_at`. If you will not make it, rotate again: a new overlap starts from the newest secret and the prior ones are re-expired to the new deadline.
4. Do nothing else. The old secret stops signing at its expiry and is swept to inactive on the next rotation.

A receiver that holds **both** secrets during the window is not required - one `v1` will always match the one you have - but it is harmless.

### Stopping a secret early

`DELETE /v1/endpoints/{endpointId}/secrets/{secretId}` deactivates one secret immediately. It is refused with `409` if that secret is the **only** one signing, because that would leave the endpoint unable to sign anything; rotate with `overlap_seconds: 0` instead, which reaches the same end state without the gap.

## Who can see secrets

Reading or rotating a signing secret is a separate permission from managing the endpoint, and it is held by fewer roles. Whoever holds the secret can forge a webhook into your own consumers, so it is treated as more sensitive than the endpoint row or even the API-key inventory.

| Action | Permission | owner | admin | developer | viewer | billing |
|---|---|---|---|---|---|---|
| Create, edit, enable, disable an endpoint | `endpoints.write` | yes | yes | yes | - | - |
| See endpoint details, including `has_live_secret` | `endpoints.read` | yes | yes | yes | yes | - |
| List secret metadata (version, active, expiry - never the value) | `endpoint-secrets.read` | yes | yes | - | - | - |
| Receive the plaintext on create; rotate; revoke | `endpoint-secrets.write` | yes | yes | - | - | - |

The one thing a viewer or developer can learn about the secrets is `has_live_secret` on the endpoint: a boolean saying whether it can sign right now, so the dashboard knows whether to offer *Enable*. No id, version, prefix or expiry crosses that line.

Every creation, rotation and revocation is written to the organization's audit log with the version numbers involved - and never the value.

---

*Where this comes from:* `apps/control-api/src/endpoint-secrets/secret-generator.ts` (`whsec_`, 32 bytes base64url, `DEFAULT_OVERLAP_SECONDS`, bounds); `endpoint-secrets/endpoint-secrets.service.ts` (`rotate` statement order, `revoke` refusal, `mintInitial`, `hasLiveSecret`); `endpoint-secrets/dto/*` (`RotateSecretDto`, `RotatedSecretDto`, `isEffectivelyActive`); `endpoints/dto/endpoint-response.dto.ts` (`secret`, `secret_pending`, `has_live_secret`); `endpoints/endpoints.service.ts` (`enable` refuses without a live secret); `authz/permissions.ts` (the grants matrix); `services/data-plane/internal/signing/signing.go` (`Header` emits one `v1` per secret, `Verify` accepts any); `services/data-plane/internal/worker/deliver.go` (`sign` fails closed, `signing_failed`); `apps/control-api/openapi.json` (routes).
