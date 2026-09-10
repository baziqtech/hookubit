# Mail

The control plane sends a small number of transactional messages, each carrying
a single-use link. Nothing else in the platform sends mail; the data plane has
no mailer at all.

## Configuration

| Variable | Value | Notes |
|---|---|---|
| `SMTP_URL` | `smtp://user:pass@mail.example.com:587` or `smtps://...` | **Set is the switch.** With it, SMTP is used in every environment, `development` included. Without it, `development` and `test` use a stub that logs and delivers nothing, and `staging` and `production` refuse to boot. |
| `MAIL_FROM` | `Hookubit <no-reply@example.com>` or `no-reply@example.com` | Required whenever `SMTP_URL` is set; the control plane refuses to boot with one and not the other. The display name is the product name used in subjects and bodies. Quote it: the angle brackets are shell syntax. |
| `DASHBOARD_URL` | `https://webhooks.example.com` | The base of every link. The path is preserved, so `https://example.com/hooks` produces `https://example.com/hooks/verify-email?...`. Scheme required. |

`SMTP_URL` carries a password, so it belongs in a Secret, not a ConfigMap. The
Helm chart puts it in `secrets.smtpUrl` (or your `secrets.existingSecret`); the
raw manifests put it in the application Secret; Compose reads it from the host
environment.

Refusals you will see at boot, verbatim:

| Message | Cause |
|---|---|
| `SMTP_URL must start with smtp:// or smtps:// (e.g. smtp://user:pass@mail.example.com:587)` | `host:587` without a scheme. It parses as a URL whose scheme is the hostname. |
| `MAIL_FROM is required when SMTP_URL is set - the transport needs a sender address` | One of the pair is missing. |
| `SMTP_URL is required when APP_ENV=production: without a mail transport, registration, email verification, password reset and member invitations would silently deliver nothing` | Staging or production with no transport. |
| `DASHBOARD_URL must start with http:// or https:// (the dashboard origin, e.g. https://app.example.com)` | Scheme missing. |

Query options on the URL pass through to the mailer: `?pool=true` keeps a
connection open, `?ignoreTLS=true` is for a relay that does not offer STARTTLS.

## What is sent

| Message | Trigger | Subject | Link |
|---|---|---|---|
| Email verification | Self-serve registration, or "resend verification" from the login screen | `Confirm your email address for <product>` | `<DASHBOARD_URL>/verify-email?token=...` |
| Password reset | "Forgot password" | `Reset your <product> password` | `<DASHBOARD_URL>/reset-password?token=...` |
| Registration attempt notice | Someone registers with an address that already has an account | `Someone tried to sign up for <product> with your email` | none |
| Team invitation | An admin invites an address to an organization | `<inviter> invited you to <organization> on <product>` | `<DASHBOARD_URL>/accept-invitation?token=...` |
| Already-a-member notice | An admin invites an address that is already a member | `You are already a member of <organization>` | none |

`<product>` is the display name from `MAIL_FROM`. Every message has a plain-text
and an HTML part. The link in the message is the only copy of the token; the
server log carries a six-character prefix and nothing more.

The account created by the bootstrap job is created verified and needs none of
this.

## What happens with no transport

| Environment | `SMTP_URL` unset | `SMTP_URL` set, server unreachable |
|---|---|---|
| `development`, `test` | A stub logs `[dev-mailer] ... token abc123...` and sends nothing. Registration answers `202`; the flow cannot be finished without the link. | One warning at boot (`SMTP transport ... could not be verified at boot`), then an error line per message (`Failed to send email_verification to <hash>@domain`). Registration still answers `202`, deliberately: the response must not reveal whether an address exists. |
| `staging`, `production` | Refuses to boot. | Same as above. Fix the relay and have the user click "resend verification". |

The stub is not a fallback for a server that is down. Once `SMTP_URL` is set,
SMTP is the only transport.

## A sandbox for staging

Point a staging install at a mail catcher rather than a real relay, so nobody's
inbox receives test invitations. [Mailpit](https://mailpit.axllent.org/) is the
one the development stack uses:

```yaml
# docker compose service
mailpit:
  image: axllent/mailpit:v1.21
  ports:
    - '1025:1025'   # SMTP
    - '8025:8025'   # web inbox and API
```

```
SMTP_URL=smtp://mailpit:1025
MAIL_FROM="Hookubit <no-reply@staging.example.com>"
```

Every message lands in the inbox at port 8025 and nothing leaves the network.
`curl -s http://mailpit:8025/api/v1/messages` lists what was received, which is
useful in a smoke test. Do not paste a token out of the inbox into a ticket; it
is a live credential until used.

## Checking it works

1. Boot the control API and look for the trust-proxy and mailer lines in its
   log. A verified transport logs nothing alarming; an unverified one warns.
2. Register a throwaway address (or invite one) and confirm the message arrives
   with a link under your `DASHBOARD_URL`.
3. Click it. If the dashboard at that URL does not serve `/verify-email`, the
   dashboard image or `DASHBOARD_URL` is wrong, not the mail.

---

**Where this comes from.** `apps/control-api/src/config/env.schema.ts` (`SMTP_URL`, `MAIL_FROM`, `DASHBOARD_URL` and the `superRefine` block), `apps/control-api/src/notifications/{templates,smtp-mailer,mailer-selection}.ts`, `docs/LOCAL_SETUP.md` §6, `deployments/compose/docker-compose.dev.yml` (`mailpit`).
