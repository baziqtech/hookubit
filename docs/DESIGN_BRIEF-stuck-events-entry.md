# Design brief — where "stuck events" lives

*One change. Features only; every visual decision is yours.*

**Status: built.** The screen is out of the navigation, the in-context signal is
the way in, and the signal now reports three states rather than two. What is
left for a designer is how those states should feel — see *To design* at the
end. An earlier draft of this brief proposed folding the screen into the events
list as a filter; that was rejected and is not the direction. It stays a
distinct page you navigate to.

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

It stays a page in its own right — reached, not merged into another screen —
with two ways in:

1. **Something is stuck right now.** A signal on the delivery history and the
   project health screen that finds the operator rather than waiting to be
   found.
2. **A pasted address.** The URL keeps working; people share it during
   incidents, and it is how you visit deliberately.

## The one thing that had to change

Making the signal the way in means it can no longer treat "nothing is stuck"
and "could not find out" as the same silence. It depends on a request that can
fail, and a failure at that moment reads as an all-clear — on the two screens
an operator is staring at, at the one moment the project is misbehaving.

So it now reports **three** states: stuck, nothing stuck, and could-not-check.
The third is said quietly, because it is not itself bad news, but it is said.

Two objections were considered and are accepted as costs rather than solved:

- **"Did my fix work?"** Once the events unstick the signal disappears — but so
  does the thing it was reporting, so there is nothing left to confirm.
- **The screen is wider than its name.** It can also show work that is queued,
  fanning out, or already done. That view now has no entrance but the address.
  It is a rare, deliberate visit, and an address is an acceptable way to make
  one.

## To design

**The signal, in its three states.** It has to be noticed on a busy screen
without crying wolf, it has to be honestly quieter when it merely could not
check, and it has to cost nothing at all when there is nothing to say — which
is almost always. Someone who has never seen a stuck event should still be able
to tell what it leads to.

**The screen it opens.** Arrived at with no navigation to orient you, it has to
say what it is, why each event stopped, and whether putting one back will help —
two of the five causes are futile to retry, and the interface has to say so
before offering the action rather than after it appears to succeed. A stuck
event may also have fanned out *partially*, which is a different situation from
one that produced nothing.

The product is called **HookuBit**.
