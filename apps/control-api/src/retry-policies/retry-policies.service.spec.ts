import { CROSS_TENANT_MESSAGE } from '../authz';
import { IDS } from '../authz/testing/fixtures';
import { AppError } from '../common/errors';
import { CreateRetryPolicyDto } from './dto';
import { MAX_RETRY_POLICIES_PER_PROJECT } from './retry-policy-limits';
import {
  RetryPolicyHarness,
  assertExactlyOneDefault,
  defaultIdsIn,
  retryHarness,
} from './testing/harness';

const BODY: CreateRetryPolicyDto = { name: 'patient partners' };

async function refusal(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

function auditActions(harness: RetryPolicyHarness): string[] {
  return harness.db.all('auditLog').map((row) => String(row.action));
}

describe('tenant isolation', () => {
  /**
   * The fixture seeds `rp_b1` in org B's project. Every assertion below is only
   * meaningful because that row is sitting in the same table and does not come
   * back.
   */
  it.each([
    ['get', (h: RetryPolicyHarness) => h.policies.get(h.context, IDS.retryPolicyB1)],
    [
      'update',
      (h: RetryPolicyHarness) =>
        h.policies.update(h.context, IDS.retryPolicyB1, { max_attempts: 3 }),
    ],
    ['setDefault', (h: RetryPolicyHarness) => h.policies.setDefault(h.context, IDS.retryPolicyB1)],
    ['remove', (h: RetryPolicyHarness) => h.policies.remove(h.context, IDS.retryPolicyB1)],
  ])('%s on another tenant policy is a 404 with the one message', async (_name, call) => {
    const harness = await retryHarness();
    const error = await refusal(call(harness));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('not_found');
    expect(error.message).toBe(CROSS_TENANT_MESSAGE);
  });

  it('gives an absent id the identical answer, so the pair is not an oracle', async () => {
    const harness = await retryHarness();
    const foreign = await refusal(harness.policies.get(harness.context, IDS.retryPolicyB1));
    const absent = await refusal(harness.policies.get(harness.context, 'rp_nope'));
    expect(foreign.message).toBe(absent.message);
    expect(foreign.code).toBe(absent.code);
  });

  it('leaves the other tenant policy untouched after a refused write', async () => {
    const harness = await retryHarness();
    await refusal(harness.policies.update(harness.context, IDS.retryPolicyB1, { max_attempts: 3 }));
    expect(harness.db.rows('retryPolicy').get(IDS.retryPolicyB1)).toMatchObject({ maxAttempts: 8 });
  });

  /**
   * The caller-supplied foreign key on this module's only route that takes one.
   * `replacement_id` is resolved through the SAME scoped repository as the
   * policy being deleted, so another tenant's policy is a 404 and is neither
   * promoted nor even revealed to exist.
   */
  it('a replacement_id in another tenant is refused, and nothing is written', async () => {
    const harness = await retryHarness();
    await harness.policies.create(harness.context, { ...BODY, name: 'second' });
    const error = await refusal(
      harness.policies.remove(harness.context, IDS.retryPolicyA1, IDS.retryPolicyB1),
    );
    expect(error.code).toBe('not_found');
    expect(error.message).toBe(CROSS_TENANT_MESSAGE);
    expect(harness.db.rows('retryPolicy').get(IDS.retryPolicyA1)).toBeDefined();
    expect(harness.db.rows('retryPolicy').get(IDS.retryPolicyB1)).toMatchObject({
      isDefault: true,
      projectId: IDS.projectB1,
    });
  });
});

describe('validation is refused at the service, not only at the DTO', () => {
  it.each([
    ['max_delay_ms', { max_delay_ms: 0 }],
    ['multiplier', { multiplier: 1 }],
    ['jitter_ratio', { jitter_ratio: 4 }],
    ['max_attempts', { max_attempts: 0 }],
    ['initial_delay_ms', { initial_delay_ms: 0 }],
  ])('refuses a create with a nonsensical %s', async (field, patch) => {
    const harness = await retryHarness();
    const before = harness.db.all('retryPolicy').length;
    const error = await refusal(harness.policies.create(harness.context, { ...BODY, ...patch }));
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field });
    expect(harness.db.all('retryPolicy')).toHaveLength(before);
  });

  /**
   * The reason validation runs on the MERGED settings: each field is
   * individually legal, and the combination is not. A per-field DTO check
   * cannot see this at all.
   */
  it('refuses a patch that lowers max_delay_ms under the stored initial_delay_ms', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, {
      ...BODY,
      initial_delay_ms: 60_000,
      max_delay_ms: 600_000,
    });
    const error = await refusal(
      harness.policies.update(harness.context, created.id, { max_delay_ms: 30_000 }),
    );
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field: 'initial_delay_ms' });
    expect(harness.db.rows('retryPolicy').get(created.id)).toMatchObject({ maxDelayMs: 600_000 });
  });

  it('refuses a patch that switches to exponential while multiplier is 1', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, {
      ...BODY,
      strategy: 'constant',
      multiplier: 1,
    });
    const error = await refusal(
      harness.policies.update(harness.context, created.id, { strategy: 'exponential' }),
    );
    expect(error.details).toMatchObject({ field: 'multiplier' });
  });

  it('stores exactly what was asked for when it is coherent', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, {
      name: 'aggressive',
      strategy: 'linear',
      max_attempts: 3,
      initial_delay_ms: 250,
      max_delay_ms: 10_000,
      multiplier: 1,
      jitter_ratio: 0,
      max_retry_duration_ms: 60_000,
    });
    expect(created).toMatchObject({
      name: 'aggressive',
      strategy: 'linear',
      max_attempts: 3,
      initial_delay_ms: 250,
      max_delay_ms: 10_000,
      multiplier: 1,
      jitter_ratio: 0,
      max_retry_duration_ms: 60_000,
      project_id: IDS.projectA1,
    });
  });
});

describe('the default policy', () => {
  it('promotes the first policy in a project even when it did not ask', async () => {
    const harness = await retryHarness();
    harness.db.rows('retryPolicy').delete(IDS.retryPolicyA1);
    const created = await harness.policies.create(harness.context, BODY);
    expect(created.is_default).toBe(true);
    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });

  it('does not promote a later policy unless asked', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, BODY);
    expect(created.is_default).toBe(false);
    expect(defaultIdsIn(harness.db, IDS.projectA1)).toEqual([IDS.retryPolicyA1]);
  });

  it('clears the previous default when a create asks to be it', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, { ...BODY, is_default: true });
    expect(created.is_default).toBe(true);
    expect(defaultIdsIn(harness.db, IDS.projectA1)).toEqual([created.id]);
    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });

  it('setDefault moves it and leaves exactly one', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, BODY);
    const promoted = await harness.policies.setDefault(harness.context, created.id);
    expect(promoted.is_default).toBe(true);
    expect(defaultIdsIn(harness.db, IDS.projectA1)).toEqual([created.id]);
  });

  it('setDefault on the current default is idempotent', async () => {
    const harness = await retryHarness();
    await harness.policies.setDefault(harness.context, IDS.retryPolicyA1);
    await harness.policies.setDefault(harness.context, IDS.retryPolicyA1);
    expect(defaultIdsIn(harness.db, IDS.projectA1)).toEqual([IDS.retryPolicyA1]);
  });

  /**
   * `is_default` has one writer. A PATCH that just sets the field is precisely
   * the shape that skips the clear, so the field is not on the update DTO at
   * all — and the repository refuses it even if a JavaScript caller invents it,
   * because `is_default` is not a field `UpdateRetryPolicyDto` carries.
   */
  it('is not reachable through update', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, BODY);
    await harness.policies.update(
      harness.context,
      created.id,
      // A JS caller that did not read the type.
      { is_default: true, name: 'renamed' } as never,
    );
    expect(harness.db.rows('retryPolicy').get(created.id)).toMatchObject({
      isDefault: false,
      name: 'renamed',
    });
    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });

  it('repairs a project that somehow acquired two defaults', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, BODY);
    // A row written outside the service - a migration, the CLI, an old bug.
    harness.db.rows('retryPolicy').set(created.id, {
      ...(harness.db.rows('retryPolicy').get(created.id) as Record<string, unknown>),
      isDefault: true,
    });
    expect(defaultIdsIn(harness.db, IDS.projectA1)).toHaveLength(2);

    await harness.policies.setDefault(harness.context, created.id);
    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });
});

describe('deletion', () => {
  it('refuses to orphan a live endpoint reference', async () => {
    const harness = await retryHarness();
    const second = await harness.policies.create(harness.context, BODY);
    harness.db.rows('endpoint').set(IDS.endpointA1, {
      ...(harness.db.rows('endpoint').get(IDS.endpointA1) as Record<string, unknown>),
      retryPolicyId: second.id,
    });

    const error = await refusal(harness.policies.remove(harness.context, second.id));
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('1 endpoint');
    expect(error.details).toMatchObject({ endpoints: 1 });
    expect(harness.db.rows('retryPolicy').get(second.id)).toBeDefined();
  });

  /**
   * `endpoints.retry_policy_id` is ON DELETE SET NULL. A soft-deleted endpoint
   * cannot be PATCHed, so counting it would make the policy permanently
   * undeletable; letting the FK null it silently would rewrite a stored
   * configuration with nothing in the record. It is unlinked explicitly and
   * counted in the audit row instead.
   */
  it('unlinks soft-deleted endpoints explicitly and records how many', async () => {
    const harness = await retryHarness();
    const second = await harness.policies.create(harness.context, BODY);
    harness.db.rows('endpoint').set(IDS.endpointA1, {
      ...(harness.db.rows('endpoint').get(IDS.endpointA1) as Record<string, unknown>),
      retryPolicyId: second.id,
      status: 'deleted',
    });

    await harness.policies.remove(harness.context, second.id);
    expect(harness.db.rows('retryPolicy').get(second.id)).toBeUndefined();
    expect(harness.db.rows('endpoint').get(IDS.endpointA1)).toMatchObject({ retryPolicyId: null });

    const entry = harness.db.all('auditLog').find((row) => row.action === 'retry_policy.deleted');
    expect(entry?.metadata).toMatchObject({ unlinked_deleted_endpoints: 1, was_default: false });
  });

  it('refuses to delete the default while other policies remain', async () => {
    const harness = await retryHarness();
    await harness.policies.create(harness.context, BODY);
    const error = await refusal(harness.policies.remove(harness.context, IDS.retryPolicyA1));
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('replacement_id');
    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });

  it('deletes the default when a successor is named, promoting it in the same call', async () => {
    const harness = await retryHarness();
    const second = await harness.policies.create(harness.context, BODY);
    await harness.policies.remove(harness.context, IDS.retryPolicyA1, second.id);

    expect(harness.db.rows('retryPolicy').get(IDS.retryPolicyA1)).toBeUndefined();
    expect(defaultIdsIn(harness.db, IDS.projectA1)).toEqual([second.id]);
    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });

  it('refuses a replacement that is the policy being deleted', async () => {
    const harness = await retryHarness();
    await harness.policies.create(harness.context, BODY);
    const error = await refusal(
      harness.policies.remove(harness.context, IDS.retryPolicyA1, IDS.retryPolicyA1),
    );
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field: 'replacement_id' });
  });

  it('refuses a replacement when the policy being deleted is not the default', async () => {
    const harness = await retryHarness();
    const second = await harness.policies.create(harness.context, BODY);
    const third = await harness.policies.create(harness.context, { ...BODY, name: 'third' });
    const error = await refusal(harness.policies.remove(harness.context, second.id, third.id));
    expect(error.code).toBe('invalid_request');
    expect(error.details).toMatchObject({ field: 'replacement_id' });
  });

  it('allows deleting the last policy - the project falls back to the platform default', async () => {
    const harness = await retryHarness();
    await harness.policies.remove(harness.context, IDS.retryPolicyA1);
    expect(harness.db.all('retryPolicy').filter((row) => row.projectId === IDS.projectA1)).toEqual(
      [],
    );
    assertExactlyOneDefault(harness.db, IDS.projectA1);
  });
});

describe('ceilings and listing', () => {
  it('refuses a create past the per-project ceiling', async () => {
    const harness = await retryHarness();
    const now = new Date();
    for (let i = harness.db.all('retryPolicy').length; i < MAX_RETRY_POLICIES_PER_PROJECT + 1; i += 1) {
      harness.db.insert('retryPolicy', {
        id: `rp_filler_${i}`,
        projectId: IDS.projectA1,
        name: `filler ${i}`,
        isDefault: false,
        strategy: 'exponential',
        maxAttempts: 8,
        initialDelayMs: 5_000,
        maxDelayMs: 3_600_000,
        multiplier: 2,
        jitterRatio: 0.2,
        maxRetryDurationMs: 86_400_000,
        createdAt: now,
        updatedAt: now,
      });
    }
    const error = await refusal(harness.policies.create(harness.context, BODY));
    // A ceiling, not a collision: the dashboard must be able to tell them apart
    // without matching on the message.
    expect(error.code).toBe('limit_exceeded');
    expect(error.details).toMatchObject({
      limit: MAX_RETRY_POLICIES_PER_PROJECT,
      resource: 'retry_policies',
    });
    expect(error.details?.current).toBeGreaterThanOrEqual(MAX_RETRY_POLICIES_PER_PROJECT);
  });

  it('never returns a bare array, and pages correctly at the boundary', async () => {
    const harness = await retryHarness();
    for (let i = 0; i < 4; i += 1) {
      await harness.policies.create(harness.context, { ...BODY, name: `p${i}` });
    }
    // 5 policies in project A: the fixture default plus four.
    const first = await harness.policies.list(harness.context, { limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(2);

    const last = await harness.policies.list(harness.context, { limit: 2, offset: 4 });
    expect(last.data).toHaveLength(1);
    expect(last.has_more).toBe(false);
    expect(last.next_offset).toBeNull();

    // Exactly at the boundary: a full page with nothing after it.
    const exact = await harness.policies.list(harness.context, { limit: 5 });
    expect(exact.data).toHaveLength(5);
    expect(exact.has_more).toBe(false);
    expect(exact.next_offset).toBeNull();

    // The envelope is exactly three keys - no `count`, no `total`. A client
    // branches on `has_more` and follows `next_offset`, which is null rather
    // than absent or 0 on the last page.
    expect(Object.keys(exact).sort()).toEqual(['data', 'has_more', 'next_offset']);
  });

  it('lists only this tenant, and filters on is_default', async () => {
    const harness = await retryHarness();
    await harness.policies.create(harness.context, BODY);
    const all = await harness.policies.list(harness.context, {});
    expect(all.data.map((row) => row.project_id)).toEqual([IDS.projectA1, IDS.projectA1]);

    const defaults = await harness.policies.list(harness.context, { is_default: true });
    expect(defaults.data.map((row) => row.id)).toEqual([IDS.retryPolicyA1]);

    const rest = await harness.policies.list(harness.context, { is_default: false });
    expect(rest.data.map((row) => row.id)).not.toContain(IDS.retryPolicyA1);
  });
});

describe('audit', () => {
  it('records every write against the resolved tenant', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, BODY);
    await harness.policies.update(harness.context, created.id, { max_attempts: 4 });
    await harness.policies.setDefault(harness.context, created.id);

    expect(auditActions(harness)).toEqual([
      'retry_policy.created',
      'retry_policy.updated',
      'retry_policy.default_set',
    ]);
    for (const row of harness.db.all('auditLog')) {
      expect(row).toMatchObject({
        organizationId: IDS.orgA,
        userId: IDS.ownerA,
        resourceType: 'retry_policy',
      });
      expect((row.metadata as Record<string, unknown>).project_id).toBe(IDS.projectA1);
    }
  });

  it('records which default was replaced', async () => {
    const harness = await retryHarness();
    const created = await harness.policies.create(harness.context, { ...BODY, is_default: true });
    const entry = harness.db.all('auditLog').find((row) => row.action === 'retry_policy.created');
    expect(entry?.metadata).toMatchObject({
      is_default: true,
      replaced_default_id: IDS.retryPolicyA1,
    });
    expect(created.is_default).toBe(true);
  });
});
