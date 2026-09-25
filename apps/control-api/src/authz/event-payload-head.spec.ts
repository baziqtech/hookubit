import {
  EVENT_PAYLOAD_HEAD_TAG,
  eventPayloadHeadQuery,
  readEventPayloadHeads,
} from './event-payload-head';
import { DEFAULT_TENANT_SPEC, RequestContext } from './tenant-context';
import { TenantResolver } from './tenant-resolver.service';
import { IDS, requestWith, seedWorld, sessionUser } from './testing/fixtures';

/**
 * The one hand-written statement in this layer, held to the two things that make
 * it acceptable: it carries the tenant predicate `ScopedRepository` would have
 * ANDed on, and it slices the payload IN PostgreSQL rather than fetching it.
 *
 * Asserted against the emitted SQL and its parameters, not only against the rows
 * that come back, because both properties are properties of the statement. A
 * behavioural test over the in-memory fake cannot tell a predicate that is in
 * the SQL from one the fake applied out of kindness.
 */
async function contextFor(params: Record<string, string>): Promise<RequestContext> {
  const db = seedWorld();
  return new TenantResolver(db.asPrisma()).resolve(
    sessionUser(IDS.ownerA),
    requestWith(params, IDS.ownerA),
    DEFAULT_TENANT_SPEC,
  );
}

describe('eventPayloadHeadQuery', () => {
  const ids = ['evt_1', 'evt_2'];

  it('slices in SQL and never selects the whole payload column', async () => {
    const sql = eventPayloadHeadQuery(await contextFor({ orgId: IDS.orgA }), ids, 640);

    expect(sql.text).toContain('substring(payload_raw from 1 for');
    // The FULL length still comes back - that is what says whether the slice cut
    // anything - but as a number, not as bytes.
    expect(sql.text).toContain('octet_length(payload_raw)');
    // Every mention of the column is inside one of those two. A bare
    // `payload_raw` in the select list would be up to 64 KiB per row, which is
    // the entire cost this statement exists to avoid.
    const mentions = sql.text.match(/payload_raw/g) ?? [];
    expect(mentions).toHaveLength(2);
  });

  it('carries the tenant predicate: organization AND project', async () => {
    const context = await contextFor({ orgId: IDS.orgA, projectId: IDS.projectA1 });
    const sql = eventPayloadHeadQuery(context, ids, 640);

    expect(sql.text).toContain('organization_id =');
    expect(sql.text).toContain('project_id =');
    // $1 maxBytes, $2 ids, $3 organization, $4 project - the order
    // `FakeTenantPrisma.$queryRaw` reads positionally.
    expect(sql.values).toEqual([640, ids, IDS.orgA, IDS.projectA1]);
  });

  it('falls back to the organization alone when the route resolved no project', async () => {
    // Still a complete tenant boundary - the same reading
    // `tenantPredicate('projectAndOrganization')` takes - so an org-level route
    // is scoped, not unscoped.
    const sql = eventPayloadHeadQuery(await contextFor({ orgId: IDS.orgA }), ids, 640);

    expect(sql.text).toContain('organization_id =');
    expect(sql.text).not.toContain('project_id =');
    expect(sql.values).toEqual([640, ids, IDS.orgA]);
  });

  it('is one statement of fixed arity however many ids it is given', async () => {
    const context = await contextFor({ orgId: IDS.orgA, projectId: IDS.projectA1 });

    const two = eventPayloadHeadQuery(context, ['a', 'b'], 640);
    const fifty = eventPayloadHeadQuery(
      context,
      Array.from({ length: 50 }, (_, index) => `evt_${index}`),
      640,
    );

    // `= ANY($2)` over one array parameter, not an `IN (...)` list: one prepared
    // plan in PostgreSQL rather than a new one per distinct id count.
    expect(two.text).toBe(fifty.text);
    expect(two.values).toHaveLength(fifty.values.length);
  });

  it('is tagged, so a test double can tell it apart from a future raw query', async () => {
    const sql = eventPayloadHeadQuery(await contextFor({ orgId: IDS.orgA }), ids, 640);
    expect(sql.text).toContain(EVENT_PAYLOAD_HEAD_TAG);
  });
});

describe('readEventPayloadHeads', () => {
  it('issues no statement at all for an empty id list', async () => {
    const context = await contextFor({ orgId: IDS.orgA, projectId: IDS.projectA1 });
    const client = {
      calls: 0,
      async $queryRaw<T>(): Promise<T> {
        this.calls += 1;
        return [] as unknown as T;
      },
    };

    const heads = await readEventPayloadHeads(client, context, [], 640);

    expect(heads.size).toBe(0);
    // A `= ANY('{}')` is a round trip that can only return nothing, on the path
    // whose whole point is being cheap.
    expect(client.calls).toBe(0);
  });

  it('keys the rows by event id', async () => {
    const context = await contextFor({ orgId: IDS.orgA, projectId: IDS.projectA1 });
    const client = {
      async $queryRaw<T>(): Promise<T> {
        return [
          { id: 'evt_2', head: null, inline_bytes: null, payload_size: 9, payload_location: null },
          {
            id: 'evt_1',
            head: Buffer.from('{}'),
            inline_bytes: 2,
            payload_size: 2,
            payload_location: null,
          },
        ] as unknown as T;
      },
    };

    const heads = await readEventPayloadHeads(client, context, ['evt_1', 'evt_2', 'evt_3'], 640);

    expect([...heads.keys()].sort()).toEqual(['evt_1', 'evt_2']);
    // An id the statement did not return - another tenant's, or a deleted event -
    // is simply absent. The caller renders no preview; it does not fail.
    expect(heads.get('evt_3')).toBeUndefined();
    expect(heads.get('evt_1')?.inline_bytes).toBe(2);
  });
});
