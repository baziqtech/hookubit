import { beforeEach, describe, expect, it } from 'vitest';
import type { EventDetail, OffsetPage, OutboxEntry, RequeueResult } from '../../types/api';
import { MAX_REQUEUE_BATCH } from '../../types/api';
import * as db from './data';
import { MockHttpError, mockRequest, resetMockState } from './server';

/**
 * The outbox routes, held to the real contract: the one list envelope, the
 * documented status codes (400 on an undeclared filter, 404 with the shared
 * cross-tenant message, 409 with `outbox_status` in the details, 429 once the
 * bucket is spent), and the requeue semantics `OutboxService.returnToQueue`
 * spells out — budgets reset, history preserved, event un-failed.
 */
const PROJECT = db.projects[0].id;
const OUTBOX = `/v1/projects/${PROJECT}/outbox`;

const parkedRows = () =>
  db.outbox.filter((entry) => entry.status === 'failed');

async function expectFailure(work: Promise<unknown>): Promise<MockHttpError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof MockHttpError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

beforeEach(() => resetMockState());

describe('GET /outbox', () => {
  it('has one row per event, and more parked rows than one bulk pass may return', () => {
    expect(db.outbox).toHaveLength(db.events.length);
    expect(parkedRows().length).toBeGreaterThan(MAX_REQUEUE_BATCH);
    // The fan-out-failed event is parked with its cursor set, so the "partly
    // done" branch of the UI is reachable.
    expect(parkedRows().some((entry) => entry.fan_out_cursor !== null)).toBe(true);
    // Both park reasons are represented, as the router writes them.
    expect(parkedRows().some((entry) => entry.last_error?.startsWith('attempts_exhausted:'))).toBe(true);
    expect(
      parkedRows().some((entry) => entry.last_error?.startsWith('retry_duration_exceeded:')),
    ).toBe(true);
  });

  it('filters by status in the one offset envelope, newest first', async () => {
    const page = await mockRequest<OffsetPage<OutboxEntry>>('GET', `${OUTBOX}?status=failed&limit=10`);
    expect(page.data).toHaveLength(10);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(10);
    expect(page.data.every((entry) => entry.status === 'failed')).toBe(true);
    for (let index = 1; index < page.data.length; index += 1) {
      expect(page.data[index - 1].created_at >= page.data[index].created_at).toBe(true);
    }
  });

  it('filters by event_id', async () => {
    const parked = parkedRows()[0];
    const page = await mockRequest<OffsetPage<OutboxEntry>>(
      'GET',
      `${OUTBOX}?event_id=${parked.event_id}`,
    );
    expect(page.data.map((entry) => entry.id)).toEqual([parked.id]);
  });

  it('refuses a status that is not an outbox status', async () => {
    const error = await expectFailure(mockRequest('GET', `${OUTBOX}?status=exhausted`));
    expect(error.status).toBe(400);
    expect(error.body.error.code).toBe('invalid_request');
  });

  it('refuses an undeclared query parameter rather than widening the listing', async () => {
    const error = await expectFailure(mockRequest('GET', `${OUTBOX}?stat=failed`));
    expect(error.status).toBe(400);
  });

  it('never returns another project’s rows', async () => {
    const other = db.projects[1].id;
    const page = await mockRequest<OffsetPage<OutboxEntry>>(
      'GET',
      `/v1/projects/${other}/outbox?limit=200`,
    );
    const owned = new Set(
      db.events.filter((event) => event.project_id === other).map((event) => event.id),
    );
    expect(page.data.every((entry) => owned.has(entry.event_id))).toBe(true);
  });
});

describe('GET /outbox/:id', () => {
  it('returns the row', async () => {
    const parked = parkedRows()[0];
    const row = await mockRequest<OutboxEntry>('GET', `${OUTBOX}/${parked.id}`);
    expect(row).toMatchObject({ id: parked.id, status: 'failed' });
  });

  it('404s with the shared cross-tenant message', async () => {
    const error = await expectFailure(mockRequest('GET', `${OUTBOX}/obx_nope`));
    expect(error.status).toBe(404);
    expect(error.body.error.message).toBe('Resource not found.');
  });
});

describe('POST /outbox/:id/requeue', () => {
  it('returns the row to the queue: budgets reset, history preserved, event un-failed', async () => {
    const parked = parkedRows().find((entry) => entry.fan_out_cursor !== null)!;
    const before = { ...parked };
    const event = db.events.find((candidate) => candidate.id === parked.event_id)!;
    expect(event.status).toBe('failed');

    const row = await mockRequest<OutboxEntry>('POST', `${OUTBOX}/${parked.id}/requeue`, {
      reason: 'postgres failover',
    });

    expect(row.status).toBe('pending');
    expect(row.unaccounted_attempts).toBe(0);
    expect(row.failing_since).toBeNull();
    expect(row.processed_at).toBeNull();
    expect(row.locked_by).toBeNull();
    // Monotonic: the claim count survives the recovery.
    expect(row.attempts).toBe(before.attempts);
    // The evidence survives too.
    expect(row.last_error).toBe(before.last_error);
    expect(row.fan_out_cursor).toBe(before.fan_out_cursor);

    const after = await mockRequest<EventDetail>(
      'GET',
      `/v1/projects/${PROJECT}/events/${parked.event_id}`,
    );
    expect(after.status).toBe('received');
  });

  it('409s a row that is not parked, naming its current status', async () => {
    const processed = db.outbox.find((entry) => entry.status === 'processed')!;
    const error = await expectFailure(
      mockRequest('POST', `${OUTBOX}/${processed.id}/requeue`, {}),
    );
    expect(error.status).toBe(409);
    expect(error.body.error.code).toBe('conflict');
    expect(error.body.error.details).toMatchObject({
      outbox_id: processed.id,
      outbox_status: 'processed',
    });
  });

  it('404s an unknown row without touching anything', async () => {
    const error = await expectFailure(mockRequest('POST', `${OUTBOX}/obx_nope/requeue`, {}));
    expect(error.status).toBe(404);
  });

  it('rejects a body field nobody declared, and a reason past 500 characters', async () => {
    const parked = parkedRows()[0];
    const unknown = await expectFailure(
      mockRequest('POST', `${OUTBOX}/${parked.id}/requeue`, { status: 'processed' }),
    );
    expect(unknown.status).toBe(400);

    const long = await expectFailure(
      mockRequest('POST', `${OUTBOX}/${parked.id}/requeue`, { reason: 'x'.repeat(501) }),
    );
    expect(long.status).toBe(400);
    expect(long.body.error.message).toEqual([
      'reason: must be shorter than or equal to 500 characters',
    ]);
    // Nothing changed.
    expect(db.outbox.find((entry) => entry.id === parked.id)!.status).toBe('failed');
  });
});

describe('POST /outbox/requeue', () => {
  it('requeues oldest first, at most MAX_REQUEUE_BATCH, and says has_more until drained', async () => {
    const total = parkedRows().length;
    const oldest = [...parkedRows()].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];

    const first = await mockRequest<RequeueResult>('POST', `${OUTBOX}/requeue`, {
      reason: 'incident 4471',
    });
    expect(first.requeued).toBe(MAX_REQUEUE_BATCH);
    expect(first.has_more).toBe(true);
    expect(first.data).toHaveLength(MAX_REQUEUE_BATCH);
    expect(first.data[0].id).toBe(oldest.id);
    expect(first.data.every((entry) => entry.status === 'pending')).toBe(true);

    // THE LOOP. Call again until has_more is false; the total must equal the
    // parked set exactly — no row missed, no row requeued twice.
    let recovered = first.requeued;
    let hasMore = first.has_more;
    let passes = 1;
    while (hasMore) {
      const next = await mockRequest<RequeueResult>('POST', `${OUTBOX}/requeue`, {
        reason: 'incident 4471',
      });
      recovered += next.requeued;
      hasMore = next.has_more;
      passes += 1;
    }
    expect(passes).toBe(Math.ceil(total / MAX_REQUEUE_BATCH));
    expect(recovered).toBe(total);
    expect(parkedRows()).toHaveLength(0);
    expect(db.events.some((event) => event.status === 'failed')).toBe(false);
  });

  it('scopes to one event when asked, and 404s an event it cannot see', async () => {
    const parked = parkedRows()[0];
    const scoped = await mockRequest<RequeueResult>('POST', `${OUTBOX}/requeue`, {
      event_id: parked.event_id,
    });
    expect(scoped.requeued).toBe(1);
    expect(scoped.has_more).toBe(false);
    expect(parkedRows()).toHaveLength(db.outbox.filter((e) => e.status === 'failed').length);

    const error = await expectFailure(
      mockRequest('POST', `${OUTBOX}/requeue`, { event_id: 'evt_someone_elses' }),
    );
    expect(error.status).toBe(404);
    expect(error.body.error.message).toBe('Resource not found.');
  });

  it('answers a zero-row requeue with 200 and requeued: 0, not an error', async () => {
    const processedEvent = db.outbox.find((entry) => entry.status === 'processed')!.event_id;
    const result = await mockRequest<RequeueResult>('POST', `${OUTBOX}/requeue`, {
      event_id: processedEvent,
    });
    expect(result).toEqual({ requeued: 0, has_more: false, data: [] });
  });

  it('is throttled — 10 passes per window, shared with the single-row route', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await mockRequest('POST', `${OUTBOX}/requeue`, { event_id: 'evt_nope' });
        statuses.push(200);
      } catch (error) {
        statuses.push((error as MockHttpError).status);
      }
    }
    expect(statuses.slice(0, 10).every((status) => status === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('is rewound by resetMockState, event statuses included', async () => {
    await mockRequest<RequeueResult>('POST', `${OUTBOX}/requeue`, {});
    expect(parkedRows().length).toBeLessThan(db.events.length);
    resetMockState();
    expect(parkedRows().length).toBeGreaterThan(MAX_REQUEUE_BATCH);
    expect(db.events.filter((event) => event.status === 'failed').length).toBe(parkedRows().length);
  });
});
