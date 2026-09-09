import { findUnguardedRoutes } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import {
  HttpHarness,
  OUTBOX,
  OUTBOX_EVENTS,
  OUTBOX_PATH,
  rawOutbox,
  startOutboxApp,
} from './testing/harness';
import { OutboxEntryDto, OutboxEntryListDto, RequeueResultDto } from './dto';

/**
 * The recovery surface, over the wire, through the real guards.
 *
 * Two things are being fenced here and both are load-bearing.
 *
 * **Requeue is privileged.** It is the one route in this module that
 * manufactures outbound traffic: every requeued row becomes a fan-out and every
 * fan-out becomes real HTTP to a customer's endpoints - very often the same
 * endpoints that were failing when the incident started. It carries
 * `events.replay` AND `deliveries.replay`, exactly as event replay does, so a
 * `viewer` can watch the incident and cannot act on it.
 *
 * **A parked row is invisible outside its tenant.** `event_outbox` carries no
 * organization_id or project_id; it is scoped through its event. A bug in that
 * predicate would not fail loudly, it would quietly widen - so the fixture seeds
 * parked rows in the neighbouring project and the neighbouring organization and
 * every listing test asserts they did not come back.
 */
describe('outbox routes', () => {
  let h: HttpHarness;

  beforeEach(async () => {
    h = await startOutboxApp();
  });

  afterEach(async () => {
    await h.close();
  });

  it('leaves no route unguarded', () => {
    // Without this, a route that forgot @Authorized would be reachable by any
    // authenticated user in the tenant, and no other test would notice.
    expect(findUnguardedRoutes(h.app)).toEqual([]);
  });

  describe('authentication and tenancy', () => {
    it('401s without a session', async () => {
      const res = await h.call(`GET`, `${OUTBOX_PATH}`);
      expect(res.status).toBe(401);
    });

    it('404s a project in another organization', async () => {
      const res = await h.call('GET', `/v1/projects/${IDS.projectB1}/outbox`, {
        as: IDS.ownerA,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /outbox', () => {
    it('lists this project\'s entries for a viewer', async () => {
      const res = await h.call<OutboxEntryListDto>(`GET`, `${OUTBOX_PATH}?status=failed`, {
        as: IDS.viewerA,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.map((row) => row.id).sort()).toEqual(
        [OUTBOX.parkedMidFanOut, OUTBOX.parkedPoison, OUTBOX.parkedStale].sort(),
      );
      expect(res.body).toHaveProperty('has_more');
      expect(res.body).toHaveProperty('next_offset');
    });

    it('never returns another tenant\'s parked rows', async () => {
      const res = await h.call<OutboxEntryListDto>(`GET`, `${OUTBOX_PATH}?limit=200`, {
        as: IDS.ownerA,
      });
      const ids = res.body.data.map((row) => row.id);
      expect(ids).not.toContain(OUTBOX.parkedOtherProject);
      expect(ids).not.toContain(OUTBOX.parkedOtherOrg);
    });

    it('refuses an unknown query parameter rather than ignoring it', async () => {
      // forbidNonWhitelisted: a typo in a filter must not silently widen a
      // listing an operator believes is narrow.
      const res = await h.call(`GET`, `${OUTBOX_PATH}?stat=failed`, { as: IDS.ownerA });
      expect(res.status).toBe(400);
    });

    it('refuses a status that is not an outbox status', async () => {
      const res = await h.call(`GET`, `${OUTBOX_PATH}?status=exhausted`, { as: IDS.ownerA });
      expect(res.status).toBe(400);
    });

    it('is denied to a member with no events.read', async () => {
      const res = await h.call(`GET`, `${OUTBOX_PATH}`, { as: IDS.billingA });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /outbox/:id', () => {
    it('returns one entry with the router-side state', async () => {
      const res = await h.call<OutboxEntryDto>('GET', `${OUTBOX_PATH}/${OUTBOX.parkedStale}`, {
        as: IDS.viewerA,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: OUTBOX.parkedStale,
        event_id: OUTBOX_EVENTS.parkedStale,
        status: 'failed',
        attempts: 63,
        unaccounted_attempts: 0,
      });
      expect(res.body.failing_since).toBe('2026-03-03T10:00:00.000Z');
    });

    it('404s another tenant\'s entry', async () => {
      const res = await h.call('GET', `${OUTBOX_PATH}/${OUTBOX.parkedOtherOrg}`, {
        as: IDS.ownerA,
      });
      expect(res.status).toBe(404);
      expect(res.body.error?.message).toBe('Resource not found.');
    });
  });

  describe('POST /outbox/:id/requeue', () => {
    it('requeues a parked entry for a developer', async () => {
      const res = await h.call<OutboxEntryDto>(
        'POST',
        `${OUTBOX_PATH}/${OUTBOX.parkedPoison}/requeue`,
        { as: IDS.developerA, body: { reason: 'postgres failover' } },
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(rawOutbox(h.db, OUTBOX.parkedPoison).status).toBe('pending');
    });

    it('is denied to a viewer, who may watch an incident but not act on it', async () => {
      const res = await h.call('POST', `${OUTBOX_PATH}/${OUTBOX.parkedPoison}/requeue`, {
        as: IDS.viewerA,
        body: {},
      });
      expect(res.status).toBe(403);
      expect(rawOutbox(h.db, OUTBOX.parkedPoison).status).toBe('failed');
    });

    it('409s an entry that already fanned out', async () => {
      const res = await h.call('POST', `${OUTBOX_PATH}/${OUTBOX.processed}/requeue`, {
        as: IDS.ownerA,
        body: {},
      });
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('conflict');
    });

    it('404s another tenant\'s parked entry without touching it', async () => {
      const res = await h.call('POST', `${OUTBOX_PATH}/${OUTBOX.parkedOtherOrg}/requeue`, {
        as: IDS.ownerA,
        body: {},
      });
      expect(res.status).toBe(404);
      expect(rawOutbox(h.db, OUTBOX.parkedOtherOrg).status).toBe('failed');
    });

    it('rejects a body field nobody declared', async () => {
      const res = await h.call('POST', `${OUTBOX_PATH}/${OUTBOX.parkedPoison}/requeue`, {
        as: IDS.ownerA,
        body: { status: 'processed' },
      });
      expect(res.status).toBe(400);
    });

    it('answers in the shared error envelope, with the details an operator needs', async () => {
      const res = await h.call('POST', `${OUTBOX_PATH}/${OUTBOX.processing}/requeue`, {
        as: IDS.ownerA,
        body: {},
      });
      expect(res.body.error).toMatchObject({ code: 'conflict' });
      expect(res.body.error?.message).toBeTruthy();
      // The current status, so the caller can tell "already running" from
      // "already done" without a second request.
      expect(res.body.error?.details).toMatchObject({
        outbox_id: OUTBOX.processing,
        outbox_status: 'processing',
      });
    });
  });

  describe('POST /outbox/requeue', () => {
    it('requeues every parked entry in the project', async () => {
      const res = await h.call<RequeueResultDto>('POST', `${OUTBOX_PATH}/requeue`, {
        as: IDS.adminA,
        body: { reason: 'incident 4471' },
      });
      expect(res.status).toBe(200);
      expect(res.body.requeued).toBe(3);
      expect(res.body.has_more).toBe(false);
      expect(rawOutbox(h.db, OUTBOX.parkedOtherProject).status).toBe('failed');
      expect(rawOutbox(h.db, OUTBOX.parkedOtherOrg).status).toBe('failed');
    });

    it('does not collide with the :outboxId/requeue route', async () => {
      // Different path depths, but worth pinning: if Nest ever matched
      // `/outbox/requeue` as `:outboxId` the bulk route would 404 on an outbox
      // entry literally named "requeue".
      const res = await h.call<RequeueResultDto>('POST', `${OUTBOX_PATH}/requeue`, {
        as: IDS.ownerA,
        body: {},
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('requeued');
    });

    it('is denied to a viewer', async () => {
      const res = await h.call('POST', `${OUTBOX_PATH}/requeue`, { as: IDS.viewerA, body: {} });
      expect(res.status).toBe(403);
    });

    it('scopes to one event when asked', async () => {
      const res = await h.call<RequeueResultDto>('POST', `${OUTBOX_PATH}/requeue`, {
        as: IDS.ownerA,
        body: { event_id: OUTBOX_EVENTS.parkedStale },
      });
      expect(res.status).toBe(200);
      expect(res.body.requeued).toBe(1);
      expect(rawOutbox(h.db, OUTBOX.parkedPoison).status).toBe('failed');
    });

    it('404s an event in another tenant', async () => {
      const res = await h.call('POST', `${OUTBOX_PATH}/requeue`, {
        as: IDS.ownerA,
        body: { event_id: OUTBOX_EVENTS.parkedOtherOrg },
      });
      expect(res.status).toBe(404);
      expect(rawOutbox(h.db, OUTBOX.parkedOtherOrg).status).toBe('failed');
    });

    it('is throttled, because one call can start a burst of outbound HTTP', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const res = await h.call('POST', `${OUTBOX_PATH}/requeue`, { as: IDS.ownerA, body: {} });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    });
  });
});
