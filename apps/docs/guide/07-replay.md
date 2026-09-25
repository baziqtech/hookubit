# Replay

Re-sending something that already went out - or never arrived. What a replay does, what it does not do, and why it is new work rather than a second chance for the old row.

## Two shapes of replay

| Route | Re-sends | Use it when |
|---|---|---|
| `POST /v1/projects/{projectId}/deliveries/{deliveryId}/replay` | **One delivery**: this event to this endpoint. | "Finance did not get event X." The usual case. |
| `POST /v1/projects/{projectId}/events/{eventId}/replay` with `{"endpoint_id": "ep_…"}` | One delivery, addressed by event and endpoint instead of by delivery id. | You are looking at the event, not the delivery. Same result as the row above. |
| `POST /v1/projects/{projectId}/events/{eventId}/replay` with no `endpoint_id` | **Every endpoint the event originally reached**, one new delivery each. | "Everyone needs event X again." |

Both accept an optional `reason` (up to 500 characters). It goes to the audit log and nowhere else - it is not written onto the delivery.

In the dashboard, *Replay* is on the delivery detail page and on the event detail page.

## What is re-sent

A replay creates a **new delivery row** for the same event and the same endpoint, and the worker treats it like any other delivery:

| Property | Value on the replay |
|---|---|
| Payload | The event's stored bytes - exactly what was published, exactly what was sent before. |
| Endpoint | The same endpoint, as it is configured **now**: current URL, current custom headers, current active secrets. |
| Signature | Computed fresh, with the current secrets and a new timestamp. An old captured signature will not match a replay. |
| `Webhook-Id` | **The same** - it is the event id. |
| `Webhook-Delivery-Id` | **New.** |
| `Webhook-Attempt` | Restarts at `1`. |
| Retry budget | `attempt_count` 0, and the **original's** `max_attempts` - a replay is a re-run of that delivery under the contract it was created with, not under today's policy. |
| State | `pending`, due immediately. |

The original delivery is **not modified**. It keeps its status, its attempt count, its error and every attempt row. The new row points back at it through `replay_of_delivery_id`, and carries `replayed_by` (the user who asked). `is_replay` is `true`. A subscription that has been deleted since the original is simply absent from the replay (`subscription_id: null`); the provenance that matters is the original delivery, which is never deleted.

::: tip Why a replay is "new work"
A delivery is a promise with a budget. When the budget is spent, the row is a record, and a record must not be rewritten - otherwise "what happened to this event?" has two answers depending on when you asked. So a replay does not resurrect the old row; it makes a new promise, with its own history, that happens to be for the same event. The audit log records both ids.

For your receiver: dedupe on `Webhook-Id` if a replay should be a no-op, on `Webhook-Delivery-Id` if a replay should be processed again. See [Be idempotent](./04-receiving-webhooks.md#be-idempotent).
:::

You may replay a delivery in any state, including `succeeded`. Duplicates are by design; the receiver decides what a duplicate means.

## What is not re-sent

**Replay-to-all uses the original routing, not today's subscriptions.** "Every endpoint the event originally reached" is read off the existing delivery rows. An endpoint subscribed *since* the event was published does not receive it, and an endpoint whose subscription has since been narrowed or deleted still does. The operator asking for a replay is asking for what happened, not what would happen if the event were published now.

For the same reason, `endpoint_id` must name an endpoint that already has a delivery for this event. Sending an event somewhere for the first time is a new delivery, not a replay, and is refused.

**Replay never re-runs subscription matching.** If the event never reached an endpoint because the subscription did not match, the endpoint was paused, or the event is still parked before routing, replay has nothing to work from. The last case has its own tool: [requeue](./08-troubleshooting.md#a-parked-event).

## Refusals

| Condition | Response |
|---|---|
| The endpoint is `deleted` | `409` `conflict`. Its history is kept but nothing can be delivered to it; the worker would abandon the replay as `endpoint_deleted`. |
| The endpoint is `paused` or `disabled`, including auto-disabled | `409` `conflict`, with `endpoint_status`, `enabled` and `disabled_reason` in `details`. Re-enable it first, or the worker would abandon the replay as `endpoint_disabled`. |
| Replay-to-all would create more than **50** deliveries | `409` `limit_exceeded`, with `{limit: 50, current: N, resource: "replay_deliveries"}`. Replay per endpoint instead. |
| `endpoint_id` names an endpoint the event never reached | `409` `conflict`: there is nothing to replay to it. Add a subscription and publish the event. |
| Any endpoint in a replay-to-all is refused | The **whole** replay is refused and nothing is created - so the error names the endpoint that caused it rather than leaving a half-replayed routing. |

The 50-delivery cap on one request exists because replay is the one route that manufactures outbound HTTP to your infrastructure, and because each insert runs inside one serialisable transaction.

## Who can replay

| Permission | owner | admin | developer | viewer | billing |
|---|---|---|---|---|---|
| `deliveries.replay` (replay a delivery) | yes | yes | yes | - | - |
| `events.replay` (replay an event) | yes | yes | yes | - | - |

A viewer can read every delivery and every attempt but cannot replay: a replay puts real traffic on your endpoint, which is a write with effects outside this system. Every replay is written to the organization's audit log as `delivery.replayed` or `event.replayed` with the original ids, the created ids, the endpoints and the reason.

---

*Where this comes from:* `apps/control-api/src/deliveries/delivery-replay.service.ts` (`insertReplay` column by column, `assertReplayable`, `assertWithinReplayCap`); `deliveries/delivery-limits.ts` (`MAX_REPLAY_DELIVERIES`); `deliveries/dto/replay.dto.ts` (`ReplayEventDto`, `ReplayDeliveryDto`); `events/events.service.ts` (`replay`: the unreached-endpoint refusal); `deliveries/dto/delivery-response.dto.ts` (`replay_of_delivery_id`, `replayed_by`, `is_replay`, `ReplayResultDto`); `authz/permissions.ts`; `services/data-plane/internal/worker/deliver.go` (`AttemptNumber`, signing per attempt); `apps/control-api/openapi.json` (routes).
