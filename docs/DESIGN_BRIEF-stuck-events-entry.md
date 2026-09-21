# Design brief — where "stuck events" lives

*One change. Features only; every visual decision is yours.*

## Context

Publishing happens in two stages. Fan-out turns one event into one unit of work
per subscribed consumer; sending then attempts each of those. The delivery
history shows stage two. An event stuck in stage one produces no rows there at
all — it was accepted, and it went nowhere.

There is a screen for those events: what is stuck, why, and whether putting it
back will help. It is currently a permanent navigation destination sitting
among ten daily ones.

## The change

**Take it out of the persistent navigation.** Most projects have nothing stuck,
most of the time, so a permanent entry spends a slot on a condition that is
almost always absent.

It then needs three ways in, each doing a different job:

1. **Something is stuck right now.** A signal on the delivery history and the
   project health screen that finds the operator rather than waiting to be
   found. It already exists. It must stay silent when there is nothing to say.
2. **A deliberate visit.** A durable way in from **Events** — always present,
   whether or not anything is stuck. This is the right home on the merits: the
   screen is *event-grain*, one row per event, exactly like the events list.
3. **A pasted link.** The address keeps working; people share it during
   incidents.

## Why door 2 is not optional

If the only way in appears when something is stuck, three situations have no
way in at all:

- **The signal cannot tell.** It depends on a request that can fail. A failure
  makes it silent — at the moment you most need the screen.
- **"Did my fix work?"** Once the events unstick, the signal disappears, and
  with it the way back to confirm.
- **The screen is wider than its name.** It can also show work that is queued,
  fanning out, or already done — a "what is the router doing" view that has no
  entrance otherwise.

## To design

How **Events** carries the way in so it reads as part of that screen's job
rather than an appended link — and so someone who has never seen a stuck event
still understands what it leads to.

And how the signal behaves in three states, not two: something is stuck;
nothing is stuck; **we could not find out**. The third is currently
indistinguishable from the second, which is tolerable while a permanent
navigation entry exists and is not once this is the main door.

The product is called **HookuBit**.
