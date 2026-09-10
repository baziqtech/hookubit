# Onboarding

Two things help a new operator, and they are deliberately different: the
**product tour** answers "what is this?", and the **setup checklist** answers
"what do I do next?".

## The product tour

The tour opens on its own the first time an account signs in, as a small
panel in the bottom-right corner. It is **non-modal**: nothing is dimmed, the
rest of the dashboard stays fully usable, and you can click into Deliveries
to look at what step 2 just described and carry on - the panel follows you
between pages. Escape closes it, **Skip tour** is on every step, and the
progress dots are buttons that jump between steps.

Five steps:

| Step | What it says |
|---|---|
| What this is | Your system publishes an event once; HookuBit gets it to every consumer that asked, retrying, signing and keeping a permanent record of every attempt. The record is the product. |
| Fan-out | One event becomes one delivery per matching subscription, created up front so the table is the record of what should arrive. Each delivery retries on its own, and either can be replayed alone. |
| Signing | Every request carries a `Webhook-Signature`, an HMAC over the timestamp and the exact body bytes. Rotating a secret emits both old and new signatures for an overlap window. |
| Retries | Timeouts, 429s and 5xx are retried with backoff; other 4xx are permanent. An endpoint that fails consistently trips its circuit breaker and is set aside so it cannot starve the others. |
| Your turn | Hands off to the Get started page. |

**Completion is remembered per account, not per browser.** Finishing or
skipping - both count; someone who skipped has decided they are oriented -
records the moment on your user record, and the tour does not reopen on
another device or after clearing site data. The recorded time is the first
completion and never moves. The browser keeps a local note as well, only to
cover the moment between the click and the server's reply.

Reopen the tour any time from **Product tour** at the bottom of the sidebar.

## Get started

`/orgs/:orgId/projects/:projectId/get-started` is signup to first delivered
webhook without reading the docs. It is also what the Overview shows until
setup is complete, and the sidebar's Get started item carries a dot until
then.

### The mental model

The page opens with the relationship every other screen assumes you know:

1. **Event** - you publish this once.
2. **Delivery** - one per matching subscription, created before anything is
   sent, each with its own retry chain.
3. **Attempt** - one HTTP request; a delivery that retries eight times has
   eight.

### The setup checklist

Six steps, in dependency order, **derived from the project's live state** -
there is nothing to tick off by hand, and nothing to get out of date:

| Step | Satisfied when | Shown as |
|---|---|---|
| Organization | You are in one. | its name |
| Project | You are in one. | its name and environment |
| API key | The project has at least one **active** key (revoked and expired keys do not count). | "N active keys" |
| Endpoint | At least one endpoint is `active` **and** enabled. | "N endpoints delivering" |
| Subscription | At least one subscription is enabled. | "N active subscriptions" |
| First event | The project has received an event. | "N events received" |

Each step has one of four states. Exactly one step is **Do this next** - the
first not yet satisfied - and the whole row links to the page where you do
it.

::: warning "Needs attention" is amber, never green
A resource can exist and still not deliver. An endpoint created by a
developer comes back paused with no signing secret handed over; a
subscription can be disabled. Those steps show **Needs attention** with a
warning ("Every endpoint in this project is paused, disabled, or waiting for
a signing secret. Nothing will be delivered until one is live."; "Events
published now are accepted and stored, then dropped") rather than a tick.
Setup counts as complete when every step is done *or* needs attention, so
the next step is still reachable - but the amber stays until it is fixed, and
the Overview's headline repeats the warning.
:::

The sequencing matters: publishing an event before a subscription exists
returns a cheerful `202 Accepted` and delivers nothing.

### Publish a test event

A ready-to-run `curl` with your real project id filled in. The one blank is
the API key, because the plaintext is shown exactly once at creation; paste
it into the field above the snippet and it is inserted for copying - it stays
in the tab and is never sent or stored. The request includes an
`Idempotency-Key` header on purpose: it is the one habit that makes a
publisher safe to retry, and the first request someone copies is the one that
ends up in their codebase.

Success is `202 Accepted` with the event id. **"Accepted" means stored, not
delivered.** The response returns as soon as the event is durably written;
fan-out happens after that. Watch it land on Events, then follow it into
Deliveries.

The ingest API is a separate service from the control API the dashboard
talks to; the page shows the base URL it is using, which your installation
sets at build time.

### Before you go live

The page closes with the three things a consumer must do, expanded in the
[Guide](/guide/04-receiving-webhooks):

- **Verify the signature** over the exact bytes received. Re-serialising the
  JSON first will not match.
- **Deduplicate on `Webhook-Id`.** Delivery is at-least-once, so retries mean
  duplicates.
- **Answer 2xx fast and work asynchronously.** 408, 429 and 5xx are retried;
  every other 4xx is permanent and never retried.

---

**Where this comes from** (for maintainers):
`apps/dashboard/src/features/onboarding/ProductTour.tsx`, `tour-content.ts`,
`tour-store.ts`, `tour-storage.ts`, `GetStartedPage.tsx`, `SetupChecklist.tsx`,
`setup.ts` (`deriveSetupSteps`, `isSetupComplete`, `setupHeadline`), `api.ts`
(`useSetupState`), `publish-request.ts`, `apps/dashboard/src/layouts/AppLayout.tsx`
(`ProjectNavSection` marker, `TourButton`), `apps/dashboard/src/features/auth/api.ts`
(`useCompleteOnboarding`), `apps/control-api/src/auth/auth.controller.ts`
(`onboarding-completed`), `apps/control-api/src/auth/auth.service.ts` (`completeOnboarding`).
