import { CROSS_TENANT_MESSAGE, RequestContext } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { AppError, ErrorCode } from '../common/errors';
import { Harness, harnessFor } from '../endpoint-secrets/testing/harness';
import { CreateEndpointDto } from './dto';

async function expectError(
  promise: Promise<unknown>,
  code: ErrorCode,
  message?: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const error = err as AppError;
    expect(error.code).toBe(code);
    if (message !== undefined) expect(error.message).toBe(message);
    return error;
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`);
}

const BODY: CreateEndpointDto = { name: 'finance', url: 'https://finance.example.com/hook' };

async function projectScope(userId: string = IDS.ownerA): Promise<Harness> {
  return harnessFor(userId, { orgId: IDS.orgA, projectId: IDS.projectA1 });
}

describe('EndpointsService - tenant isolation', () => {
  it('answers 404, with the layer message, for an endpoint in another tenant', async () => {
    const { endpoints, context } = await projectScope();
    await expectError(
      endpoints.get(context, IDS.endpointB1),
      'not_found',
      CROSS_TENANT_MESSAGE,
    );
  });

  it('gives an absent id and a foreign id the same answer, byte for byte', async () => {
    const { endpoints, context } = await projectScope();
    const messages: string[] = [];
    for (const id of [IDS.endpointB1, 'ep_does_not_exist']) {
      const error = await expectError(endpoints.get(context, id), 'not_found');
      messages.push(error.message);
    }
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(CROSS_TENANT_MESSAGE);
  });

  it('refuses to update or delete another tenant endpoint, and leaves it untouched', async () => {
    const { endpoints, context, db } = await projectScope();
    await expectError(
      endpoints.update(context, IDS.endpointB1, { url: 'https://attacker.example/hook' }),
      'not_found',
    );
    await expectError(endpoints.remove(context, IDS.endpointB1), 'not_found');
    expect(db.rows('endpoint').get(IDS.endpointB1)).toMatchObject({
      url: 'https://b.example.com/hook',
      status: 'active',
    });
  });

  it('will not bind a new endpoint to another tenant retry policy', async () => {
    const { endpoints, context, db } = await projectScope();
    const before = db.rows('endpoint').size;

    await expectError(
      endpoints.create(context, { ...BODY, retry_policy_id: IDS.retryPolicyB1 }),
      'not_found',
      CROSS_TENANT_MESSAGE,
    );
    // Refused before the insert, not compensated afterwards.
    expect(db.rows('endpoint').size).toBe(before);
  });

  it('lists only this project endpoints', async () => {
    const { endpoints, context, db } = await projectScope();
    expect(db.all('endpoint')).toHaveLength(2);
    const listed = await endpoints.list(context, {});
    expect(listed.data.map((endpoint) => endpoint.id)).toEqual([IDS.endpointA1]);
    expect(listed).toMatchObject({ has_more: false, next_offset: null });
  });
});

describe('EndpointsService - creation', () => {
  it('creates an active endpoint with a version 1 secret, and returns the plaintext once', async () => {
    const { endpoints, context, db } = await projectScope();

    const created = await endpoints.create(context, BODY);

    expect(created).toMatchObject({
      project_id: IDS.projectA1,
      status: 'active',
      enabled: true,
      url: BODY.url,
      secret_version: 1,
      secret_pending: false,
    });
    expect(created.secret).toMatch(/^whsec_/);

    const secrets = db
      .all('endpointSecret')
      .filter((row) => row.endpointId === created.id);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({ version: 1, active: true, expiresAt: null });
    // Stored encrypted, and the envelope cannot contain the plaintext.
    expect(String(secrets[0].secretEncrypted)).not.toContain(String(created.secret));
    expect(String(secrets[0].secretEncrypted)).toMatch(/^v1\./);
  });

  /**
   * `endpoints.write` is a developer permission; `endpoint-secrets.*` is owner
   * and admin only. The endpoint still gets its secret - the invariant does not
   * bend for a role - but the plaintext is not handed to someone the matrix says
   * may not read signing secrets.
   */
  it('withholds the plaintext from a developer, without withholding the secret itself', async () => {
    const { endpoints, context, db } = await harnessFor(IDS.developerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    expect(context.has('endpoint-secrets.write')).toBe(false);

    const created = await endpoints.create(context, BODY);

    expect(created.secret).toBeNull();
    // FIX 2: the endpoint is NOT live. Going active here would sign every
    // delivery with a key the consumer was never given.
    expect(created).toMatchObject({ secret_pending: true, status: 'paused', enabled: false });
    expect(
      db.all('endpointSecret').filter((row) => row.endpointId === created.id),
    ).toHaveLength(1);
  });

  it('never leaves an endpoint active with no secret when minting fails', async () => {
    const { endpoints, secrets, context, db } = await projectScope();
    jest
      .spyOn(secrets, 'mintInitial')
      .mockRejectedValueOnce(new AppError('internal_error', 'boom'));

    await expectError(endpoints.create(context, BODY), 'internal_error');

    const rows = db.all('endpoint').filter((row) => row.projectId === IDS.projectA1);
    const stub = rows.find((row) => row.id !== IDS.endpointA1);
    expect(stub).toBeDefined();
    // Never active, and swept out of the customer's list.
    expect(stub).toMatchObject({ enabled: false, status: 'deleted' });
  });

  it('audits the creation against the resolved organization', async () => {
    const { endpoints, context, db } = await projectScope();
    const created = await endpoints.create(context, BODY);

    const actions = db.all('auditLog').map((row) => row.action);
    expect(actions).toContain('endpoint_secret.created');
    expect(actions).toContain('endpoint.created');
    expect(db.all('auditLog').find((row) => row.action === 'endpoint.created')).toMatchObject({
      organizationId: IDS.orgA,
      userId: IDS.ownerA,
      resourceType: 'endpoint',
      resourceId: created.id,
    });
  });
});

describe('EndpointsService - lifecycle', () => {
  async function withEndpoint(): Promise<{ harness: Harness; id: string; context: RequestContext }> {
    const harness = await projectScope();
    const created = await harness.endpoints.create(harness.context, BODY);
    return { harness, id: created.id, context: harness.context };
  }

  it('disables without touching the circuit breaker columns', async () => {
    const { harness, id, context } = await withEndpoint();
    harness.db.rows('endpoint').set(id, {
      ...harness.db.rows('endpoint').get(id),
      disabledReason: 'breaker: 12 consecutive failures',
      disabledAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const disabled = await harness.endpoints.disable(context, id, 'maintenance window');

    expect(disabled).toMatchObject({ enabled: false, status: 'paused' });
    // The breaker's record of WHY the platform stopped is not overwritten by a
    // human pressing pause. The human's reason goes to the audit log.
    expect(disabled.disabled_reason).toBe('breaker: 12 consecutive failures');
    expect(
      harness.db.all('auditLog').find((row) => row.action === 'endpoint.disabled'),
    ).toMatchObject({ resourceId: id });
  });

  it('enabling clears the breaker columns - that is the deliberate override', async () => {
    const { harness, id, context } = await withEndpoint();
    harness.db.rows('endpoint').set(id, {
      ...harness.db.rows('endpoint').get(id),
      disabledReason: 'breaker: open',
      disabledAt: new Date(),
    });
    await harness.endpoints.disable(context, id);

    const enabled = await harness.endpoints.enable(context, id);

    expect(enabled).toMatchObject({
      enabled: true,
      status: 'active',
      disabled_reason: null,
      disabled_at: null,
    });
  });

  it('refuses to enable an endpoint with no live signing secret', async () => {
    const { harness, id, context } = await withEndpoint();
    await harness.endpoints.disable(context, id);
    // Simulate every secret having lapsed.
    for (const row of harness.db.all('endpointSecret')) {
      if (row.endpointId === id) {
        harness.db.rows('endpointSecret').set(String(row.id), { ...row, active: false });
      }
    }

    const error = await expectError(harness.endpoints.enable(context, id), 'conflict');
    expect(error.message).toContain('no active signing secret');
    expect(harness.db.rows('endpoint').get(id)).toMatchObject({ enabled: false });
  });
});

describe('EndpointsService - soft delete', () => {
  it('marks the row deleted and keeps it, so the delivery ledger still joins', async () => {
    const { endpoints, context, db } = await projectScope();
    const created = await endpoints.create(context, BODY);
    db.insert('delivery', {
      id: 'del_history',
      eventId: IDS.eventA1,
      endpointId: created.id,
      organizationId: IDS.orgA,
      projectId: IDS.projectA1,
      status: 'succeeded',
    });

    await endpoints.remove(context, created.id);

    // The row itself survives. `deliveries.endpoint_id` is ON DELETE RESTRICT
    // precisely so that "did finance ever receive this?" stays answerable after
    // the endpoint is gone from the UI.
    expect(db.rows('endpoint').get(created.id)).toMatchObject({
      status: 'deleted',
      enabled: false,
      url: BODY.url,
    });
    expect(db.rows('delivery').get('del_history')).toBeDefined();
  });

  it('hides deleted endpoints from the list but still serves them by id', async () => {
    const { endpoints, context } = await projectScope();
    const created = await endpoints.create(context, BODY);
    await endpoints.remove(context, created.id);

    const listed = await endpoints.list(context, {});
    expect(listed.data.map((endpoint) => endpoint.id)).not.toContain(created.id);

    const withDeleted = await endpoints.list(context, { include_deleted: true });
    expect(withDeleted.data.map((endpoint) => endpoint.id)).toContain(created.id);

    // Followed from a delivery row at 2am; a 404 here would make the ledger
    // unreadable.
    expect(await endpoints.get(context, created.id)).toMatchObject({ status: 'deleted' });
  });

  it('is idempotent, and refuses to mutate a deleted endpoint', async () => {
    const { endpoints, context } = await projectScope();
    const created = await endpoints.create(context, BODY);
    await endpoints.remove(context, created.id);
    await expect(endpoints.remove(context, created.id)).resolves.toBeUndefined();

    await expectError(endpoints.update(context, created.id, { name: 'x' }), 'conflict');
    await expectError(endpoints.enable(context, created.id), 'conflict');
    await expectError(endpoints.disable(context, created.id), 'conflict');
  });
});

describe('EndpointsService - updates', () => {
  it('applies only the fields the DTO names, and records both sides of a URL change', async () => {
    const { endpoints, context, db } = await projectScope();
    const created = await endpoints.create(context, { ...BODY, timeout_ms: 5_000 });

    const updated = await endpoints.update(context, created.id, {
      url: 'https://finance.example.com/hook/v2',
      max_concurrency: 4,
    });

    expect(updated).toMatchObject({
      url: 'https://finance.example.com/hook/v2',
      max_concurrency: 4,
      timeout_ms: 5_000,
      name: BODY.name,
    });
    expect(db.all('auditLog').find((row) => row.action === 'endpoint.updated')).toMatchObject({
      metadata: expect.objectContaining({
        url_from: BODY.url,
        url_to: 'https://finance.example.com/hook/v2',
      }),
    });
  });

  /**
   * The pipe strips unknown keys before a DTO reaches the service, but types are
   * erased and this service is callable from compiled JavaScript, so the mapper
   * refuses to carry anything it was not told to carry.
   */
  it('ignores a status smuggled into the update body', async () => {
    const { endpoints, context, db } = await projectScope();
    const created = await endpoints.create(context, BODY);

    const updated = await endpoints.update(
      context,
      created.id,
      { status: 'deleted', enabled: false, projectId: IDS.projectB1 } as never,
    );

    expect(updated.status).toBe('active');
    expect(db.rows('endpoint').get(created.id)).toMatchObject({
      status: 'active',
      enabled: true,
      projectId: IDS.projectA1,
    });
  });
});
