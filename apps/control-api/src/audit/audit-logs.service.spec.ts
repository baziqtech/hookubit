import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import {
  AuditHarness,
  auditHarness,
  auditMutations,
  lastAuditWhere,
  seedAuditRow,
} from './testing/harness';

describe('AuditLogsService', () => {
  let h: AuditHarness;

  beforeEach(async () => {
    h = await auditHarness();
  });

  const code = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (err) {
      if (err instanceof AppError) return err.code;
      throw err;
    }
    throw new Error('expected the call to be refused, but it resolved');
  };

  // ---------------------------------------------------------------------------
  // Tenant isolation - the whole reason this table is read through a scope
  // ---------------------------------------------------------------------------

  describe('tenant scoping', () => {
    it("returns only the caller organization's rows", async () => {
      const page = await h.service.list(h.contextA, {});

      expect(page.data.map((row) => row.id)).toEqual(['aud_a4', 'aud_a3', 'aud_a2', 'aud_a1']);
      // The point of the assertion: org B's row was sitting in the same table.
      expect(h.db.all('auditLog').map((row) => row.id)).toContain('aud_b1');
    });

    it('fences every filtered read too, not just the unfiltered one', async () => {
      // The filter a cross-tenant caller would reach for: B's own action, B's
      // own resource id. Both match a real row - in B.
      const page = await h.service.list(h.contextA, {
        action: 'endpoint.created',
        resource_id: IDS.endpointB1,
      });

      expect(page.data).toEqual([]);
      expect(lastAuditWhere(h.db).tenant).toEqual({ organizationId: IDS.orgA });
    });

    it('answers 404 with the cross-tenant message for another tenant’s row by id', async () => {
      expect(await code(h.service.get(h.contextA, 'aud_b1'))).toBe('not_found');
      const err = await h.service.get(h.contextA, 'aud_b1').catch((e: AppError) => e);
      // The SAME message an id that never existed gets. A distinct one would
      // confirm that a guessed id names a real row in someone else's tenant.
      const absent = await h.service.get(h.contextA, 'aud_nope').catch((e: AppError) => e);
      expect((err as AppError).message).toBe((absent as AppError).message);
    });

    it('serves a row inside the tenant by id', async () => {
      const row = await h.service.get(h.contextA, 'aud_a3');
      expect(row).toMatchObject({
        id: 'aud_a3',
        organization_id: IDS.orgA,
        user_id: IDS.adminA,
        action: 'api_key.revoked',
        resource_type: 'api_key',
        resource_id: 'ak_a1',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The filters an investigator actually needs
  // ---------------------------------------------------------------------------

  describe('filters', () => {
    it('filters by actor', async () => {
      const page = await h.service.list(h.contextA, { user_id: IDS.adminA });
      expect(page.data.map((row) => row.id)).toEqual(['aud_a3', 'aud_a2']);
    });

    it('filters by action, exactly - never by prefix', async () => {
      const page = await h.service.list(h.contextA, { action: 'endpoint.created' });
      expect(page.data.map((row) => row.id)).toEqual(['aud_a1']);

      // "endpoint." must NOT behave as a wildcard: a filter that silently
      // widened would be the Convoy defect this whole platform exists over.
      const prefix = await h.service.list(h.contextA, { action: 'endpoint.' });
      expect(prefix.data).toEqual([]);
    });

    it('filters by resource type', async () => {
      const page = await h.service.list(h.contextA, { resource_type: 'endpoint' });
      expect(page.data.map((row) => row.id)).toEqual(['aud_a2', 'aud_a1']);
    });

    it('filters by resource id - "what happened to this endpoint?"', async () => {
      const page = await h.service.list(h.contextA, { resource_id: IDS.endpointA1 });
      expect(page.data.map((row) => row.id)).toEqual(['aud_a2', 'aud_a1']);
    });

    it('combines filters with AND, not OR', async () => {
      const page = await h.service.list(h.contextA, {
        user_id: IDS.adminA,
        resource_type: 'endpoint',
      });
      expect(page.data.map((row) => row.id)).toEqual(['aud_a2']);
    });

    it('puts the date range in the WHERE clause as an inclusive gte/lte pair', async () => {
      // Asserted on the emitted predicate rather than only on the returned rows:
      // the in-memory fake compares range operands as strings, so a row-count
      // assertion alone could pass over a predicate PostgreSQL would read
      // differently. This checks the thing that goes to the database.
      await h.service.list(h.contextA, {
        created_after: '2026-09-02T00:00:00.000Z',
        created_before: '2026-09-03T23:59:59.000Z',
      });

      expect(lastAuditWhere(h.db).filter).toEqual({
        createdAt: {
          gte: new Date('2026-09-02T00:00:00.000Z'),
          lte: new Date('2026-09-03T23:59:59.000Z'),
        },
      });
    });

    it('accepts an open-ended range from either side', async () => {
      await h.service.list(h.contextA, { created_after: '2026-09-02T00:00:00.000Z' });
      expect(lastAuditWhere(h.db).filter).toEqual({
        createdAt: { gte: new Date('2026-09-02T00:00:00.000Z') },
      });

      await h.service.list(h.contextA, { created_before: '2026-09-02T00:00:00.000Z' });
      expect(lastAuditWhere(h.db).filter).toEqual({
        createdAt: { lte: new Date('2026-09-02T00:00:00.000Z') },
      });
    });

    it('refuses an inverted range rather than answering "nothing happened"', async () => {
      // An empty page here would read as "no activity in that window", which is
      // the one answer an audit log must never give by accident.
      expect(
        await code(
          h.service.list(h.contextA, {
            created_after: '2026-09-05T00:00:00.000Z',
            created_before: '2026-09-01T00:00:00.000Z',
          }),
        ),
      ).toBe('invalid_request');
    });

    it('refuses an unparseable timestamp rather than handing Prisma an Invalid Date', async () => {
      // The DTO's `@IsISO8601` is only reached over HTTP; this service is a
      // plain class a job or a CLI can call directly, and an Invalid Date
      // reaching the query layer is a 500 instead of the 400 the caller earned.
      expect(await code(h.service.list(h.contextA, { created_after: 'not-a-timestamp' }))).toBe(
        'invalid_request',
      );
      expect(await code(h.service.list(h.contextA, { created_before: 'not-a-timestamp' }))).toBe(
        'invalid_request',
      );
    });

    it('emits no filter clause at all when no filter was asked for', async () => {
      await h.service.list(h.contextA, {});
      expect(lastAuditWhere(h.db).filter).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // The canonical envelope
  // ---------------------------------------------------------------------------

  describe('paging', () => {
    it('returns exactly { data, has_more, next_offset }', async () => {
      const page = await h.service.list(h.contextA, {});
      expect(Object.keys(page).sort()).toEqual(['data', 'has_more', 'next_offset']);
    });

    it('reports has_more with a numeric next_offset when the bound was reached', async () => {
      const page = await h.service.list(h.contextA, { limit: 2 });
      expect(page.data).toHaveLength(2);
      expect(page.has_more).toBe(true);
      expect(page.next_offset).toBe(2);
    });

    it('is honest at exactly the page boundary: a full page that is also the last', async () => {
      // Four rows in org A, limit=4. The page is completely full AND there is
      // nothing after it - the case a bare array cannot express, and the case
      // where a client testing `data.length === limit` loops forever.
      const exact = await h.service.list(h.contextA, { limit: 4 });
      expect(exact.data).toHaveLength(4);
      expect(exact.has_more).toBe(false);
      expect(exact.next_offset).toBeNull();
    });

    it('walks to the last page through next_offset, where next_offset is null', async () => {
      const first = await h.service.list(h.contextA, { limit: 3 });
      expect(first.next_offset).toBe(3);

      const last = await h.service.list(h.contextA, { limit: 3, offset: first.next_offset ?? 0 });
      expect(last.data.map((row) => row.id)).toEqual(['aud_a1']);
      expect(last.has_more).toBe(false);
      // Null, not 0 and not absent, so a client branches on one thing.
      expect(last.next_offset).toBeNull();
      expect('next_offset' in last).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Redaction is the writer's job; this module must not undo it
  // ---------------------------------------------------------------------------

  describe('metadata', () => {
    it('serves metadata exactly as stored, redactions included', async () => {
      const page = await h.service.list(h.contextA, { action: 'endpoint.created' });
      expect(page.data[0].metadata).toEqual({ name: 'finance', signing_secret: '[redacted]' });
    });

    it('does not reach back to the resource to fill in a redacted value', async () => {
      // The endpoint the row describes is in the same fixture and readable; if
      // this module ever "enriched" metadata from it, this row would stop
      // reading back as the writer left it.
      const row = await h.service.get(h.contextA, 'aud_a1');
      expect(row.metadata).toEqual({ name: 'finance', signing_secret: '[redacted]' });
      expect(Object.keys(row.metadata ?? {})).toEqual(['name', 'signing_secret']);
    });

    it('renders a null metadata column as null rather than an empty object', async () => {
      const row = await h.service.get(h.contextA, 'aud_a2');
      expect(row.metadata).toBeNull();
    });

    it('renders a non-object JSON value as null rather than coercing it', async () => {
      // Not a shape AuditService can write; if one is ever in the table, it must
      // not be served as an object-shaped lie.
      h.db.insert('auditLog', {
        id: 'aud_a5',
        organizationId: IDS.orgA,
        userId: IDS.ownerA,
        apiKeyId: null,
        action: 'weird.thing',
        resourceType: 'thing',
        resourceId: null,
        metadata: ['not', 'an', 'object'],
        ipAddress: null,
        userAgent: null,
        createdAt: '2026-09-06T00:00:00.000Z',
      });
      const row = await h.service.get(h.contextA, 'aud_a5');
      expect(row.metadata).toBeNull();
    });

    it('copies metadata rather than aliasing the stored row', async () => {
      const row = await h.service.get(h.contextA, 'aud_a1');
      (row.metadata as Record<string, unknown>).name = 'mutated';
      const again = await h.service.get(h.contextA, 'aud_a1');
      expect(again.metadata).toEqual({ name: 'finance', signing_secret: '[redacted]' });
    });
  });

  // ---------------------------------------------------------------------------
  // Append-only, enforced rather than asserted in prose
  // ---------------------------------------------------------------------------

  describe('read-only', () => {
    it('issues no create, update or delete against audit_logs on any code path', async () => {
      seedAuditRow(h.db, {
        id: 'aud_a9',
        organizationId: IDS.orgA,
        userId: IDS.ownerA,
        action: 'project.created',
        resourceType: 'project',
        createdAt: '2026-09-07T00:00:00.000Z',
      });
      const before = h.db.all('auditLog').length;

      await h.service.list(h.contextA, {});
      await h.service.list(h.contextA, { user_id: IDS.ownerA, limit: 1 });
      await h.service.get(h.contextA, 'aud_a1');
      await h.service.get(h.contextA, 'aud_b1').catch(() => undefined);

      expect(auditMutations(h.db)).toEqual([]);
      expect(h.db.all('auditLog')).toHaveLength(before);
    });

    it('exposes no method that could write one', () => {
      const surface = Object.getOwnPropertyNames(
        Object.getPrototypeOf(h.service) as object,
      ).filter((name) => name !== 'constructor');
      expect(surface.sort()).toEqual(['get', 'list']);
    });
  });
});
