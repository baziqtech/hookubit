import { IDS } from '../authz/testing/fixtures';
import { FakeTenantPrisma } from '../authz/testing/tenant-prisma.fake';
import { harnessFor } from '../endpoint-secrets/testing/harness';
import { EndpointHealthService, HEALTH_WINDOW_MS } from './endpoint-health.service';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let sequence = 0;

/**
 * A real endpoint row in project A1.
 *
 * The delivery tenant predicate walks `delivery -> endpoint -> project`, so a
 * delivery pointing at an endpoint that does not exist is excluded by the CHAIN
 * rather than by the id filter. Seeding the row is what makes "never counts the
 * endpoint next door" a test of the filter instead of a test of the fixture.
 */
function seedEndpoint(db: FakeTenantPrisma, id: string): void {
  db.insert('endpoint', {
    id,
    projectId: IDS.projectA1,
    name: id,
    url: `https://${id}.example.com/hook`,
    description: null,
    status: 'active',
    enabled: true,
    disabledReason: null,
    disabledAt: null,
    timeoutMs: 30_000,
    maxConcurrency: 16,
    rateLimit: null,
    rateLimitWindowSeconds: 1,
    retryPolicyId: null,
    customHeaders: null,
    createdAt: ago(0),
    updatedAt: ago(0),
  });
}

function delivery(
  db: FakeTenantPrisma,
  endpointId: string,
  status: string,
  createdAt: Date,
): void {
  sequence += 1;
  db.insert('delivery', {
    id: `del_h_${sequence}`,
    eventId: IDS.eventA1,
    endpointId,
    subscriptionId: null,
    organizationId: IDS.orgA,
    projectId: IDS.projectA1,
    status,
    attemptCount: 1,
    maxAttempts: 8,
    nextAttemptAt: createdAt,
    lastAttemptAt: createdAt,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * The one-hour health summary behind the endpoint list's "Success (1h)".
 *
 * Every assertion here is about a distinction the column has to keep: unknown
 * versus zero, the last hour versus all time, and this endpoint versus the one
 * next to it.
 */
describe('EndpointHealthService', () => {
  const summarise = async (build: (db: FakeTenantPrisma) => void, ids: string[] = [IDS.endpointA1]) => {
    const harness = await harnessFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    build(harness.db);
    const service = new EndpointHealthService(harness.scopes);
    return (await service.summarise(harness.context, ids, NOW)).get(ids[0]);
  };

  it('reports NULL, never 0, when nothing settled in the hour', async () => {
    // 0% means every delivery we attempted failed — the loudest thing this
    // object can say. A new endpoint with no traffic must never read as one.
    const health = await summarise((db) => {
      delivery(db, IDS.endpointA1, 'queued', ago(60_000));
    });

    expect(health?.success_rate_1h).toBeNull();
    expect(health?.deliveries_1h).toBe(1);
  });

  it('is 0, not null, when everything settled and everything failed', async () => {
    const health = await summarise((db) => {
      delivery(db, IDS.endpointA1, 'exhausted', ago(60_000));
      delivery(db, IDS.endpointA1, 'failed', ago(120_000));
    });

    expect(health?.success_rate_1h).toBe(0);
  });

  it('counts successes over SETTLED deliveries, ignoring the ones still moving', async () => {
    // A delivery still retrying is not a failure yet. Counting it as one makes
    // every busy endpoint look worse than it is, at exactly the moment someone
    // is deciding whether to page.
    const health = await summarise((db) => {
      delivery(db, IDS.endpointA1, 'succeeded', ago(60_000));
      delivery(db, IDS.endpointA1, 'succeeded', ago(120_000));
      delivery(db, IDS.endpointA1, 'exhausted', ago(180_000));
      delivery(db, IDS.endpointA1, 'retrying', ago(240_000));
    });

    expect(health?.success_rate_1h).toBe(0.6667);
    expect(health?.deliveries_1h).toBe(4);
  });

  it('excludes deliveries older than the window from the rate', async () => {
    const health = await summarise((db) => {
      delivery(db, IDS.endpointA1, 'succeeded', ago(60_000));
      delivery(db, IDS.endpointA1, 'exhausted', ago(HEALTH_WINDOW_MS + 60_000));
    });

    expect(health?.deliveries_1h).toBe(1);
    expect(health?.success_rate_1h).toBe(1);
  });

  it('counts everything still waiting at ANY age, not just the last hour', async () => {
    // "What is queued behind this problem?" is not a question about the last
    // hour. An endpoint that has been stopped for a day has a day of backlog,
    // and an hour-bounded count would report almost none of it.
    //
    // On its own endpoint, because the shared fixture already has in-flight
    // deliveries against endpointA1 and this assertion is an exact count.
    const health = await summarise(
      (db) => {
        seedEndpoint(db, 'ep_h_backlog');
        delivery(db, 'ep_h_backlog', 'queued', ago(HEALTH_WINDOW_MS * 30));
        delivery(db, 'ep_h_backlog', 'retrying', ago(HEALTH_WINDOW_MS * 10));
        delivery(db, 'ep_h_backlog', 'succeeded', ago(60_000));
      },
      ['ep_h_backlog'],
    );

    expect(health?.deliveries_waiting).toBe(2);
    expect(health?.deliveries_1h).toBe(1);
  });

  it('never counts the endpoint next door', async () => {
    const health = await summarise(
      (db) => {
        seedEndpoint(db, 'ep_h_mine');
        seedEndpoint(db, 'ep_h_theirs');
        delivery(db, 'ep_h_mine', 'succeeded', ago(60_000));
        // Same project, same tenant, genuinely reachable — so exclusion here
        // is the id filter doing its job, not the ownership chain.
        delivery(db, 'ep_h_theirs', 'exhausted', ago(60_000));
      },
      ['ep_h_mine'],
    );

    expect(health?.success_rate_1h).toBe(1);
    expect(health?.deliveries_1h).toBe(1);
  });

  it('reports the newest delivery, whatever its status', async () => {
    const health = await summarise((db) => {
      delivery(db, IDS.endpointA1, 'exhausted', ago(10_000));
      delivery(db, IDS.endpointA1, 'succeeded', ago(600_000));
    });

    expect(health?.last_delivery_at).toBe(ago(10_000).toISOString());
  });

  it('answers for an endpoint with no deliveries at all, rather than omitting it', async () => {
    // A row missing from the map would render as "loading forever" in a table.
    // Unknown is a state; absent is a bug.
    const health = await summarise(() => undefined);

    expect(health).toBeDefined();
    expect(health?.success_rate_1h).toBeNull();
    expect(health?.deliveries_1h).toBe(0);
    expect(health?.last_delivery_at).toBeNull();
  });

  it('does not issue one query per endpoint', async () => {
    const harness = await harnessFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    const ids = ['ep_1', 'ep_2', 'ep_3', 'ep_4', 'ep_5'];
    for (const id of ids) {
      seedEndpoint(harness.db, id);
      delivery(harness.db, id, 'succeeded', ago(60_000));
    }

    harness.db.queries.length = 0;
    await new EndpointHealthService(harness.scopes).summarise(harness.context, ids, NOW);

    const grouped = harness.db.queries.filter((query) => query.op === 'groupBy');
    expect(grouped.length).toBeLessThan(ids.length);
  });
});
