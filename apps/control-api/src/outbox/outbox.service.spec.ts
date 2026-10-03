import { AppError } from '../common/errors';
import { IDS } from '../authz/testing/fixtures';
import {
  OUTBOX,
  OUTBOX_EVENTS,
  OutboxHarness,
  outboxHarness,
  rawEvent,
  rawOutbox,
  seedOutbox,
  seedParkedBulk,
} from './testing/harness';
import { MAX_REQUEUE_BATCH } from './outbox-limits';
import { OutboxService } from './outbox.service';

/**
 * THE GAP THIS MODULE CLOSES.
 *
 * A parked `event_outbox` row is an event that was answered `202 Accepted` and
 * will never be delivered. Before this module, `event_outbox` had zero
 * references anywhere in `apps/control-api/src`: the row was invisible to the
 * API and to the dashboard, and the only recovery was hand-written SQL against
 * production. Everything below is either "an operator can see it" or "an
 * operator can put it back, safely, and it is written down".
 */
describe('OutboxService', () => {
  let h: OutboxHarness;

  beforeEach(async () => {
    h = await outboxHarness();
  });

  const failure = async (work: Promise<unknown>): Promise<AppError> => {
    const err = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  };

  // -------------------------------------------------------------------------
  // Seeing what is stuck
  // -------------------------------------------------------------------------

  describe('list', () => {
    it('shows the parked rows for this project, and only this project', async () => {
      const page = await h.outbox.list(h.context, { status: 'failed' });
      const ids = page.data.map((row) => row.id).sort();

      expect(ids).toEqual(
        [OUTBOX.parkedMidRouting, OUTBOX.parkedPoison, OUTBOX.parkedStale].sort(),
      );
      // The neighbours were sitting in the same table.
      expect(ids).not.toContain(OUTBOX.parkedOtherProject);
      expect(ids).not.toContain(OUTBOX.parkedOtherOrg);
    });

    it('carries the fields that say WHY, not just that something failed', async () => {
      const page = await h.outbox.list(h.context, { status: 'failed' });
      const poison = page.data.find((row) => row.id === OUTBOX.parkedPoison);
      const stale = page.data.find((row) => row.id === OUTBOX.parkedStale);

      // The whole point of the two counters: an operator has to be able to tell
      // "this row keeps killing the router" from "the database was failing under
      // it", and those are different incidents with different fixes.
      expect(poison).toMatchObject({ attempts: 11, unaccounted_attempts: 11 });
      expect(stale).toMatchObject({ attempts: 63, unaccounted_attempts: 0 });
      expect(stale?.failing_since).toBe('2026-03-03T10:00:00.000Z');
      expect(poison?.last_error).toContain('attempts_exhausted');
    });

    it('reports a partly-completed routing as such', async () => {
      const page = await h.outbox.list(h.context, { status: 'failed' });
      const partial = page.data.find((row) => row.id === OUTBOX.parkedMidRouting);
      expect(partial?.routing_cursor).toBe('sub_01HALFWAY');
    });

    it('filters to one event', async () => {
      const page = await h.outbox.list(h.context, { event_id: OUTBOX_EVENTS.parkedPoison });
      expect(page.data.map((row) => row.id)).toEqual([OUTBOX.parkedPoison]);
    });

    it('returns a bounded page with the canonical envelope', async () => {
      const page = await h.outbox.list(h.context, { limit: 2 });
      expect(page.data).toHaveLength(2);
      expect(page.has_more).toBe(true);
      expect(page.next_offset).toBe(2);
    });

    it('orders newest first, which is what the index is built for', async () => {
      const page = await h.outbox.list(h.context, {});
      const created = page.data.map((row) => row.created_at);
      expect([...created].sort().reverse()).toEqual(created);
    });
  });

  describe('get', () => {
    it('404s a row in another project with the shared message', async () => {
      const err = await failure(h.outbox.get(h.context, OUTBOX.parkedOtherProject));
      expect(err.code).toBe('not_found');
      expect(err.message).toBe('Resource not found.');
    });

    it('404s a row in another organization identically', async () => {
      const err = await failure(h.outbox.get(h.context, OUTBOX.parkedOtherOrg));
      expect(err.code).toBe('not_found');
      expect(err.message).toBe('Resource not found.');
    });

    it('gives absent and not-yours the same answer', async () => {
      const absent = await failure(h.outbox.get(h.context, 'obx_nope'));
      const foreign = await failure(h.outbox.get(h.context, OUTBOX.parkedOtherOrg));
      expect(absent.message).toBe(foreign.message);
    });
  });

  // -------------------------------------------------------------------------
  // Putting it back
  // -------------------------------------------------------------------------

  describe('requeue', () => {
    it('returns a parked row to the queue with a fresh budget', async () => {
      const before = rawOutbox(h.db, OUTBOX.parkedPoison);
      expect(before.status).toBe('failed');

      const row = await h.outbox.requeue(h.context, OUTBOX.parkedPoison, {});

      expect(row.status).toBe('pending');
      // The two BUDGETS, and only those: `unaccounted_attempts` is the poison
      // bound and `failing_since` is the retry-duration clock. Resetting them is
      // the whole of "a fresh budget".
      expect(row.unaccounted_attempts).toBe(0);
      expect(row.failing_since).toBeNull();
      expect(row.processed_at).toBeNull();
      expect(row.locked_by).toBeNull();
      // Claimable now, not after whatever backoff the row died holding.
      expect(new Date(row.available_at).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('does NOT reset attempts - two docblocks call that column monotonic', async () => {
      // `OutboxRow.Attempts` in services/data-plane/internal/router/store.go and
      // `model EventOutbox` in schema.prisma both say this column is never
      // lowered, and both describe it as the operator's honest "how many times
      // has this been picked up?". Zeroing it here made them false after one
      // requeue: the claim count in the UI restarted, and so did the number the
      // router quotes in the next park message - losing exactly the history that
      // separates "requeued four times and still dying" from "first time".
      const before = rawOutbox(h.db, OUTBOX.parkedPoison);
      expect(before.attempts).toBe(11);

      const row = await h.outbox.requeue(h.context, OUTBOX.parkedPoison, {});

      expect(row.attempts).toBe(11);
      expect(rawOutbox(h.db, OUTBOX.parkedPoison).attempts).toBe(11);
      // And it is not a budget: the counter that decides whether the row parks
      // again was reset, so preserving this one costs the row nothing.
      expect(row.unaccounted_attempts).toBe(0);
    });

    it('preserves the router\'s last_error - it is the only record of why', async () => {
      const before = rawOutbox(h.db, OUTBOX.parkedPoison);
      const row = await h.outbox.requeue(h.context, OUTBOX.parkedPoison, {
        reason: 'database was down, not the event',
      });
      expect(row.last_error).toBe(before.lastError);
      expect(row.last_error).toContain('attempts_exhausted');
    });

    it('preserves routing_cursor, so a partial routing resumes rather than restarts', async () => {
      // Restarting is SAFE - deliveries_event_endpoint_original_key makes every
      // insert idempotent per (event, endpoint) - but it would re-walk hundreds
      // of subscriptions that already have their delivery rows.
      const row = await h.outbox.requeue(h.context, OUTBOX.parkedMidRouting, {});
      expect(row.routing_cursor).toBe('sub_01HALFWAY');
    });

    it('un-fails the event, because the router only promotes `received`', async () => {
      expect(rawEvent(h.db, OUTBOX_EVENTS.parkedPoison).status).toBe('failed');
      await h.outbox.requeue(h.context, OUTBOX.parkedPoison, {});
      // Left as `failed`, the claim's `received -> processing` promotion would
      // never match and the event would read `failed` right through a routing
      // that was working.
      expect(rawEvent(h.db, OUTBOX_EVENTS.parkedPoison).status).toBe('received');
    });

    it('writes an audit entry naming what it rescued and what was wrong', async () => {
      await h.outbox.requeue(h.context, OUTBOX.parkedPoison, { reason: 'brownout' });

      const entries = h.db.all('auditLog');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'event_outbox.requeued',
        resourceType: 'event_outbox',
        resourceId: OUTBOX.parkedPoison,
        organizationId: IDS.orgA,
        userId: IDS.ownerA,
      });
      const metadata = entries[0].metadata as Record<string, unknown>;
      expect(metadata.reason).toBe('brownout');
      expect(metadata.event_id).toBe(OUTBOX_EVENTS.parkedPoison);
      expect(metadata.project_id).toBe(IDS.projectA1);
      // The state it was rescued FROM. Without this the log says somebody
      // pressed a button and not what was wrong.
      expect(metadata.parked_attempts).toBe(11);
      expect(metadata.parked_unaccounted_attempts).toBe(11);
      expect(metadata.parked_error).toContain('attempts_exhausted');
    });

    it('refuses a row that already routed, and points at replay', async () => {
      const err = await failure(h.outbox.requeue(h.context, OUTBOX.processed, {}));
      expect(err.code).toBe('conflict');
      expect(err.message).toContain('replay');
      expect(rawOutbox(h.db, OUTBOX.processed).status).toBe('processed');
    });

    it('refuses a row a router is holding right now', async () => {
      const err = await failure(h.outbox.requeue(h.context, OUTBOX.processing, {}));
      expect(err.code).toBe('conflict');
      expect(err.details).toMatchObject({ outbox_status: 'processing' });
      expect(rawOutbox(h.db, OUTBOX.processing).lockedBy).toBe('wrk_01ROUTER');
    });

    it('refuses a row that is merely backing off', async () => {
      // `pending` with a future available_at is a row the router will pick up on
      // its own. Accepting a no-op here teaches an operator that the button does
      // nothing, which is a bad thing to learn during an incident.
      const err = await failure(h.outbox.requeue(h.context, OUTBOX.pending, {}));
      expect(err.code).toBe('conflict');
      expect(err.details).toMatchObject({ outbox_status: 'pending' });
    });

    it('404s another tenant\'s parked row without touching it', async () => {
      const err = await failure(h.outbox.requeue(h.context, OUTBOX.parkedOtherOrg, {}));
      expect(err.code).toBe('not_found');
      expect(err.message).toBe('Resource not found.');
      expect(rawOutbox(h.db, OUTBOX.parkedOtherOrg).status).toBe('failed');
      expect(h.db.all('auditLog')).toHaveLength(0);
    });

    it('does not let two operators both claim to have requeued the same row', async () => {
      // Read-then-write over `status`, so it runs inside the transaction runner.
      // Both callers see `failed` under READ COMMITTED and both file an audit
      // entry; under the serial schedule the second sees `pending` and loses.
      const results = await Promise.allSettled([
        h.outbox.requeue(h.context, OUTBOX.parkedPoison, {}),
        h.outbox.requeue(h.context, OUTBOX.parkedPoison, {}),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      expect(h.db.all('auditLog')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Putting a lot back
  // -------------------------------------------------------------------------

  describe('requeueParked', () => {
    it('requeues every parked row in the project and nobody else\'s', async () => {
      const result = await h.outbox.requeueParked(h.context, {});

      expect(result.requeued).toBe(3);
      expect(result.has_more).toBe(false);
      expect(result.data.every((row) => row.status === 'pending')).toBe(true);

      expect(rawOutbox(h.db, OUTBOX.parkedOtherProject).status).toBe('failed');
      expect(rawOutbox(h.db, OUTBOX.parkedOtherOrg).status).toBe('failed');
      // And it left alone everything that was not parked.
      expect(rawOutbox(h.db, OUTBOX.processed).status).toBe('processed');
      expect(rawOutbox(h.db, OUTBOX.processing).status).toBe('processing');
      expect(rawOutbox(h.db, OUTBOX.pending).status).toBe('pending');
    });

    it('takes the oldest first, because those consumers have waited longest', async () => {
      const result = await h.outbox.requeueParked(h.context, {});
      expect(result.data.map((row) => row.id)).toEqual([
        OUTBOX.parkedPoison,
        OUTBOX.parkedStale,
        OUTBOX.parkedMidRouting,
      ]);
    });

    it('scopes to one event when asked', async () => {
      const result = await h.outbox.requeueParked(h.context, {
        event_id: OUTBOX_EVENTS.parkedStale,
      });
      expect(result.requeued).toBe(1);
      expect(result.data[0].id).toBe(OUTBOX.parkedStale);
      expect(rawOutbox(h.db, OUTBOX.parkedPoison).status).toBe('failed');
    });

    it('404s an event in another tenant rather than reporting "nothing parked"', async () => {
      // Genuinely different answers: an empty result would have an operator
      // conclude the event is fine when they are looking at the wrong project.
      const err = await failure(
        h.outbox.requeueParked(h.context, { event_id: OUTBOX_EVENTS.parkedOtherOrg }),
      );
      expect(err.code).toBe('not_found');
      expect(rawOutbox(h.db, OUTBOX.parkedOtherOrg).status).toBe('failed');
    });

    it('is bounded, and says so, so an operator can tell "that is all" from "call again"', async () => {
      seedParkedBulk(h.db, MAX_REQUEUE_BATCH);

      const first = await h.outbox.requeueParked(h.context, {});
      expect(first.requeued).toBe(MAX_REQUEUE_BATCH);
      expect(first.has_more).toBe(true);

      const second = await h.outbox.requeueParked(h.context, {});
      expect(second.requeued).toBe(3);
      expect(second.has_more).toBe(false);
    });

    it('writes a FULL page in the same number of statements as a three-row one', async () => {
      // THE RECOVERY PATH WAS LEAST RELIABLE EXACTLY WHEN IT WAS NEEDED.
      //
      // The bulk form used to call the single-row state change in a loop, and
      // each iteration cost three round trips (`updateById` is an `updateMany`
      // plus a `findFirst` read-back, and the event update is a third). A full
      // MAX_REQUEUE_BATCH page was therefore ~300 sequential statements inside
      // ONE interactive transaction that `TenantTransactionRunner` opens with no
      // `timeout` - so Prisma's default 5000 ms applied. At 20 ms a round trip,
      // entirely plausible on the degraded database that parked the rows in the
      // first place, it hit P2028 and rolled back; P2028 is not a serialisation
      // failure, so nothing retried and the operator got a 500 having recovered
      // ZERO rows.
      //
      // Asserting EQUALITY rather than a ceiling, because the property is that
      // the transaction's width does not depend on the page's. A ceiling picked
      // with slack in it would let a per-row statement creep back at any page
      // size below the ceiling.
      const small = await outboxHarness();
      const smallFrom = small.db.queries.length;
      const smallResult = await small.outbox.requeueParked(small.context, {});
      const smallStatements = small.db.queries.length - smallFrom;
      expect(smallResult.requeued).toBe(3);
      // Not vacuous, and small: the equality below would also hold if the fake
      // recorded nothing at all.
      expect(smallStatements).toBeGreaterThan(0);
      expect(smallStatements).toBeLessThan(20);

      const full = await outboxHarness(IDS.ownerA, undefined, seedParkedBulk(seedOutbox(), MAX_REQUEUE_BATCH));
      const fullFrom = full.db.queries.length;
      const fullResult = await full.outbox.requeueParked(full.context, {});
      const fullStatements = full.db.queries.length - fullFrom;

      expect(fullResult.requeued).toBe(MAX_REQUEUE_BATCH);
      expect(fullStatements).toBe(smallStatements);
      // And the page really was written, not merely counted.
      expect(fullResult.data).toHaveLength(MAX_REQUEUE_BATCH);
      expect(fullResult.data.every((row) => row.status === 'pending')).toBe(true);
      expect(rawOutbox(full.db, 'obx_bulk_0099').status).toBe('failed'); // beyond the page
    });

    it('preserves attempts across a full page, and resets only the budgets', async () => {
      const full = await outboxHarness(IDS.ownerA, undefined, seedParkedBulk(seedOutbox(), MAX_REQUEUE_BATCH));
      const result = await full.outbox.requeueParked(full.context, {});

      expect(result.requeued).toBe(MAX_REQUEUE_BATCH);
      const bulk = result.data.filter((row) => row.id.startsWith('obx_bulk_'));
      expect(bulk.length).toBeGreaterThan(0);
      // Monotonic in bulk as well as singly - schema.prisma and store.go both
      // say this column is never lowered, and the bulk path is the one an
      // operator actually uses during an incident.
      expect(bulk.every((row) => row.attempts === 11)).toBe(true);
      expect(bulk.every((row) => row.unaccounted_attempts === 0)).toBe(true);
      expect(bulk.every((row) => row.failing_since === null)).toBe(true);
      // The event side of the page moved too, or the router would never promote
      // `received -> processing` for any of them.
      expect(rawEvent(full.db, 'evt_bulk_0000').status).toBe('received');
    });

    it('audits a requeue that found nothing, because that is a fact about an incident too', async () => {
      await h.outbox.requeueParked(h.context, {});
      const again = await h.outbox.requeueParked(h.context, {});

      expect(again.requeued).toBe(0);
      const entries = h.db.all('auditLog');
      expect(entries).toHaveLength(2);
      expect((entries[1].metadata as Record<string, unknown>).requeued_count).toBe(0);
    });

    it('records both sides of the mapping in the audit entry', async () => {
      await h.outbox.requeueParked(h.context, { reason: 'postgres failover' });
      const metadata = h.db.all('auditLog')[0].metadata as Record<string, unknown>;

      expect(metadata.scope).toBe('project');
      expect(metadata.reason).toBe('postgres failover');
      expect(metadata.requeued_count).toBe(3);
      expect(metadata.requeued_outbox_ids).toEqual([
        OUTBOX.parkedPoison,
        OUTBOX.parkedStale,
        OUTBOX.parkedMidRouting,
      ]);
      expect(metadata.requeued_event_ids).toContain(OUTBOX_EVENTS.parkedPoison);
    });
  });

  // -------------------------------------------------------------------------

  describe('filterWhere', () => {
    it('builds only what was asked for; the tenant predicate is never its job', async () => {
      // ScopedRepository ANDs the tenant predicate onto whatever this returns.
      // If this function ever tried to add one, there would be two places that
      // could be wrong about tenancy instead of one.
      expect(OutboxService.filterWhere({})).toEqual({});
      expect(OutboxService.filterWhere({ status: 'failed', event_id: 'evt_1' })).toEqual({
        status: 'failed',
        eventId: 'evt_1',
      });
    });
  });
});
