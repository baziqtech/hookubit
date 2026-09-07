import { Injectable } from '@nestjs/common';
import { Prisma, RateLimitPolicy, RateLimitScope } from '@prisma/client';
import {
  CROSS_TENANT_MESSAGE,
  RequestContext,
  TenantScope,
  TenantScopeFactory,
} from '../authz';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { TenantTransactionRunner } from '../organizations/tenant-transaction';
import { uniqueViolationTarget } from '../projects';
import {
  CreateRateLimitDto,
  ListRateLimitsQueryDto,
  RateLimitDto,
  RateLimitListDto,
  UpdateRateLimitDto,
  settingsOf,
  toRateLimitDto,
} from './dto';
import { MAX_RATE_LIMIT_POLICIES_PER_PROJECT } from './rate-limit-limits';
import { resolveRateLimitResource, resourceKindFor } from './rate-limit-resource';
import { RateLimitSettings, assertRateLimitSettings } from './rate-limit-rules';

/** The identity half of a policy: what the unique index is on. */
interface RateLimitIdentity {
  scope: RateLimitScope;
  resourceId: string | null;
}

/**
 * Rate-limit policies: the ceilings the data plane applies to delivery and to
 * ingestion.
 *
 * ## NOTHING READS THESE YET
 *
 * `internal/ingest/handler.go` wires `ingest.AllowAll{}` and the delivery
 * workers have no policy lookup at all, so every row written here is currently
 * inert. That is stated in HANDOFF.md along with the resolution order the data
 * plane must implement, because a table of ceilings that nothing enforces is
 * worse than no table: an operator reads the list, believes a limit is in
 * force, and stops looking for the reason a partner is being flooded.
 *
 * ## `resource_id` is a polymorphic foreign key
 *
 * Its target table depends on `scope`, so it cannot live in the repository's
 * `foreignKeys` map (column -> one repository). It is resolved explicitly in
 * `rate-limit-resource.ts`, through the scoped repository for whatever the
 * scope names, on every create and on every update that touches either field.
 * A rate limit pointing at another tenant's endpoint is a cross-tenant write.
 *
 * ## Uniqueness is NULL-sensitive, and that is the point
 *
 * The index is `(project_id, scope, resource_id)` with **NULLS NOT DISTINCT**
 * (migration `20260906010000_review_fixes`). PostgreSQL indexes are NULLS
 * DISTINCT by default, so the generated constraint enforced nothing on exactly
 * the rows that mattered — the `resource_id IS NULL` row, the one that means
 * "every resource in this scope" and must be singular. Duplicates of it are not
 * a cosmetic problem: two "every endpoint in this project" policies with
 * different limits give the data plane two answers to one question and no rule
 * for choosing.
 *
 * Both halves are held here: a check inside the transaction (which is what
 * produces a readable 409 in the normal case) and P2002 handling by INDEX
 * (which is what holds under a genuine race). The P2002 path reads
 * `err.meta.target` and RETHROWS anything it does not recognise — a unique index
 * nobody modelled must surface as a 500 with a stack trace, not as a friendly
 * 409 that sends the caller looking in the wrong place.
 */
@Injectable()
export class RateLimitsService {
  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly transactions: TenantTransactionRunner,
  ) {}

  async list(context: RequestContext, query: ListRateLimitsQueryDto): Promise<RateLimitListDto> {
    const where: Prisma.RateLimitPolicyWhereInput = {};
    if (query.scope !== undefined) where.scope = query.scope;
    if (query.resource_id !== undefined) where.resourceId = query.resource_id;

    const page = await this.scopes.for(context).rateLimitPolicies.findPage({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      data: page.rows.map(toRateLimitDto),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  async get(context: RequestContext, policyId: string): Promise<RateLimitDto> {
    return toRateLimitDto(await this.require(this.scopes.for(context), policyId));
  }

  /**
   * One SERIALIZABLE transaction: headroom count, resource resolution,
   * uniqueness check and insert. The check and the insert have to be atomic or
   * two concurrent creates of the same `(scope, resource_id)` both pass the
   * check — which is what the index is the backstop for.
   */
  async create(context: RequestContext, dto: CreateRateLimitDto): Promise<RateLimitDto> {
    const settings = assertRateLimitSettings({
      limit: dto.limit,
      windowSeconds: dto.window_seconds ?? 1,
      burst: dto.burst ?? null,
    });

    return this.transactions.run(context, async (scope, audit) => {
      await RateLimitsService.requireHeadroom(scope);

      const identity: RateLimitIdentity = {
        scope: dto.scope,
        resourceId: await resolveRateLimitResource(
          scope,
          context,
          dto.scope,
          dto.resource_id ?? null,
        ),
      };
      await RateLimitsService.requireUnique(scope, identity, null);

      const id = newId('rateLimitPolicy');
      const now = new Date();
      const created = await RateLimitsService.mapConflict(identity, () =>
        scope.rateLimitPolicies.create({
          id,
          scope: identity.scope,
          resourceId: identity.resourceId,
          limit: settings.limit,
          windowSeconds: settings.windowSeconds,
          burst: settings.burst,
          createdAt: now,
          updatedAt: now,
        }),
      );

      await audit.record({
        action: 'rate_limit_policy.created',
        resourceType: 'rate_limit_policy',
        resourceId: id,
        metadata: {
          scope: identity.scope,
          target_resource_id: identity.resourceId,
          ...settings,
        },
      });
      return toRateLimitDto(created);
    });
  }

  /**
   * Patch. `scope` and `resource_id` are the row's identity, so changing either
   * re-runs the whole create path: re-resolve the resource through the scoped
   * repository for the NEW scope, re-check uniqueness, and let the index have
   * the last word.
   */
  async update(
    context: RequestContext,
    policyId: string,
    dto: UpdateRateLimitDto,
  ): Promise<RateLimitDto> {
    return this.transactions.run(context, async (scope, audit) => {
      const current = await this.require(scope, policyId);
      const settings = assertRateLimitSettings({
        ...settingsOf(current),
        ...RateLimitsService.settingsPatch(dto),
      });
      const identity = await this.identityFor(scope, context, current, dto);

      const identityChanged =
        identity.scope !== current.scope || identity.resourceId !== (current.resourceId ?? null);
      if (identityChanged) {
        await RateLimitsService.requireUnique(scope, identity, policyId);
      }

      const updated = await RateLimitsService.mapConflict(identity, () =>
        scope.rateLimitPolicies.updateById(policyId, {
          scope: identity.scope,
          resourceId: identity.resourceId,
          limit: settings.limit,
          windowSeconds: settings.windowSeconds,
          burst: settings.burst,
          updatedAt: new Date(),
        }),
      );

      await audit.record({
        action: 'rate_limit_policy.updated',
        resourceType: 'rate_limit_policy',
        resourceId: policyId,
        metadata: {
          scope: identity.scope,
          target_resource_id: identity.resourceId,
          identity_changed: identityChanged,
          ...settings,
        },
      });
      return toRateLimitDto(updated);
    });
  }

  /**
   * Hard delete. Nothing references a rate-limit policy — it is configuration
   * the data plane reads, not a row anything in the ledger points at — so there
   * is no history to preserve and no dangling reference to create.
   */
  async remove(context: RequestContext, policyId: string): Promise<void> {
    await this.transactions.run(context, async (scope, audit) => {
      const policy = await this.require(scope, policyId);
      await scope.rateLimitPolicies.deleteById(policyId);
      await audit.record({
        action: 'rate_limit_policy.deleted',
        resourceType: 'rate_limit_policy',
        resourceId: policyId,
        metadata: {
          scope: policy.scope,
          target_resource_id: policy.resourceId ?? null,
          limit: policy.limit,
          window_seconds: policy.windowSeconds,
        },
      });
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * The new identity of a row under a patch.
   *
   * A scope change that leaves a stale non-null `resource_id` unstated is
   * refused rather than carried over: an endpoint id under
   * `scope: "organization"` would be resolved against the organizations table,
   * 404, and the caller would be told their own endpoint does not exist. Making
   * them re-state it turns a confusing 404 into a 400 that says what to do.
   */
  private async identityFor(
    scope: TenantScope,
    context: RequestContext,
    current: RateLimitPolicy,
    dto: UpdateRateLimitDto,
  ): Promise<RateLimitIdentity> {
    const nextScope = dto.scope ?? current.scope;
    const scopeChanged = dto.scope !== undefined && dto.scope !== current.scope;

    if (scopeChanged && dto.resource_id === undefined && current.resourceId !== null) {
      throw new AppError(
        'invalid_request',
        'Changing `scope` while this policy has a `resource_id` requires stating the new ' +
          'resource_id too (or null): the existing one names a ' +
          `${resourceKindFor(current.scope)}, which is not what ${nextScope} scope refers to.`,
        { field: 'resource_id' },
      );
    }

    const requested =
      dto.resource_id !== undefined ? (dto.resource_id ?? null) : (current.resourceId ?? null);
    return {
      scope: nextScope,
      resourceId: await resolveRateLimitResource(scope, context, nextScope, requested),
    };
  }

  /**
   * 404 with the layer's single message, for an absent id and for an id in
   * another tenant alike. `findById` + `CROSS_TENANT_MESSAGE`, never
   * `requireById` — see the same note on `RetryPoliciesService.require`.
   */
  private async require(scope: TenantScope, policyId: string): Promise<RateLimitPolicy> {
    const policy = await scope.rateLimitPolicies.findById(policyId);
    if (!policy) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
    return policy;
  }

  /**
   * `limit_exceeded`, not `conflict` — and the distinction matters more here
   * than anywhere else in this module: a duplicate on the NULLS NOT DISTINCT
   * unique index IS a genuine `conflict` (another row already covers this
   * scope and resource), while running out of policy slots is a ceiling. They
   * are two different things a customer must be told differently, and until
   * `limit_exceeded` existed they were the same 409.
   */
  private static async requireHeadroom(scope: TenantScope): Promise<void> {
    const existing = await scope.rateLimitPolicies.count();
    if (existing < MAX_RATE_LIMIT_POLICIES_PER_PROJECT) return;
    throw new AppError(
      'limit_exceeded',
      `This project already has ${MAX_RATE_LIMIT_POLICIES_PER_PROJECT} rate-limit policies, ` +
        'which is the maximum. Delete one you no longer enforce.',
      {
        limit: MAX_RATE_LIMIT_POLICIES_PER_PROJECT,
        current: existing,
        resource: 'rate_limit_policies',
      },
    );
  }

  /**
   * The readable half of uniqueness: a check inside the transaction, so the
   * normal case produces a 409 that says which row is in the way rather than a
   * driver error mapped after the fact.
   *
   * `{ resourceId: null }` really is `IS NULL` in Prisma, which is what makes
   * this match the NULLS NOT DISTINCT index rather than the default behaviour
   * the migration replaced.
   */
  private static async requireUnique(
    scope: TenantScope,
    identity: RateLimitIdentity,
    excludeId: string | null,
  ): Promise<void> {
    const where: Prisma.RateLimitPolicyWhereInput = {
      scope: identity.scope,
      resourceId: identity.resourceId,
    };
    if (excludeId) where.NOT = { id: excludeId };

    const existing = await scope.rateLimitPolicies.findFirst({ where });
    if (!existing) return;
    throw RateLimitsService.conflictFor(identity, existing.id);
  }

  /**
   * The half that holds under a race: PostgreSQL's own answer, mapped by INDEX.
   *
   * Deliberately NOT `catch (P2002) -> 409`. The auth module shipped exactly
   * that bug: duck-typing on the code alone meant a collision on a DIFFERENT
   * unique index in the same statement was reported to the caller as a
   * duplicate of something else entirely, and they went looking in the wrong
   * place for a failure that was fixable. So `meta.target` is read, matched
   * against the index this module actually owns, and everything else — including
   * a P2002 whose target the driver did not report — is rethrown unchanged.
   */
  private static async mapConflict<T>(
    identity: RateLimitIdentity,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (err) {
      const target = uniqueViolationTarget(err);
      // Prisma reports the column list on some connector/version combinations
      // and the constraint name on others, so both spellings of the column are
      // matched. An empty string means "P2002, but we were told nothing about
      // which index" and must NOT be treated as a match for this one.
      const ours =
        target !== null &&
        (target.includes('resource_id') || target.includes('resourceid')) &&
        target.includes('scope');
      if (!ours) throw err;
      throw RateLimitsService.conflictFor(identity, null);
    }
  }

  private static conflictFor(identity: RateLimitIdentity, existingId: string | null): AppError {
    const covers =
      identity.resourceId === null
        ? `every ${resourceKindFor(identity.scope)} in this project`
        : `${resourceKindFor(identity.scope)} ${identity.resourceId}`;
    return new AppError(
      'conflict',
      `A ${identity.scope}-scoped rate limit covering ${covers} already exists in this ` +
        'project. One ceiling per resource: update the existing policy instead of adding a ' +
        'second one, or the data plane would have two answers to one question.',
      {
        scope: identity.scope,
        resource_id: identity.resourceId,
        ...(existingId ? { existing_policy_id: existingId } : {}),
      },
    );
  }

  private static settingsPatch(dto: UpdateRateLimitDto): Partial<RateLimitSettings> {
    const patch: Partial<RateLimitSettings> = {};
    if (dto.limit !== undefined) patch.limit = dto.limit;
    if (dto.window_seconds !== undefined) patch.windowSeconds = dto.window_seconds;
    if (dto.burst !== undefined) patch.burst = dto.burst ?? null;
    return patch;
  }
}
