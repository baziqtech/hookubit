# Design brief — HookuBit operator dashboard

*A prompt for a design agent. It describes what the product does and what each
screen must let someone know or do. Every visual decision is yours: colour,
type, layout, density, chrome, motion, illustration, shape. Nothing here
prescribes any of that, and you should not assume the existing interface is
worth preserving — it is not the reference.*

---

## 1. What the product is

HookuBit delivers webhooks for other companies.

A customer's backend publishes an event once — "payment.settled", say. HookuBit
stores it durably before acknowledging it, works out every consumer that asked
for that kind of event, and makes one HTTP request per consumer. It signs each
request so the receiver can prove it came from HookuBit. It retries the ones
that fail, backing off between attempts. It sets aside consumers that stay
broken so they cannot starve everyone else. And it keeps a permanent record of
every single attempt: when it was made, what came back, how long it took.

**The record is the product.** People do not pay for the retry loop — they pay
to be able to answer "did finance ever actually receive that settlement?"
without a database query. Design for that sentence.

## 2. Who is looking at it

A backend engineer or an operations lead at a company that sends webhooks to
its own customers. They are technical. They read HTTP status codes fluently and
are unimpressed by decoration.

Three situations, in rough order of how often they happen:

- **Routine.** Scanning a long list of deliveries looking for the handful that
  did not succeed. This is most of the time, and it is repetitive — someone may
  look at hundreds of rows in a sitting.
- **Onboarding.** A new project that has never delivered anything. The person
  does not yet know what an endpoint or a subscription is, and the product is
  useless until they have made one of each.
- **Incident.** Something is down, a customer is angry, and the answer needs to
  be on screen within about a minute. This is the least frequent and the most
  important. It is often 2am.

## 3. The nouns, and how they relate

Everything in the product is one of these. A designer needs the relationships
because they are the information architecture.

| | |
|---|---|
| **Organization** | The billing and people boundary. Users belong to one or more; everything else lives inside one. |
| **Project** | One environment of one system — "Payments, test". It owns its own credentials, consumers and history. Nothing crosses between projects. A project is permanently either a test or a live environment; that cannot be changed after it is created, and the only way to a different one is a second project. |
| **API key** | What the customer's backend authenticates with to publish. The secret is displayed once, at creation, and can never be shown again. |
| **Endpoint** | A URL HookuBit sends to, plus its own timeout, concurrency limit, rate limit, retry policy, custom headers and signing secrets. |
| **Subscription** | The routing rule binding one endpoint to the event types it should receive. Without one, events are accepted and nothing is delivered — this is the single most confusing thing the product can do to a newcomer. |
| **Event** | One fact published by the customer's system, stored once. |
| **Delivery** | One event's journey to one endpoint. An event matching three subscriptions creates three deliveries, made up front, each retrying independently. |
| **Attempt** | One HTTP request within a delivery, with its response status, body, duration and timestamp. |

The routing is the concept people most often misunderstand: **one event becomes
many deliveries, created before anything is sent**, so the list is the record of
what *should* arrive, not just what did.

## 4. First-run: the setup checklist — REQUIRED

A new project cannot deliver anything, and the person does not know why. The
product tracks six things in dependency order and shows what is done, what is
next, and what is still outstanding. Exactly one step is "do this next", and a
step only becomes current when everything before it is satisfied — the
dependencies are real, and publishing before a subscription exists returns a
cheerful success and delivers nothing.

Each step carries a name, a one-line explanation of *what the thing is*, an
action, and — once done — evidence of it.

1. **Organization** — "The billing and people boundary. Everything else lives
   inside one." · Evidence: the organization's name.
2. **Project** — "One environment of one system. It owns its own keys,
   endpoints and delivery history, and nothing crosses between projects." ·
   Evidence: the project name and its environment.
3. **API key** — "What your backend authenticates with when it publishes an
   event." Action: "Create a key. The secret is shown once and cannot be
   recovered." · Evidence: how many active keys exist.
4. **Endpoint** — "The URL we POST to, plus its timeout, rate limit and signing
   secret." Action: "Add the URL that should receive webhooks." · Evidence: how
   many endpoints are delivering.
5. **Subscription** — "The routing rule: which event types an endpoint should
   receive. Without one, events are accepted and nothing is delivered." ·
   Evidence: how many active subscriptions exist.
6. **First event** — "You publish an event once. It routes to one delivery
   per matching subscription, and each delivery retries on its own." Action:
   publish a test event using a ready-to-run request the product supplies,
   already filled in with this project's real identifiers. · Evidence: how many
   events have been received.

Two steps have a third state beyond done and not-started, and it matters more
than either:

- **Endpoint needs attention** — endpoints exist but none can receive anything,
  because they are paused, switched off by the circuit breaker, or still
  waiting for a signing secret. The person must be told that nothing will be
  delivered until one is live.
- **Subscription needs attention** — subscriptions exist but all are switched
  off. "Events published now are accepted and stored, then dropped."

This checklist appears both on its own dedicated first-run screen and inline
wherever the operator lands, so it cannot be missed. Until it is complete, the
main screen *is* the checklist rather than a health summary — a success rate of
0.00% for a project that has never sent anything is a number dressed up as a
diagnosis. Something in the persistent navigation should indicate that setup is
outstanding, and stop indicating it when the work is done.

## 5. The product tour — REQUIRED

A five-step introduction to the concepts, shown once to a new account and
reopenable from the product at any time. It is **non-blocking**: someone reading
step two can go and look at the thing it describes without losing their place.
It can be skipped at any point, and skipping or finishing is remembered for the
account, not just the browser.

1. **"Webhooks that arrive, or tell you why they did not."** Your system
   publishes an event once. HookuBit gets it to every consumer that asked for
   it — retrying failures, signing each request, and keeping a permanent record
   of every attempt. The record is the product: when someone asks at 2am whether
   finance ever received a settlement, the answer is on a page here rather than
   in a database query.
2. **"One event becomes many deliveries."** You publish one event; we create one
   delivery per matching subscription, up front, before anything is sent — so
   the record is what *should* arrive. Each delivery then retries on its own. A
   partner being down does not delay the delivery to your ledger, and either can
   be replayed alone.
3. **"Your consumer can prove it was really you."** Every request carries a
   signature header — a hash over the timestamp and the exact bytes of the body.
   The consumer recomputes it with the endpoint's secret and rejects anything
   that does not match. Rotating a secret emits both the old and the new
   signature for an overlap window, so consumers roll over without dropping a
   single delivery.
4. **"A flaky endpoint recovers on its own."** Timeouts, rate-limit responses
   and server errors are retried with exponential backoff. Other client errors
   are treated as permanent and not retried — a signature the consumer rejects
   is a bug, not a blip. An endpoint that fails consistently trips its circuit
   breaker and is set aside, so one unresponsive partner cannot starve everyone
   else. Deliveries keep their place in the record the whole time.
5. **"Now set yours up."** Hands off to the setup checklist above, which tracks
   what this project still needs and supplies the ready-to-run request for the
   first event.

## 6. The screens, by what they must let someone do

### Delivery history
The most-used screen. A list of every delivery, each showing which event and
which endpoint it belongs to, its current state, a plain-language outcome, how
many attempts have been made out of how many are allowed, and its age.
Filterable by state, by endpoint, by event type, by whether it is failing right
now, and by whether it is an original or a replay. It must support someone
scanning for the few rows that did not succeed among hundreds that did.

### One delivery
Why this specific thing did or did not arrive. The full attempt history — each
attempt's response code, body, duration and time. A diagnosis in plain language.
A health check on the endpoint it targets, because a delivery can read as
"retrying" while the endpoint it targets has already been set aside, in which
case no retry is actually coming and the operator must be told. Offers replay,
but only when the retry chain has genuinely stopped; replaying a success is
almost always an accident.

### Events
Every event the customer's system published, with its type, its de-duplication
key, its status and when it arrived. Opening one shows the payload it carried
and every delivery it produced, and offers to replay the whole routing.

### Outbox
The recovery screen. Between "event accepted" and "deliveries created" there is
a queue, and rows can get stuck there. This lists them, says in plain language
*why* each one is stuck, and lets an operator put them back — one at a time or
in bulk, with a reason recorded. Four distinct causes, and the difference
matters because one of them is not recoverable at all:

- attempts exhausted
- the retry time budget ran out
- the row references a kind of work the system does not recognise
- the event it refers to no longer exists — this row is evidence of a lost
  event, not work to recover, and requeueing will simply park it again

### Endpoints
Every consumer URL in the project, its current state, and whether the operator
or the platform stopped it — those are different events and must not share an
affordance. Per endpoint: create, edit, pause (with a reason, recorded),
resume, delete, and manage signing secrets. Configurable per endpoint: request
timeout, how many requests may be in flight at once, a rate limit and its
window, which retry policy to use, and custom headers to send.

Two behaviours to design for honestly:
- Creating an endpoint can succeed and still leave you with a non-delivering
  endpoint: someone without permission to see signing secrets gets one that is
  paused and has no usable secret. Presenting that as success means the person
  wires up a consumer and waits for deliveries that will never come.
- Pausing an endpoint **cancels** the deliveries already queued for it as
  workers reach them, and new events produce no rows for it at all. It does not
  hold them. Nothing in the record is erased, and replay is the way back.

### Signing secrets
Per endpoint: the list of secret versions and their state, the ability to issue
a new one with an overlap window during which both old and new sign every
request, and the ability to retire one. Retiring the last active secret of a
live endpoint is refused — the system signs or it does not send, and an
endpoint with no secret would fail every delivery rather than send unsigned. A
newly issued secret is displayed once and never again.

### Subscriptions
The routing rules. Each binds an endpoint to a set of event types. Three forms
of type matcher are accepted — everything, a prefix, or an exact type — and
anything else is refused rather than silently widened. Create, edit, switch on,
switch off, delete. There is also an optional payload condition that is stored
but not yet applied, and the interface must say so rather than implying it
filters.

### Policies
Retry behaviour and rate limits, defined per project and selectable per
endpoint. A retry policy has a strategy, a maximum number of attempts, a first
delay, a ceiling on any delay, a growth factor, a jitter proportion, and an
overall time budget. Exactly one policy is the project default. Rate limits
have a scope, an optional specific resource, a ceiling, a window and a burst
allowance — and only some scopes are actually enforced today, which the
interface must state rather than imply.

### API keys
List, create, revoke. The full key is shown exactly once on creation. A key's
state is derived — revoked outranks expired — and revocation is immediate and
irreversible.

### Analytics
Four independent questions, each answerable on its own: delivery outcomes over
a window compared against the window before it; which endpoints are failing,
ranked worst first, with a failure rate shown beside a volume so one endpoint
failing twice is not mistaken for an outage; attempt duration percentiles,
which are computed from a bounded sample and must say so; and event volume with
the busiest types. Windows offered are 24 hours, 7 days and 30 days. A rate
computed from nothing must read as "no data", never as zero — zero means
everything failed.

### Accounts, people and access
Registration, email verification, sign-in, password reset, and invitations by
email. Five roles with genuinely different powers — an owner, an administrator,
a developer, a viewer, and a billing-only role. Roles are governed by rules
that must be expressed in the interface rather than discovered by failure: you
cannot change your own role, you cannot grant a role above your own, you cannot
act on someone who outranks you, and an organization must always keep at least
one owner. A team screen lists members, their roles and their account state,
and allows inviting, changing a role, and removing someone.

### Organization and project administration
Rename an organization or project. Some properties are deliberately not
editable and the interface should say why rather than showing a disabled
control: a project's environment is permanent, and suspension is not something
a customer can lift themselves. Deleting either is a separate, deliberate,
confirmed action.

### Audit log
Who did what, when. Readable only by roles entitled to it, filterable by action,
resource type and specific resource.

### Usage
Volume per project over a rolling window — events published and deliveries
created, and the ratio between them, which is the project's routing.

## 7. State vocabularies that must be legible

A delivery has **nine** states and the operator reads state before they read
anything else. They group into: waiting to be picked up (three of them),
in flight, succeeded, failing but not finished, failed permanently, and
cancelled. The distinction that matters most is **"still trying" versus "given
up"** — one needs patience, the other needs a human.

Colour may not be the only thing carrying this. A meaningful proportion of the
audience cannot reliably separate red from green, and these screens are read
under stress.

Events and queued work have their own smaller vocabularies. Endpoints carry two
separate facts that must not be collapsed: what the operator intended, and what
the platform decided. An endpoint the platform set aside while the operator
still wants it running is a different situation from one a person deliberately
paused, and the difference is what someone needs at 2am.

## 8. Behaviours that apply everywhere

- **Four kinds of nothing, and they are not the same message.** No rows yet; the
  request failed; this screen is not built; the capability does not exist in the
  API. Each needs different words and a different way out.
- **Never invent a number.** If nothing has settled, a success rate is unknown,
  not zero.
- **Show refusals, do not hide them.** A control someone's role does not permit
  should be visibly present and unavailable *with the reason attached*, rather
  than disappearing — otherwise people conclude the feature does not exist.
- **Failures are specific.** Every error surface carries a support reference
  identifier, because it is the only handle anyone has on what actually
  happened.
- **One-time secrets are one-time.** API keys and signing secrets appear once,
  and the interface must make the consequence of navigating away obvious.
- **Everything is addressable.** Any screen can be linked to and pasted into an
  incident channel, landing the next person exactly where you were.
- **Two themes**, and people must be able to choose between following their
  system and overriding it.
- **Accessible under stress**: real labels, visible focus, status never carried
  by colour alone, and any decorative motion switched off for those who ask for
  that.

## 9. What does not exist — please do not design it

Drawing these implies capabilities the product does not have, which is worse
than leaving a gap:

- No global search and no command palette.
- No data export in any format.
- No "send a test event" button — a real event is published and watched.
- No switching a project between test and live. It is permanent.
- No billing. There is no plan, no invoice, no payment method.
- No bulk "replay everything that failed". Replay is per delivery and per event;
  bulk recovery exists only for stuck queued work.
- No analytics window shorter than one hour.

## 10. What to produce

Cover, at minimum: the first-run experience including the checklist and the
tour; the delivery list and a single delivery; events and a single event; the
outbox including a stuck row; endpoints including the creation result and the
signing-secret flow; subscriptions; policies; API keys including the one-time
reveal; analytics; team; the audit log; sign-in and the account flow; and the
empty, loading, error and permission-refused states.

The product is called **HookuBit**. Take the visual language wherever you think
it should go — the brief above is what it must be able to say, not how it
should look.
