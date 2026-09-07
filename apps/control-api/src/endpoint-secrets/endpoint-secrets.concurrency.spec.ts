import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { CreateEndpointDto } from '../endpoints/dto';
import { isEffectivelyActive } from './dto';
import { Harness, harnessFor } from './testing/harness';

const BODY: CreateEndpointDto = { name: 'finance', url: 'https://finance.example.com/hook' };

/**
 * The PROPERTY, restated where the tests can call it: an endpoint that is not
 * deleted must have at least one secret that would actually sign right now.
 *
 * Deliberately read straight off the fake's rows rather than through the
 * service. The bug being regressed was a service that believed the invariant
 * held while the table said otherwise, so a check that asks the service is a
 * check that would have passed the whole time.
 */
function liveSecretCount(harness: Harness, endpointId: string, now = new Date()): number {
  return harness.db
    .all('endpointSecret')
    .filter((row) => row.endpointId === endpointId)
    .filter((row) =>
      isEffectivelyActive(
        {
          active: Boolean(row.active),
          expiresAt: (row.expiresAt ?? null) as Date | null,
        } as never,
        now,
      ),
    ).length;
}

function endpointRow(harness: Harness, endpointId: string): Record<string, unknown> {
  return harness.db.rows('endpoint').get(endpointId) as Record<string, unknown>;
}

/**
 * Asserts the whole invariant, not one half of it. A zero-secret endpoint is
 * only harmless if it is also not live, and the reproduction was specifically
 * `live after: 0, endpoint status: active, enabled: true` - so both are read.
 */
function assertSignable(harness: Harness, endpointId: string): void {
  const endpoint = endpointRow(harness, endpointId);
  if (endpoint.status === 'deleted') return;
  const live = liveSecretCount(harness, endpointId);
  if (live > 0) return;
  throw new Error(
    `invariant violated: endpoint has ${live} live secrets but is status=${String(
      endpoint.status,
    )} enabled=${String(endpoint.enabled)}. Every delivery to it would fail closed.`,
  );
}

async function withTwoSecrets(): Promise<{
  harness: Harness;
  endpointId: string;
  versions: Record<number, string>;
}> {
  const harness = await harnessFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
  const created = await harness.endpoints.create(harness.context, BODY);
  await harness.secrets.rotate(harness.context, created.id);

  const versions: Record<number, string> = {};
  for (const secret of (await harness.secrets.list(harness.context, created.id)).data) {
    versions[secret.version] = secret.id;
  }
  expect(liveSecretCount(harness, created.id)).toBe(2);
  return { harness, endpointId: created.id, versions };
}

/**
 * FIX 1. Two concurrent revokes used to leave an ACTIVE, ENABLED endpoint with
 * ZERO live signing secrets - the exact state this service exists to prevent,
 * and one `signing.Header` fails closed on forever, silently, until a human
 * notices deliveries stopped verifying and rotates.
 *
 * The mechanism is a SERIALIZABLE transaction around snapshot -> check -> write
 * (see the class docblock). These tests assert the PROPERTY under concurrent
 * execution instead: whatever the operations were and whatever order they
 * resolved in, the endpoint is still signable. A test that asserted the
 * mechanism would keep passing if the mechanism were swapped for a broken one.
 */
describe('the zero-secret race', () => {
  it('two simultaneous revokes cannot both succeed', async () => {
    const { harness, endpointId, versions } = await withTwoSecrets();

    const outcomes = await Promise.allSettled([
      harness.secrets.revoke(harness.context, endpointId, versions[1]),
      harness.secrets.revoke(harness.context, endpointId, versions[2]),
    ]);

    // THE PROPERTY. Before the fix this read `live after: 0` with the endpoint
    // still active and enabled.
    assertSignable(harness, endpointId);
    expect(liveSecretCount(harness, endpointId)).toBeGreaterThanOrEqual(1);
    expect(endpointRow(harness, endpointId)).toMatchObject({ status: 'active', enabled: true });

    // And the loser is told why, in the terms the API already uses.
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('only secret currently signing');
  });

  /**
   * The second interleave, and it is not hypothetical: `overlap_seconds: 0` is
   * the leak-response button this service's own docs tell an operator to press.
   * A revoke landing between rotation's INSERT of v2 and its expiry of v1 saw
   * both live, took v2 as its survivor, deactivated v1 - and the rotation then
   * expired v1 on top of it.
   */
  it('a revoke racing a zero-overlap rotation cannot empty the set', async () => {
    const { harness, endpointId, versions } = await withTwoSecrets();

    await Promise.allSettled([
      harness.secrets.rotate(harness.context, endpointId, 0),
      harness.secrets.revoke(harness.context, endpointId, versions[2]),
    ]);

    assertSignable(harness, endpointId);
    // A zero-overlap rotation retires everything before it, so exactly the new
    // secret should be signing - never nothing.
    expect(liveSecretCount(harness, endpointId, new Date(Date.now() + 1_000))).toBe(1);
  });

  /**
   * The two cases above are the ones that were reproduced. This is the general
   * claim: no interleaving of the mutating operations, run against one
   * endpoint at once, gets it into the unsignable state.
   */
  it('holds across a mixed burst of concurrent mutations', async () => {
    const { harness, endpointId, versions } = await withTwoSecrets();
    const context = harness.context;

    const results = await Promise.allSettled([
      harness.secrets.rotate(context, endpointId, 0),
      harness.secrets.revoke(context, endpointId, versions[1]),
      harness.secrets.revoke(context, endpointId, versions[2]),
      harness.secrets.rotate(context, endpointId, 3_600),
      harness.endpoints.enable(context, endpointId),
    ]);

    assertSignable(harness, endpointId);
    // Not a vacuous pass: something has to have got through.
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    // And every rejection is a stated refusal, not a crash.
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(AppError);
    }
  });

  /**
   * The revoke that SHOULD succeed still does. A fix that closed the race by
   * refusing more often would pass every assertion above and break the feature.
   */
  it('still allows revoking a superseded secret while another is signing', async () => {
    const { harness, endpointId, versions } = await withTwoSecrets();

    const revoked = await harness.secrets.revoke(harness.context, endpointId, versions[1]);

    expect(revoked.active).toBe(false);
    expect(liveSecretCount(harness, endpointId)).toBe(1);
  });
});
