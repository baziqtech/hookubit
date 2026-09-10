# Receiving webhooks

What arrives at your endpoint, how to prove it came from HookuBit, and how to build a receiver that survives retries.

## The delivery request

```http
POST /your/webhook/path HTTP/1.1
Host: your-service.example.com
Content-Type: application/json
User-Agent: HookuBit/1.0
Accept: */*
Webhook-Id: evt_01J…
Webhook-Delivery-Id: del_01J…
Webhook-Event-Type: order.created
Webhook-Attempt: 2
Webhook-Timestamp: 1757155200
Webhook-Signature: t=1757155200,v1=7f10b704e963699398001b1b5031d34050f97358cae72cd36f0f6bbbe9015697

{"event_type":"order.created","data":{"order_id":"ord_123","amount":120.5}}
```

The body is the **exact bytes the publisher sent** to the ingest API - the whole envelope, `event_type` and all, not just `data`. It is never re-serialised, which is what makes the signature verifiable.

### Headers

| Header | Value | Meaning |
|---|---|---|
| `Webhook-Id` | `evt_…` | The event. **Stable across every delivery of this event** - every endpoint, every retry, every replay. Deduplicate on this if you want one action per event. |
| `Webhook-Delivery-Id` | `del_…` | This delivery: one (event, endpoint) pair and its retry chain. Stable across retries; a [replay](./07-replay.md) is a new delivery and gets a new id. |
| `Webhook-Event-Type` | e.g. `order.created` | The event type, as published. Route on this rather than parsing the body first. |
| `Webhook-Attempt` | `1`, `2`, … | 1-based attempt number within this delivery. `1` is the first try. |
| `Webhook-Timestamp` | Unix seconds | When this attempt was signed. Identical to the `t` in the signature header. |
| `Webhook-Signature` | `t=<unix>,v1=<hex>[,v1=<hex>]` | HMAC-SHA256 signature(s). See below. |
| `Content-Type` | `application/json` | Set by the platform unless the endpoint's custom headers override it. |
| `User-Agent` | `HookuBit/1.0` | For your logs and your WAF allow-list. |

Plus any [custom headers](#custom-headers) configured on the endpoint. The `Webhook-*` names are reserved: a customer cannot set, override or remove them.

## Verifying the signature

This is the part that matters. Anyone who knows your URL can `POST` to it; the signature is the only thing that proves a request came from HookuBit and that the body was not altered in transit.

### The algorithm

1. Parse `Webhook-Signature` as comma-separated `key=value` pairs. Take `t` (the timestamp) and **every** `v1` value.
2. Compute `HMAC-SHA256(secret, "<t>" + "." + <raw body bytes>)` and hex-encode it (lowercase).
3. Compare it against **each** `v1` in constant time. The header carries one `v1` per active secret - two during a [rotation window](./06-secrets-and-rotation.md) - and a delivery is valid if **any** of them matches.
4. Reject the request if `t` is more than your tolerance away from now, in either direction. **Five minutes is a reasonable default.** This blunts replay of a captured request.

The key is the whole secret string, `whsec_` prefix included. The message is the decimal timestamp, a literal dot, then the body bytes - not a JSON re-encoding of the body, not the body with a trailing newline your framework added, and not `data` alone.

::: danger Sign the exact bytes you received
The most common verification failure is a framework that parses the body into an object before your code sees it, and code that then re-serialises the object to compute the HMAC. Key order, whitespace and number formatting all change the bytes. Read the raw body **before** any JSON middleware touches it:

- Express: `express.raw({ type: 'application/json' })` on the webhook route, so `req.body` is a `Buffer`.
- Flask / Django: `request.get_data()` / `request.body`, not `request.json`.
- Go `net/http`: `io.ReadAll(r.Body)`.
- PHP: `file_get_contents('php://input')`; Laravel: `$request->getContent()`.
:::

### Samples

Each sample is one function with the same shape: `(secret, header, rawBody, now) → valid?`, a tolerance of five minutes, a constant-time comparison, and "any `v1` may match". Every one of them was run against signatures produced by the platform's own signing algorithm: a single-secret header, a two-secret rotation header verified with the **older** secret, a tampered body, a stale timestamp, and a wrong secret.

::: code-group

```js [Node.js]
const crypto = require('node:crypto');

const TOLERANCE_SECONDS = 5 * 60;

/**
 * @param {string} secret   the endpoint signing secret, whsec_... (store it verbatim)
 * @param {string} header   the Webhook-Signature header value
 * @param {Buffer} rawBody  the request body EXACTLY as received - never re-serialised
 * @param {number} nowSeconds  current unix time (a parameter so it can be tested)
 * @returns {boolean}
 */
function verifyWebhookSignature(secret, header, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(timestamp + '.')
    .update(rawBody)
    .digest();

  // ANY v1 may match: during a secret rotation the header carries one per active secret.
  return signatures.some((sig) => {
    const candidate = Buffer.from(sig, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  });
}

module.exports = { verifyWebhookSignature };
```

```python [Python]
import hmac
import hashlib
import time

TOLERANCE_SECONDS = 5 * 60


def verify_webhook_signature(secret: str, header: str, raw_body: bytes, now: int | None = None) -> bool:
    """secret is the whsec_... value verbatim; raw_body is the request body EXACTLY as received."""
    now = int(time.time()) if now is None else now
    timestamp = None
    signatures = []
    for part in header.split(","):
        key, sep, value = part.strip().partition("=")
        if not sep:
            continue
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)
    if timestamp is None or not timestamp.isdigit() or not signatures:
        return False
    if abs(now - int(timestamp)) > TOLERANCE_SECONDS:
        return False

    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    # ANY v1 may match: during a secret rotation the header carries one per active secret.
    return any(hmac.compare_digest(sig, expected) for sig in signatures)
```

```go [Go]
package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const tolerance = 5 * time.Minute

// VerifyWebhookSignature checks header against secret over the EXACT body bytes received.
// Any v1 component may match: during a rotation the header carries one per active secret.
func VerifyWebhookSignature(secret, header string, rawBody []byte, now time.Time) error {
	var (
		ts         string
		signatures []string
	)
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			ts = value
		case "v1":
			signatures = append(signatures, value)
		}
	}
	secs, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return errors.New("signature header has no valid timestamp")
	}
	if len(signatures) == 0 {
		return errors.New("signature header has no v1 signature")
	}
	if age := now.Sub(time.Unix(secs, 0)); age > tolerance || age < -tolerance {
		return fmt.Errorf("timestamp outside tolerance")
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte("."))
	mac.Write(rawBody)
	expected := mac.Sum(nil)

	for _, sig := range signatures {
		candidate, err := hex.DecodeString(sig)
		if err == nil && hmac.Equal(candidate, expected) {
			return nil
		}
	}
	return errors.New("no signature matched")
}
```

```php [PHP]
<?php

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * @param string $secret   the whsec_... value, stored verbatim
 * @param string $header   the Webhook-Signature header value
 * @param string $rawBody  the request body EXACTLY as received (file_get_contents('php://input'))
 */
function verifyWebhookSignature(string $secret, string $header, string $rawBody, ?int $now = null): bool
{
    $now ??= time();
    $timestamp = null;
    $signatures = [];
    foreach (explode(',', $header) as $part) {
        $pair = explode('=', trim($part), 2);
        if (count($pair) !== 2) {
            continue;
        }
        [$key, $value] = $pair;
        if ($key === 't') {
            $timestamp = $value;
        } elseif ($key === 'v1') {
            $signatures[] = $value;
        }
    }
    if ($timestamp === null || !ctype_digit($timestamp) || $signatures === []) {
        return false;
    }
    if (abs($now - (int) $timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
        return false;
    }

    $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
    // ANY v1 may match: during a secret rotation the header carries one per active secret.
    foreach ($signatures as $signature) {
        if (hash_equals($expected, $signature)) {
            return true;
        }
    }
    return false;
}
```

:::

A test vector, if you want to check your own implementation before wiring it up. With the secret `whsec_9hK3xq2lQ7pZ0Tn8vY1wR4sM6uB5cD2eF8gH0jK1lM`, timestamp `1757155200` and the body

```
{"event_type":"order.created","data":{"order_id":"ord_123","amount":120.5}}
```

the platform emits

```
Webhook-Signature: t=1757155200,v1=7f10b704e963699398001b1b5031d34050f97358cae72cd36f0f6bbbe9015697
```

Change `120.5` to `120.6` and it must fail.

### When verification fails

Respond `401` or `403` (or any non-retryable `4xx`). The delivery is recorded as `failed` with `http_401`, it is **not** retried, and it does not count against the endpoint's circuit breaker - an endpoint that answers is a healthy endpoint. Then check, in this order: are you hashing the raw bytes; is the secret the current one (the endpoint's *Secrets* list in the dashboard shows which versions are active); is your clock within tolerance. The signature the platform sent is visible on the attempt in the dashboard, so you can compare byte for byte.

## Respond fast, work later

The platform waits **30 seconds by default** for the whole exchange (connect 3 s, TLS 3 s, first response byte 10 s). An endpoint's `timeout_ms` (1,000-120,000, default 30,000) can only **shorten** that, never extend it. A timeout is a retryable failure and counts against the circuit breaker, so a receiver that does its real work inline will be retried while it is still working - and get the same event again.

The pattern that works: verify the signature, persist the body (or enqueue it), return `2xx`, and process asynchronously. Any `2xx` is a success; the platform does not read the body for meaning, although up to 64 KiB of it is stored on the attempt for you to see in the dashboard.

Redirects are **not followed**. A `3xx` is a permanent failure. Point the endpoint at the final URL.

## Be idempotent

Retries mean duplicates by design, and the platform prefers a duplicate to a lost delivery in every ambiguous case - for example a worker that crashes after your `200` but before it records the outcome. Your receiver will see the same delivery twice at some point.

| Deduplicate on | You get | Use when |
|---|---|---|
| `Webhook-Id` | One action per **event**, however many deliveries, retries or replays reach this endpoint. | Almost always. The event is the fact; act on it once. |
| `Webhook-Delivery-Id` | One action per **delivery**; a replay is a new delivery and is acted on again. | You use replay deliberately to re-run processing. |

Store the id you chose with the result of processing, in the same transaction, and return `2xx` on a repeat without doing the work again.

## Custom headers

An endpoint may carry up to **20** extra request headers, sent on every delivery - a bearer token for your own gateway, a routing hint, a tenant id. Rules, enforced when the endpoint is saved:

| Rule | Limit |
|---|---|
| Header count | 20 |
| Name | 1-128 characters, RFC 9110 token characters only; names are case-insensitive and duplicates are refused |
| Value | up to 1,024 characters; no CR, LF or other control characters |
| Total | 8,192 bytes across all names and values |

**Refused at save time** - the platform owns these:

- anything beginning `Webhook-` (the delivery identity and the signature)
- `Authorization`, `Host`, `Content-Length`, `Transfer-Encoding`

**Silently dropped at send time**, because they belong to the transport: `Connection`, `Upgrade`, `TE`, `Trailer`, `Expect`.

`Content-Type` **may** be overridden. The signature covers the body bytes, not the media type, so nothing verifiable depends on it.

In the delivery ledger, custom header values whose names look like credentials (`authorization`, `cookie`, `api-key`, `token`, `secret`, `password`, `credential`, …) are stored as `[redacted]`. The name is kept, so "did we send it?" is still answerable. `Webhook-Signature` is deliberately not redacted.

## URL rules

An endpoint URL is checked twice: once when you save it, for everything decidable without DNS, and again on **every connection**, against the address actually being dialled. The second check is the one that matters - a hostname that resolves publicly today and to `127.0.0.1` tomorrow is refused tomorrow.

Refused at save time (a `400` naming the reason):

| Rule | Detail |
|---|---|
| Scheme | `http` or `https` only |
| Length | at most 2,048 characters; no whitespace or control characters |
| Credentials | `https://user:pass@host/…` is refused; credentials in a URL end up in logs and support tickets |
| Host | `localhost` and `*.localhost`; literal loopback, private (RFC 1918 / RFC 4193), link-local, multicast, unspecified, carrier-grade NAT, documentation, benchmarking and reserved addresses; cloud instance-metadata addresses; IPv4-mapped and 6to4/NAT64 IPv6 literals that embed any of the above |

Refused at dial time, per resolved address, with the same classifications - so a public hostname whose DNS answers with a private address is not connected to. A refused dial ends the delivery immediately as `failed` with reason `blocked_target`; it is not retried and it does not affect the endpoint's circuit breaker, because the platform declined to dial and the endpoint's health is unknown.

Operators of a self-hosted installation can allow-list specific private ranges for internal consumers; see [Self-hosting](/self-hosting/). Instance-metadata addresses are refused regardless.

TLS: the certificate must chain to a trusted authority and match the hostname. An untrusted or mismatched certificate is a **permanent** failure. An **expired** certificate is retried, because renewing it fixes it.

---

*Where this comes from:* `services/data-plane/internal/worker/headers.go` (header names, `User-Agent`, reserved and platform headers, redaction); `internal/signing/signing.go` (`Sign`, `Header`, `Verify`); `internal/worker/deliver.go` (timestamp, `timeout_ms` only shortens, stored response body); `internal/egress/client.go` (timeouts, 64 KiB response cap, redirects off); `internal/retry/retry.go` (`ShouldRetry`, TLS classification); `internal/worker/state.go` (`blocked_target`, error codes); `apps/control-api/src/endpoints/endpoint-headers.ts` (custom header limits, reserved names); `apps/control-api/src/endpoints/endpoint-url.ts` (save-time URL rules); `apps/control-api/src/endpoints/endpoint-limits.ts` (`timeout_ms` bounds); `apps/control-api/src/deliveries/delivery-limits.ts` (ledger redaction); `docs/FAILURE_RECOVERY.md` scenarios 10, 13-16. The four samples were executed against vectors from a copy of `signing.go`; the harness is not part of the repository.
