# Design brief — making stuck events findable

*A prompt for a design agent, scoped to one change. Describes the problem and
what must become expressible. Every visual decision is yours: colour, type,
layout, density, wording style, motion. Nothing here prescribes any of that.*

---

## 1. The two stages, briefly

HookuBit takes an event a customer's system published and makes one HTTP
request per consumer that subscribed to it. That happens in two stages, and
each one can fail on its own:

1. **Fan-out.** The event is stored and acknowledged immediately. A moment
   later, a router works out every consumer that should receive it and creates
   one unit of work per consumer.
2. **Sending.** Each of those units is attempted against its consumer's URL,
   retried on failure, and recorded.

Stage 2 is what people look at every day: a long history of "did this consumer
receive it, and what came back". That history is the product.

Stage 1 is invisible when it works, and when it breaks there is **nothing in
that history to see** — because the units of work were never created. The event
was accepted, the publisher got a success response, and then it went nowhere.

## 2. The problem to solve

An event can get stuck in stage 1. Today the product has a screen listing those
stuck events and explaining each one — it is thorough and it is good. The
problem is that **nothing anywhere else points at it.**

The failure path, as it actually happens:

> A consumer says they never received something. The operator opens the
> delivery history, filters for the event, and finds **nothing at all**. An
> empty result is indistinguishable from "that event was never published" and
> from "you filtered wrong". The screen that holds the real answer is somewhere
> they have no reason to visit, named after an internal mechanism they have
> never heard of.

This is the 2am path, and it currently dead-ends.

One place already does this well: opening a single event shows a notice when
that event is stuck. But you have to already know which event, and already be
looking at it.

## 3. What must become expressible

### a. In the delivery history

When the project currently has stuck events, someone looking at the delivery
history must find that out without knowing the concept exists in advance. It
must be discoverable from an **empty or unremarkable result**, because that is
the state the operator is staring at when they need it.

It has to carry: that some events in this project have not been fanned out, how
many, and a way through to them. It should not shout when there is nothing
wrong — this is a condition that is usually absent.

### b. On the main health screen

The project's health screen already surfaces deliveries that exhausted every
retry. Stuck events belong in that same reckoning: they are the failures that
have no delivery rows at all, so a health screen built only from delivery
outcomes reports a project as healthy while events silently go nowhere.

### c. The name

The destination is currently called **"Outbox"**. That is our implementation's
word — the transactional-outbox pattern — and it names a table, not a
condition. An operator has no reason to know it.

Propose what it should be called. It needs to say *what is wrong* so that
someone who has never opened it can tell, from the name alone, that this is
where an event that produced nothing would be. It appears both as a persistent
navigation destination and wherever the signals in (a) and (b) lead.

## 4. What the destination must express

This screen exists and works; you are free to redesign it, and it must keep
being able to say all of the following.

**The state of each stuck event.** What it is, when it arrived, and how many
times the router has picked it up. Two counts are always stated together
because the ratio between them *is* the diagnosis: total pick-ups, and how many
of those ended with the router recording nothing at all. Eleven of eleven
unaccounted is an event that kills the process; nought of sixty-three is an
event the router understood every single time.

**Why it is stuck, in plain language.** Five distinct causes, each needing
different words and pointing at a different next move:

| Cause | What it means |
|---|---|
| The router kept dying on this event | Every unaccounted pick-up ended without an outcome written — a crash, an out-of-memory kill, a lapsed lease. The signature of an event the router cannot survive, not of an outage. Put back unchanged, it will most likely park again. |
| It kept failing for longer than the retry window | Every failure *was* recorded, so the router understood what went wrong each time — something underneath it was erroring, not the event itself. This is what an outage that outlasted the window looks like. |
| The router does not handle this kind of row | There is no code path for it. Nothing changes until a router that understands it is deployed. |
| The event it points at no longer exists | There is nothing to fan out. This row is evidence of a lost event, not work to recover. |
| Parked, and the router did not say why | The reason is unrecognised. The raw error has to be read before deciding. |

**Whether recovery is worth attempting.** Each cause carries one of three
outlooks, and this distinction is the most valuable thing on the screen:

- **Safe** — the cause is understood and external; putting it back is the whole
  recovery.
- **Caution** — putting it back may well repeat the same failure; look at the
  event first.
- **Futile** — putting it back will park it again for the same reason. The
  interface must make this unmistakable, because the action will be available
  and will appear to succeed.

**Whether the fan-out was partial.** An event can park *part way through*: some
consumers already have their work created, the rest do not. That is a different
situation from one that produced nothing, and someone deciding whether to
retry needs to know which they are looking at.

**The recovery action.** Putting an event back into the queue, one at a time or
several together, with a reason recorded against it. Only a stuck event can be
put back — anything already moving is refused, and the refusal should read as
an explanation rather than an error.

## 5. Rules that apply

- **Do not invent capability.** Nothing here can be fixed by editing the event,
  skipping a consumer, or forcing a delivery. The only action is putting it back.
- **Do not imply recovery where there is none.** Two of the five causes are
  futile and the interface must say so before the action, not after.
- **An absent condition is the normal case.** Most projects have nothing stuck,
  most of the time. Signals must not cost anything when there is nothing to say,
  and must not read as broken when the count is zero.
- **Status can never be carried by colour alone** — a meaningful share of this
  audience cannot reliably separate red from green, and these screens are read
  under stress.
- The product is called **HookuBit**.

## 6. What to produce

The delivery history with stuck events present and with none; the health screen
with both; the destination screen itself — populated, empty, and showing a
futile case alongside a safe one; and the recovery confirmation including the
reason being recorded. Plus your proposed name, with the reasoning.
