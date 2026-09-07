import { Injectable } from '@nestjs/common';
import { Prisma, RetryPolicy } from '@prisma/client';
import {
  CROSS_TENANT_MESSAGE,
  RequestContext,
  TenantScope,
  TenantScopeFactory,
} from '../authz';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { TenantTransactionRunner } from '../organizations/tenant-transaction';
import {
  CreateRetryPolicyDto,
  ListRetryPoliciesQueryDto,
  RetryPolicyDto,
  RetryPolicyListDto,
  UpdateRetryPolicyDto,
  settingsOf,
  toRetryPolicyDto,
} from './dto';
import { MAX_RETRY_POLICIES_PER_PROJECT } from './retry-policy-limits';
import { DEFAULT_RETRY_SETTINGS, RetrySettings, assertRetrySettings } from './retry-policy-rules';

/** The columns a request body may reach, named one by one. */
type RetryPolicyColumns = Pick<
  Prisma.RetryPolicyCreateManyInput,
  | 'strategy'
  | 'maxAttempts'
  | 'initialDelayMs'
  | 'maxDelayMs'
  | 'multiplier'
  | 'jitterRatio'
  | 'maxRetryDurationMs'
>;

/**
 * Retry policies: the backoff curve the delivery workers run per endpoint.
 *
 * ## Two invariants, and why each is held where it is
 *
 * **1. Every stored policy is one the data plane can consume sanely.**
 * `retry_policies` has no CHECK constraints (a migration is requested in
 * HANDOFF.md), and the data plane clamps defensively rather than refusing, so a
 * nonsensical policy does not fail loudly downstream — it silently stops
 * behaving the way it reads. `max_delay_ms = 0` is the one with a scar: it let
 * the exponential term overflow int64 in `retry.Delay`, producing a large
 * NEGATIVE `time.Duration`, so `next_attempt_at` sat permanently in the past
 * and the 250ms poll loop hammered a dead endpoint — the exact stampede backoff
 * exists to prevent. Validation therefore happens on the MERGED settings, not
 * on the request body, because a PATCH walks a stored row into a new
 * combination one field at a time.
 *
 * **2. A project with retry policies has exactly one default.**
 * This is a property of a SET of rows, and the schema has no partial unique
 * index to enforce it (PostgreSQL cannot express "at most one row with
 * is_default = true per project" through a plain unique constraint, and
 * `CREATE UNIQUE INDEX ... WHERE is_default` is not expressible in
 * schema.prisma — see the migration request in HANDOFF.md). Two concurrent
 * "make me the default" calls each clear the old default and set a new one,
 * touching DIFFERENT rows, so under READ COMMITTED neither blocks and both
 * commit: two defaults, and nothing afterwards can say which one the data plane
 * should have used.
 *
 * Every write that touches `is_default` therefore runs inside
 * `TenantTransactionRunner` — one SERIALIZABLE transaction, retried on 40001 —
 * and there is exactly ONE code path that writes the column (`setDefault`, plus
 * `create`'s promotion). `is_default` is deliberately absent from
 * `UpdateRetryPolicyDto` for that reason: a PATCH that just sets the field is
 * precisely the shape that skips the clear.
 *
 * ## Deletion rules
 *
 * - **A policy referenced by a live endpoint cannot be deleted.**
 *   `endpoints.retry_policy_id` is an optional relation with no explicit
 *   referential action, which is `ON DELETE SET NULL`: deleting the policy would
 *   silently repoint those endpoints at the data plane's built-in
 *   `retry.DefaultPolicy()` — 8 attempts, 5s base, 24h budget — with no record
 *   that anything changed and no error anywhere. Refused with a 409 that says
 *   how many endpoints, so the caller repoints them deliberately.
 * - **Soft-deleted endpoints do not block it**, but they are unlinked
 *   explicitly and the count is recorded in the audit row. They cannot be
 *   PATCHed (`EndpointsService` refuses to modify a deleted endpoint), so
 *   counting them would make the policy permanently undeletable — and leaving
 *   the FK to null itself would be the same silent rewrite by a quieter route.
 * - **The default cannot be deleted without a successor** while other policies
 *   remain: `?replacement_id=` is required, and the promotion happens in the
 *   same transaction so no reader ever observes a project with policies and no
 *   default. Deleting the LAST policy is allowed — the project falls back to
 *   `retry.DefaultPolicy()`, which is a defined state.
 */
@Injectable()
export class RetryPoliciesService {
  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly transactions: TenantTransactionRunner,
  ) {}

  /**
   * A PAGE of policies, and whether there are more. Never a bare array: a
   * bounded read that returns one cannot tell its caller the bound was reached.
   */
  async list(
    context: RequestContext,
    query: ListRetryPoliciesQueryDto,
  ): Promise<RetryPolicyListDto> {
    const where: Prisma.RetryPolicyWhereInput =
      query.is_default === undefined ? {} : { isDefault: query.is_default };

    const page = await this.scopes.for(context).retryPolicies.findPage({
      where,
      // Newest first, like every other listing in the control plane. The
      // default is not sorted to the top: `is_default` is on every row, and a
      // page-2 caller filtering `?is_default=true` is the reliable way to ask
      // "which one is in force" without depending on an ordering.
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      data: page.rows.map(toRetryPolicyDto),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  async get(context: RequestContext, policyId: string): Promise<RetryPolicyDto> {
    return toRetryPolicyDto(await this.require(this.scopes.for(context), policyId));
  }

  /**
   * Create, and promote to default when asked — or when the project has none.
   *
   * The whole thing is one SERIALIZABLE transaction: the headroom count, the
   * "does a default already exist?" read, the clear of the old default and the
   * insert are a read-then-write over a set of rows, and two concurrent creates
   * that both promote would otherwise leave two defaults.
   *
   * The callback is replayable — reads, writes and the audit row, nothing else.
   */
  async create(context: RequestContext, dto: CreateRetryPolicyDto): Promise<RetryPolicyDto> {
    const settings = assertRetrySettings({
      ...DEFAULT_RETRY_SETTINGS,
      ...RetryPoliciesService.patch(dto),
    });

    return this.transactions.run(context, async (scope, audit) => {
      await RetryPoliciesService.requireHeadroom(scope);

      // A project with policies and no default is a state nothing downstream can
      // resolve, so the first policy is promoted whether or not it asked to be.
      const currentDefault = await scope.retryPolicies.findFirst({ where: { isDefault: true } });
      const promote = dto.is_default === true || currentDefault === null;
      if (promote && currentDefault) {
        await scope.retryPolicies.updateMany({ isDefault: true }, { isDefault: false });
      }

      const id = newId('retryPolicy');
      const now = new Date();
      const created = await scope.retryPolicies.create({
        id,
        name: dto.name,
        isDefault: promote,
        ...RetryPoliciesService.columns(settings),
        // Stated rather than defaulted, so created_at and updated_at come off
        // one clock reading.
        createdAt: now,
        updatedAt: now,
      });

      await audit.record({
        action: 'retry_policy.created',
        resourceType: 'retry_policy',
        resourceId: id,
        metadata: {
          name: dto.name,
          is_default: promote,
          replaced_default_id: promote ? (currentDefault?.id ?? null) : null,
          ...settings,
        },
      });
      return toRetryPolicyDto(created);
    });
  }

  /**
   * Patch the backoff curve. `is_default` is not reachable here — see the class
   * docblock.
   *
   * The merged settings are validated, not the body: lowering `max_delay_ms`
   * under a stored `initial_delay_ms` is one PATCH away and produces a policy
   * where every retry is clamped to the ceiling and the strategy does nothing.
   */
  async update(
    context: RequestContext,
    policyId: string,
    dto: UpdateRetryPolicyDto,
  ): Promise<RetryPolicyDto> {
    const patch = RetryPoliciesService.patch(dto);
    const renamed = dto.name !== undefined;
    if (Object.keys(patch).length === 0 && !renamed) {
      return toRetryPolicyDto(await this.require(this.scopes.for(context), policyId));
    }

    return this.transactions.run(context, async (scope, audit) => {
      const current = await this.require(scope, policyId);
      const settings = assertRetrySettings({ ...settingsOf(current), ...patch });

      const data: RetryPolicyColumns & { name?: string; updatedAt: Date } = {
        ...RetryPoliciesService.columns(settings),
        updatedAt: new Date(),
      };
      if (dto.name !== undefined) data.name = dto.name;

      const updated = await scope.retryPolicies.updateById(policyId, data);
      await audit.record({
        action: 'retry_policy.updated',
        resourceType: 'retry_policy',
        resourceId: policyId,
        metadata: {
          fields: [...Object.keys(patch), ...(renamed ? ['name'] : [])].sort(),
          ...settings,
        },
      });
      return toRetryPolicyDto(updated);
    });
  }

  /**
   * THE concurrency-sensitive route.
   *
   * Clear-then-set over a set of rows, inside one SERIALIZABLE transaction. Two
   * concurrent calls naming different policies form a read/write dependency
   * cycle that PostgreSQL's SSI detects and aborts one of; the survivor's clear
   * then sees the other's write and the project ends with exactly one default.
   * Under the READ COMMITTED default they would touch different rows, never
   * block, and both commit.
   *
   * Idempotent: re-defaulting the current default still runs the clear, which
   * is what repairs a project that somehow acquired two.
   */
  async setDefault(context: RequestContext, policyId: string): Promise<RetryPolicyDto> {
    return this.transactions.run(context, async (scope, audit) => {
      const target = await this.require(scope, policyId);
      const previous = await scope.retryPolicies.findFirst({
        where: { isDefault: true, NOT: { id: policyId } },
      });

      // Every OTHER default, not just the one that was read: the read is a
      // snapshot and the clear is the statement that has to be true.
      await scope.retryPolicies.updateMany(
        { isDefault: true, NOT: { id: policyId } },
        { isDefault: false },
      );
      const updated = target.isDefault
        ? target
        : await scope.retryPolicies.updateById(policyId, { isDefault: true, updatedAt: new Date() });

      await audit.record({
        action: 'retry_policy.default_set',
        resourceType: 'retry_policy',
        resourceId: policyId,
        metadata: { name: target.name, previous_default_id: previous?.id ?? null },
      });
      return toRetryPolicyDto(updated);
    });
  }

  /**
   * Hard delete, with two preconditions — see the class docblock for both.
   *
   * Hard rather than soft: nothing in the delivery ledger references a retry
   * policy (`deliveries` records the attempt history, not the curve that
   * produced it), so there is no historical record to preserve. Endpoints do
   * reference it, and that is the precondition.
   */
  async remove(
    context: RequestContext,
    policyId: string,
    replacementId?: string,
  ): Promise<void> {
    await this.transactions.run(context, async (scope, audit) => {
      const policy = await this.require(scope, policyId);

      const live = await scope.endpoints.count({
        retryPolicyId: policyId,
        status: { not: 'deleted' },
      });
      if (live > 0) {
        throw new AppError(
          'conflict',
          `${live} endpoint${live === 1 ? '' : 's'} in this project still use this retry ` +
            'policy. Deleting it would silently move them onto the platform default backoff ' +
            'with nothing in the record to say so. Point them at another policy first.',
          { endpoints: live },
        );
      }

      const others = await scope.retryPolicies.count({ NOT: { id: policyId } });
      let promoted: RetryPolicy | null = null;

      if (policy.isDefault && others > 0) {
        if (!replacementId) {
          throw new AppError(
            'conflict',
            'This is the project default retry policy and other policies exist. Name its ' +
              'successor with ?replacement_id= so the project is never left with policies and ' +
              'no default.',
          );
        }
        if (replacementId === policyId) {
          throw new AppError(
            'invalid_request',
            'replacement_id cannot be the policy being deleted.',
            { field: 'replacement_id' },
          );
        }
        const replacement = await this.require(scope, replacementId);
        promoted = await scope.retryPolicies.updateById(replacement.id, {
          isDefault: true,
          updatedAt: new Date(),
        });
      } else if (replacementId) {
        throw new AppError(
          'invalid_request',
          policy.isDefault
            ? 'replacement_id is not accepted when deleting the only policy in the project: ' +
              'there is nothing to promote, and the project falls back to the platform default.'
            : 'replacement_id is only accepted when deleting the project default policy; this ' +
              'policy is not the default, so nothing would be promoted.',
          { field: 'replacement_id' },
        );
      }

      // Soft-deleted endpoints are unlinked HERE rather than by the FK's
      // ON DELETE SET NULL, so the rewrite is an act with a number attached
      // instead of a side effect nobody can see afterwards.
      const unlinked = await RetryPoliciesService.unlinkDeletedEndpoints(scope, policyId);

      await scope.retryPolicies.deleteById(policyId);
      await audit.record({
        action: 'retry_policy.deleted',
        resourceType: 'retry_policy',
        resourceId: policyId,
        metadata: {
          name: policy.name,
          was_default: policy.isDefault,
          promoted_policy_id: promoted?.id ?? null,
          unlinked_deleted_endpoints: unlinked,
        },
      });
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * 404 with the layer's single message, for an absent id and for an id in
   * another tenant alike.
   *
   * `findById` + `CROSS_TENANT_MESSAGE`, never `requireById`:
   * `ScopedRepository.notFound()` says "Retry policy not found.", which is a
   * DIFFERENT string from the one every other 404 in the control plane uses, and
   * two vocabularies in one API is how a distinguishable pair eventually gets
   * created. See the note in HANDOFF.md.
   */
  private async require(scope: TenantScope, policyId: string): Promise<RetryPolicy> {
    const policy = await scope.retryPolicies.findById(policyId);
    if (!policy) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
    return policy;
  }

  /**
   * Refuse a create that would take the project past its policy ceiling.
   *
   * `limit_exceeded`, NOT `conflict`. A ceiling and a collision are different
   * things a customer needs told differently, and `conflict` already means "a
   * duplicate name", "this endpoint is deleted" and "another writer got there
   * first" — a client that must tell them apart was reduced to matching on the
   * human-readable message, which breaks the first time someone rewords a
   * sentence. The `details` are the contract; the message is for a human.
   */
  private static async requireHeadroom(scope: TenantScope): Promise<void> {
    const existing = await scope.retryPolicies.count();
    if (existing < MAX_RETRY_POLICIES_PER_PROJECT) return;
    throw new AppError(
      'limit_exceeded',
      `This project already has ${MAX_RETRY_POLICIES_PER_PROJECT} retry policies, which is ` +
        'the maximum. Delete one you no longer point endpoints at.',
      {
        limit: MAX_RETRY_POLICIES_PER_PROJECT,
        current: existing,
        resource: 'retry_policies',
      },
    );
  }

  /** Returns how many soft-deleted endpoints were unlinked. */
  private static async unlinkDeletedEndpoints(
    scope: TenantScope,
    policyId: string,
  ): Promise<number> {
    const deleted = await scope.endpoints.count({ retryPolicyId: policyId, status: 'deleted' });
    if (deleted === 0) return 0;
    return scope.endpoints.updateMany(
      { retryPolicyId: policyId, status: 'deleted' },
      { retryPolicyId: null },
    );
  }

  /**
   * The subset of the DTO that maps to settings, snake_case to camelCase.
   *
   * Explicit rather than a spread: a spread would let any future request field
   * reach the write payload, and `ScopedRepository` would only catch the ones
   * that happen to collide with a column name.
   */
  private static patch(dto: CreateRetryPolicyDto | UpdateRetryPolicyDto): Partial<RetrySettings> {
    const patch: Partial<RetrySettings> = {};
    if (dto.strategy !== undefined) patch.strategy = dto.strategy;
    if (dto.max_attempts !== undefined) patch.maxAttempts = dto.max_attempts;
    if (dto.initial_delay_ms !== undefined) patch.initialDelayMs = dto.initial_delay_ms;
    if (dto.max_delay_ms !== undefined) patch.maxDelayMs = dto.max_delay_ms;
    if (dto.multiplier !== undefined) patch.multiplier = dto.multiplier;
    if (dto.jitter_ratio !== undefined) patch.jitterRatio = dto.jitter_ratio;
    if (dto.max_retry_duration_ms !== undefined) {
      patch.maxRetryDurationMs = dto.max_retry_duration_ms;
    }
    return patch;
  }

  private static columns(settings: RetrySettings): RetryPolicyColumns {
    return {
      strategy: settings.strategy,
      maxAttempts: settings.maxAttempts,
      initialDelayMs: settings.initialDelayMs,
      maxDelayMs: settings.maxDelayMs,
      multiplier: settings.multiplier,
      jitterRatio: settings.jitterRatio,
      maxRetryDurationMs: settings.maxRetryDurationMs,
    };
  }
}
