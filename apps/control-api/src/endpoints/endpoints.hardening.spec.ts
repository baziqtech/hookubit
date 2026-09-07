import { Reflector } from '@nestjs/core';
import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { THROTTLE_KEY, ThrottleOptions } from '../common/throttle.guard';
import { EndpointSecretsController } from '../endpoint-secrets/endpoint-secrets.controller';
import { Harness, harnessFor } from '../endpoint-secrets/testing/harness';
import { CreateEndpointDto } from './dto';
import { EndpointsController } from './endpoints.controller';
import { MAX_ENDPOINTS_PER_PROJECT } from './endpoint-limits';

const BODY: CreateEndpointDto = { name: 'finance', url: 'https://finance.example.com/hook' };

async function developerScope(): Promise<Harness> {
  return harnessFor(IDS.developerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
}

/**
 * FIX 2. `endpoints.write` is a developer permission; `endpoint-secrets.*` is
 * owner and admin only. A developer therefore created an endpoint that went
 * LIVE with an HMAC key that existed only as ciphertext: every delivery was
 * signed with a key the consumer had never been given and failed verification,
 * and the fix - an owner rotating to obtain the secret - CHANGED the key again.
 * Two verification outages where the right answer is none.
 *
 * The permission split is untouched. What changed is that an endpoint whose
 * secret cannot be handed over stays in the paused state it was created in.
 */
describe('an endpoint does not go live with a secret nobody received', () => {
  it('leaves a developer created endpoint paused, and says why', async () => {
    const { endpoints, context, db } = await developerScope();
    expect(context.has('endpoints.write')).toBe(true);
    expect(context.has('endpoint-secrets.write')).toBe(false);

    const created = await endpoints.create(context, BODY);

    expect(created).toMatchObject({
      secret: null,
      secret_pending: true,
      status: 'paused',
      enabled: false,
      secret_version: 1,
    });
    // Not withheld from the DATABASE - the invariant does not bend for a role.
    expect(db.all('endpointSecret').filter((row) => row.endpointId === created.id)).toHaveLength(1);
    // And the row really is paused, not merely reported as such.
    expect(db.rows('endpoint').get(created.id)).toMatchObject({
      status: 'paused',
      enabled: false,
    });
  });

  it('goes live for an owner, who is handed the secret in the same response', async () => {
    const { endpoints, context } = await harnessFor(IDS.ownerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });

    const created = await endpoints.create(context, BODY);

    expect(created.secret).toMatch(/^whsec_/);
    expect(created).toMatchObject({ secret_pending: false, status: 'active', enabled: true });
  });

  /**
   * The intended recovery, end to end: an owner rotates - which is the moment a
   * human can be given the plaintext - and `enable`, which already refuses an
   * endpoint with no live secret, is what takes it live. One secret change, one
   * handover, no failed deliveries.
   */
  it('an owner rotating and enabling is the path to live, and it works', async () => {
    const developer = await developerScope();
    const created = await developer.endpoints.create(developer.context, BODY);

    const owner = await harnessFor(
      IDS.ownerA,
      { orgId: IDS.orgA, projectId: IDS.projectA1 },
      undefined,
      developer.db,
    );
    const rotated = await owner.secrets.rotate(owner.context, created.id, 0);
    expect(rotated.secret).toMatch(/^whsec_/);

    const live = await owner.endpoints.enable(owner.context, created.id);
    expect(live).toMatchObject({ status: 'active', enabled: true });
  });

  /** No delivery is attempted before then, because nothing is enabled. */
  it('is never enabled between creation and the handover', async () => {
    const { endpoints, context, db } = await developerScope();
    const created = await endpoints.create(context, BODY);

    const audited = db
      .all('auditLog')
      .find((row) => row.action === 'endpoint.created' && row.resourceId === created.id);
    expect(audited?.metadata).toMatchObject({
      status: 'paused',
      awaiting_key_handover: true,
    });
  });
});

/**
 * FIX 7, the half a rate limit cannot cover: a limit bounds how FAST a project
 * can be filled with endpoints, not how many end up in it. Every endpoint is a
 * destination the data plane keeps per-endpoint concurrency and rate-limit
 * state for, so the total is the number that matters.
 */
describe('the per-project endpoint ceiling', () => {
  it('refuses a create that would pass the ceiling, and says what to do', async () => {
    const harness = await harnessFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    // Seed straight into the table: creating 500 endpoints for real would mint
    // 500 secrets and this asserts the count, not the create path.
    for (let i = 0; i < MAX_ENDPOINTS_PER_PROJECT; i += 1) {
      harness.db.insert('endpoint', {
        id: `ep_bulk_${String(i).padStart(4, '0')}`,
        projectId: IDS.projectA1,
        name: `bulk ${i}`,
        url: 'https://bulk.example.com/hook',
        status: 'active',
        enabled: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    }

    // `limit_exceeded`, not `conflict`: this module's `conflict` already means
    // "the endpoint is deleted", and the details are the machine-readable half.
    await expect(harness.endpoints.create(harness.context, BODY)).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: {
        limit: MAX_ENDPOINTS_PER_PROJECT,
        // The fixture's own `ep_a1` lives in this project too, so the live count
        // is one past the ceiling. `current` is the real count, not the ceiling
        // restated - a client showing "500 of 500" when the answer is 501 is
        // exactly the kind of derived number this field exists to replace.
        current: MAX_ENDPOINTS_PER_PROJECT + 1,
        resource: 'endpoints',
      },
    });
    const error = await harness.endpoints
      .create(harness.context, BODY)
      .catch((err: AppError) => err);
    expect((error as AppError).message).toContain(String(MAX_ENDPOINTS_PER_PROJECT));
  });

  it('does not count soft-deleted endpoints, which are kept forever', async () => {
    const harness = await harnessFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
    for (let i = 0; i < MAX_ENDPOINTS_PER_PROJECT; i += 1) {
      harness.db.insert('endpoint', {
        id: `ep_gone_${String(i).padStart(4, '0')}`,
        projectId: IDS.projectA1,
        name: `gone ${i}`,
        url: 'https://gone.example.com/hook',
        status: 'deleted',
        enabled: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    }

    // The delivery ledger keeps those rows referenced forever; counting them
    // would make a long-lived project permanently uncreatable.
    await expect(harness.endpoints.create(harness.context, BODY)).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('is scoped to the project, not the organization', async () => {
    const harness = await harnessFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA2 });
    for (let i = 0; i < MAX_ENDPOINTS_PER_PROJECT; i += 1) {
      harness.db.insert('endpoint', {
        id: `ep_other_${String(i).padStart(4, '0')}`,
        projectId: IDS.projectA1,
        name: `other ${i}`,
        url: 'https://other.example.com/hook',
        status: 'active',
        enabled: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    }

    await expect(harness.endpoints.create(harness.context, BODY)).resolves.toMatchObject({
      project_id: IDS.projectA2,
    });
  });
});

/**
 * FIX 7. Every AuthModule route carries a `@Throttle`; no route in these two
 * modules did. Both of the writes here mint or re-time credentials and do
 * AES-GCM work per call, and rotation additionally re-times every live secret
 * on the endpoint - so both are charged.
 *
 * Read off the metadata rather than by driving a 429: this asserts the
 * decorator is ON THE HANDLER, which is the thing that was missing. The guard's
 * own counting behaviour has its own suite.
 */
describe('the write routes are throttled', () => {
  const reflector = new Reflector();

  it.each([
    ['POST /v1/projects/:projectId/endpoints', EndpointsController.prototype.create],
    [
      'POST /v1/endpoints/:endpointId/secrets/rotate',
      EndpointSecretsController.prototype.rotate,
    ],
  ])('%s carries a bounded @Throttle', (_route, handler) => {
    const options = reflector.get<ThrottleOptions | undefined>(THROTTLE_KEY, handler);

    expect(options).toBeDefined();
    expect(options?.name).toBeTruthy();
    expect(options?.limit).toBeGreaterThan(0);
    expect(options?.windowMs).toBeGreaterThan(0);
    // Enforced per address: neither route takes a body field to bucket on, and
    // both are authenticated, so the IP bucket is the one that must bite.
    expect(options?.enforcePerIp).not.toBe(false);
  });

  it('leaves the read routes unthrottled', () => {
    for (const handler of [
      EndpointsController.prototype.list,
      EndpointsController.prototype.get,
      EndpointSecretsController.prototype.list,
    ]) {
      expect(reflector.get(THROTTLE_KEY, handler)).toBeUndefined();
    }
  });
});
