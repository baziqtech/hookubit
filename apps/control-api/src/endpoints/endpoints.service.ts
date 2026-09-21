import { Injectable, Logger } from '@nestjs/common';
import { Endpoint, Prisma } from '@prisma/client';
import {
  AuditService,
  CROSS_TENANT_MESSAGE,
  RequestContext,
  TenantScope,
  TenantScopeFactory,
} from '../authz';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { EndpointHealthService } from './endpoint-health.service';
import { EndpointSecretsService } from '../endpoint-secrets/endpoint-secrets.service';
import {
  CreateEndpointDto,
  CreatedEndpointDto,
  EndpointDto,
  EndpointListDto,
  ListEndpointsQueryDto,
  UpdateEndpointDto,
  toEndpointDto,
} from './dto';
import { normaliseCustomHeaders } from './endpoint-headers';
import { MAX_ENDPOINTS_PER_PROJECT } from './endpoint-limits';
import { normaliseEndpointUrl } from './endpoint-url';

/**
 * The columns a request body is allowed to reach, named one by one.
 *
 * Derived from Prisma's scalars-only create input so a column that is renamed or
 * retyped in `schema.prisma` breaks the build here rather than silently ceasing
 * to be written. `projectId`, `status`, `enabled` and the circuit breaker's
 * columns are absent on purpose - none of them is a request field.
 */
type EndpointColumns = Partial<
  Pick<
    Prisma.EndpointCreateManyInput,
    | 'description'
    | 'timeoutMs'
    | 'maxConcurrency'
    | 'rateLimit'
    | 'rateLimitWindowSeconds'
    | 'retryPolicyId'
    | 'customHeaders'
  >
>;

/**
 * Endpoint configuration: the customer-owned URLs this platform delivers to.
 *
 * ## Soft delete, always
 *
 * `deliveries.endpoint_id` is `ON DELETE RESTRICT` (see HANDOFF, "Delivery
 * ledger is no longer cascade-deletable") and that is not an accident to be
 * worked around. The delivery ledger is the answer to "did finance ever receive
 * this?", and that question outlives the endpoint by years - it is usually asked
 * *because* something was changed or removed. A hard delete would either fail on
 * the constraint or, before it existed, take months of `delivery_attempts` with
 * it through two cascade chains.
 *
 * So removal is `status = 'deleted'`: the row stays, the ledger still joins, and
 * the endpoint disappears from listings. Nothing in this service calls
 * `deleteById`.
 *
 * ## Two flags, two owners
 *
 * `enabled` is operator intent - what a human asked for. `status` is the current
 * state, and `disabled_reason`/`disabled_at` are the record of an AUTOMATIC
 * disable. Pausing an endpoint from here therefore sets `enabled` and `status`
 * and deliberately does NOT write those two columns; the reason a human gave
 * goes to the audit log, where a reason belongs. Enabling clears them, because
 * an operator re-enabling an auto-disabled endpoint is exactly the deliberate
 * override they are waiting for.
 *
 * The automatic writer is `src/maintenance`, in THIS plane, not the data plane
 * (which still issues no write against `endpoints` at all). Its docblock carries
 * the argument for that split; what matters here is that the two writers never
 * touch the same row from two processes without a predicate: the sweep's UPDATE
 * repeats `status: 'active', enabled: true`, so an operator pause that lands
 * first simply wins and no audit entry is filed for a disable that did not
 * happen.
 *
 * ## The one thing this service writes outside `endpoints`
 *
 * `enable` nudges `endpoint_health.probe_after` - see `armBreakerProbe`. That
 * table is otherwise the data plane's exclusively, and the exception is
 * deliberately one column wide: without it, resuming a recovered endpoint means
 * waiting out a cooldown that has doubled to its ten-minute ceiling, and with a
 * fuller reset it means releasing the entire backlog at an endpoint whose
 * recovery is still only a customer's assertion.
 */
@Injectable()
export class EndpointsService {
  private readonly logger = new Logger(EndpointsService.name);

  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
    private readonly secrets: EndpointSecretsService,
    private readonly health: EndpointHealthService,
  ) {}

  /**
   * A PAGE of endpoints, and whether there are more.
   *
   * `findPage` rather than `findMany`: a bounded read that returns a bare array
   * cannot tell its caller the bound was reached, so a UI - or a script looping
   * to disable every endpoint in a project - covered the first page and
   * reported success. `has_more`/`next_offset` are what make "I saw all of
   * them" expressible on the wire.
   */
  async list(context: RequestContext, query: ListEndpointsQueryDto): Promise<EndpointListDto> {
    const where: Prisma.EndpointWhereInput = query.status
      ? { status: query.status }
      : query.include_deleted
        ? {}
        : { status: { not: 'deleted' } };

    const page = await this.scopes.for(context).endpoints.findPage({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });

    // ONE grouped read for the whole page, not one per row. `has_live_secret`
    // is on every endpoint in the busiest listing in the operator UI; asked per
    // endpoint, a page of MAX_PAGE_SIZE would be 200 extra round trips.
    const ids = page.rows.map((endpoint) => endpoint.id);

    // Health is computed BESIDE the list, not inside it, and a failure to
    // compute it must not take the list down: this page is how you fix a
    // broken endpoint, and it has to render when the thing it describes is on
    // fire. An endpoint whose health is missing shows its configuration and
    // says nothing about its rate, which is the honest degradation.
    const [live, health] = await Promise.all([
      this.secrets.liveSecretEndpointIds(context, ids),
      this.health.summarise(context, ids).catch(() => new Map()),
    ]);

    return {
      data: page.rows.map((endpoint) =>
        toEndpointDto(endpoint, live.has(endpoint.id), health.get(endpoint.id)),
      ),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  /**
   * A soft-deleted endpoint IS returned here, with `status: "deleted"`.
   *
   * That is deliberate and is the other half of the soft delete: a delivery in
   * the ledger points at this id, and an operator following that link at 2am
   * needs to see the URL it went to, not a 404 that makes the ledger row
   * unreadable.
   */
  async get(context: RequestContext, endpointId: string): Promise<EndpointDto> {
    const endpoint = await this.require(this.scopes.for(context), endpointId);
    return toEndpointDto(endpoint, await this.secrets.hasLiveSecret(context, endpointId));
  }

  /**
   * Create the endpoint and its version 1 signing secret.
   *
   * The endpoint is inserted **paused** and only flipped to active once the
   * secret exists. That ordering is what keeps the signing invariant true
   * without a transaction (`ScopedRepository` cannot open one without the raw
   * client, which is banned in this module): an endpoint that never becomes
   * active while it has no secret can never be dispatched to, so
   * `signing.Header` can never be asked to sign for it and fail closed.
   *
   * ## Who may receive the plaintext decides whether it goes live
   *
   * `endpoints.write` is held by `developer`; `endpoint-secrets.*` is owner and
   * admin only, deliberately, because whoever holds a signing secret can forge a
   * webhook into the customer's own consumers.
   *
   * This used to mean a developer got a live, enabled, subscribable endpoint
   * whose HMAC key existed only as ciphertext. Every delivery was then signed
   * with a key the consumer had never been given, so every one of them failed
   * verification - and the fix, an owner rotating to obtain the secret, CHANGED
   * the key again. Two verification outages where the honest answer is none.
   *
   * So when the creator cannot be handed the secret, the endpoint simply stays
   * in the paused state it was already created in and the response says
   * `secret_pending: true`. Nothing is delivered with an unusable key, and
   * `enable` - which already refuses an endpoint with no live secret - is the
   * step that takes it live once an owner has rotated and handed the consumer
   * the plaintext. The permission split is untouched: the developer still never
   * sees a secret.
   */
  async create(context: RequestContext, dto: CreateEndpointDto): Promise<CreatedEndpointDto> {
    const scope = this.scopes.for(context);
    await this.requireRetryPolicy(scope, dto.retry_policy_id);
    await this.requireHeadroom(scope);

    // Only a caller who may READ signing secrets can be handed this one, and
    // that decides whether the endpoint goes live now or waits for a rotation.
    const mayReceiveSecret = context.has('endpoint-secrets.write');

    const id = newId('endpoint');
    const now = new Date();
    const created = await scope.endpoints.create({
      id,
      ...this.writableColumns(dto),
      name: dto.name,
      url: normaliseEndpointUrl(dto.url),
      // Paused until the secret lands. See the docblock.
      status: 'paused',
      enabled: false,
      // Stated rather than defaulted, so `created_at` and `updated_at` come off
      // one clock reading and an endpoint is never newer than the secret that
      // was minted for it.
      createdAt: now,
      updatedAt: now,
    });

    let minted: { secret: string; version: number };
    try {
      minted = await this.secrets.mintInitial(context, id);
    } catch (err) {
      // The endpoint is inert (paused, never dispatched to) but it is litter, and
      // litter in a customer's endpoint list gets enabled by someone eventually.
      // Mark it removed on the way out; the original failure is what the caller
      // needs to see, so a failure here is logged and swallowed rather than
      // replacing it.
      await scope.endpoints
        .updateById(id, { status: 'deleted', enabled: false })
        .catch((cleanupError: unknown) =>
          this.logger.error(
            `Endpoint ${id} was created but its signing secret could not be minted, and marking ` +
              `it deleted also failed. It is paused and has no secret; remove it manually. ` +
              `${String(cleanupError)}`,
          ),
        );
      throw err;
    }

    // Live only if the plaintext is going back with this response. Otherwise it
    // stays exactly as created - paused, disabled, delivering nothing.
    const live = mayReceiveSecret
      ? await scope.endpoints.updateById(id, { status: 'active', enabled: true })
      : created;

    await this.audit.recordFor(context, {
      action: 'endpoint.created',
      resourceType: 'endpoint',
      resourceId: id,
      metadata: {
        url: live.url,
        name: live.name,
        secret_version: minted.version,
        status: live.status,
        // Why it is paused, for whoever asks later why this endpoint never
        // delivered anything.
        awaiting_key_handover: !mayReceiveSecret,
      },
    });

    return {
      // `mintInitial` has just committed a version 1 secret: active, no expiry.
      // Both branches above reach here with it, so this is true even for the
      // developer whose endpoint stays paused awaiting the key handover - which
      // is the point, since `has_live_secret` is what tells the dashboard that
      // enabling it would now succeed.
      ...toEndpointDto(live, true),
      // Withheld from a caller who may create endpoints but not read their
      // secrets. The secret exists either way; only this response varies.
      secret: mayReceiveSecret ? minted.secret : null,
      secret_pending: !mayReceiveSecret,
      secret_version: minted.version,
    };
  }

  async update(
    context: RequestContext,
    endpointId: string,
    dto: UpdateEndpointDto,
  ): Promise<EndpointDto> {
    const scope = this.scopes.for(context);
    const current = await this.require(scope, endpointId);
    EndpointsService.assertNotDeleted(current);
    await this.requireRetryPolicy(scope, dto.retry_policy_id);

    const data: EndpointColumns & { name?: string; url?: string } = this.writableColumns(dto);
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.url !== undefined) data.url = normaliseEndpointUrl(dto.url);

    // Nothing here touches `endpoint_secrets`, but the response shape carries
    // the flag, so it is read rather than assumed. One row, one statement.
    const live = await this.secrets.hasLiveSecret(context, endpointId);
    if (Object.keys(data).length === 0) return toEndpointDto(current, live);

    const updated = await scope.endpoints.updateById(endpointId, data);
    await this.audit.recordFor(context, {
      action: 'endpoint.updated',
      resourceType: 'endpoint',
      resourceId: endpointId,
      metadata: {
        fields: Object.keys(data).sort(),
        // The destination is the security-relevant field, so both sides of a
        // change to it are recorded rather than just "url changed".
        ...(data.url !== undefined && current.url !== updated.url
          ? { url_from: current.url, url_to: updated.url }
          : {}),
      },
    });
    return toEndpointDto(updated, live);
  }

  /**
   * Resume deliveries.
   *
   * Refused when the endpoint has no live signing secret. An enabled endpoint
   * with none is the exact state `signing.Header` returns `ErrNoSecrets` for, so
   * enabling would not produce deliveries - it would produce a queue of
   * permanently failing ones and a customer wondering why.
   *
   * ## This is the way back from an automatic disable
   *
   * `src/maintenance` switches off an endpoint whose circuit breaker has been
   * open past the window. Auto-disable is only defensible because this route
   * exists and is the ordinary `endpoints.write` one - a customer does not need
   * support, a flag or a different permission to undo it. There is deliberately
   * no separate "re-enable an auto-disabled endpoint" route: a second way to do
   * the same thing is a second set of preconditions to keep in step.
   */
  async enable(context: RequestContext, endpointId: string): Promise<EndpointDto> {
    const scope = this.scopes.for(context);
    const current = await this.require(scope, endpointId);
    EndpointsService.assertNotDeleted(current);

    if (!(await this.secrets.hasLiveSecret(context, endpointId))) {
      throw new AppError(
        'conflict',
        'This endpoint has no active signing secret, so its deliveries could not be signed. ' +
          'Rotate a secret first, then enable it.',
      );
    }

    const updated = await scope.endpoints.updateById(endpointId, {
      enabled: true,
      status: 'active',
      // An operator enabling an auto-disabled endpoint is the deliberate
      // override the breaker's columns are waiting for. Leaving them set would
      // make the next reader think it is still tripped.
      disabledReason: null,
      disabledAt: null,
    });
    const probeArmed = await this.armBreakerProbe(scope, endpointId);
    await this.audit.recordFor(context, {
      action: 'endpoint.enabled',
      resourceType: 'endpoint',
      resourceId: endpointId,
      metadata: {
        previous_status: current.status,
        // Both halves of "what was this endpoint's state before I pressed the
        // button" - the automatic reason that is about to be cleared, and
        // whether the breaker was still tripped. Without them, an endpoint
        // that was auto-disabled and re-enabled leaves no trace of the first
        // half anywhere a customer can read.
        previous_disabled_reason: current.disabledReason ?? null,
        breaker_probe_armed: probeArmed,
      },
    });
    // Proved live a few lines up, by the check that would have refused.
    return toEndpointDto(updated, true);
  }

  /**
   * Bring the circuit breaker's next probe forward to now, if it is tripped.
   *
   * ## Why re-enabling is not enough on its own
   *
   * `enabled`/`status` and `endpoint_health` are different facts with different
   * owners. Clearing the first says "deliver here again"; it says nothing to the
   * breaker, whose cooldown doubles per failure to a ten-minute ceiling. An
   * endpoint that has been dark for days is at that ceiling, so a customer who
   * has just fixed their consumer and pressed Resume watches nothing happen for
   * up to ten minutes while every new delivery is claimed, refused and deferred.
   *
   * ## Why this is a nudge and not a reset
   *
   * The obvious move - set the health row back to `healthy` - is the thundering
   * herd. `healthy` admits EVERY delivery, so the full ingest rate arrives at an
   * endpoint whose recovery is still a customer's assertion rather than an
   * observed fact; if they were wrong, we have just re-created the storm the
   * breaker exists to prevent, at the worst possible moment.
   *
   * So this writes ONE column. The state machine is untouched, no counter is
   * reset, and `probe_after <= now()` is precisely the condition
   * `worker.ClaimProbe` looks for - a conditional UPDATE in which the predicate
   * that admits a probe is also the write that withdraws the invitation. Exactly
   * one worker wins it, exactly one delivery goes out, and the existing
   * half-open protocol decides what happens next: one success closes the
   * breaker and the backlog drains normally, one failure re-opens it with its
   * cooldown intact. That is the same mechanism the breaker already uses for
   * transient failure, borrowed rather than duplicated.
   *
   * `state IN ('open', 'half_open')` and nothing else. A healthy or degraded
   * breaker is already admitting traffic and has no probe to bring forward, and
   * the returned count is what tells the audit entry which case this was.
   *
   * `new Date()` is the API's clock while `probe_after <= now()` is the
   * database's. A few seconds of skew either way costs at most one worker poll
   * (250ms) of extra delay, which is why this is not worth a raw `now()`.
   */
  private async armBreakerProbe(scope: TenantScope, endpointId: string): Promise<boolean> {
    const armed = await scope.endpointHealth.updateMany(
      { endpointId, state: { in: ['open', 'half_open'] } },
      { probeAfter: new Date() },
    );
    return armed > 0;
  }

  /**
   * Stop delivering, keep everything.
   *
   * `disabled_reason`/`disabled_at` are NOT written: they are the circuit
   * breaker's record of an automatic disable, and overwriting them from here
   * would erase why the platform stopped delivering. The human's reason goes to
   * the audit log.
   */
  async disable(
    context: RequestContext,
    endpointId: string,
    reason?: string,
  ): Promise<EndpointDto> {
    const scope = this.scopes.for(context);
    const current = await this.require(scope, endpointId);
    EndpointsService.assertNotDeleted(current);

    const updated = await scope.endpoints.updateById(endpointId, {
      enabled: false,
      status: 'paused',
    });
    await this.audit.recordFor(context, {
      action: 'endpoint.disabled',
      resourceType: 'endpoint',
      resourceId: endpointId,
      metadata: { previous_status: current.status, reason: reason ?? null },
    });
    // Pausing leaves the secrets alone, so this is read rather than assumed -
    // and it is the field the dashboard reads next, to decide whether the
    // "Resume deliveries" button it is about to render would actually work.
    return toEndpointDto(updated, await this.secrets.hasLiveSecret(context, endpointId));
  }

  /**
   * Soft delete. Idempotent: removing an already-removed endpoint succeeds.
   *
   * The row is never deleted - see the class docblock. `deliveries` and
   * `delivery_attempts` keep pointing at it, so every past delivery stays
   * explainable after the endpoint is gone from the UI.
   */
  async remove(context: RequestContext, endpointId: string): Promise<void> {
    const scope = this.scopes.for(context);
    const current = await this.require(scope, endpointId);
    if (current.status === 'deleted') return;

    await scope.endpoints.updateById(endpointId, { status: 'deleted', enabled: false });
    await this.audit.recordFor(context, {
      action: 'endpoint.deleted',
      resourceType: 'endpoint',
      resourceId: endpointId,
      metadata: { url: current.url, name: current.name, soft_delete: true },
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * 404 with the layer's single message, for an absent id and for an id in
   * another tenant alike. Never a fetch-then-check: the tenant predicate is
   * already in the WHERE clause, so a foreign id matches no row in the database.
   */
  private async require(scope: TenantScope, endpointId: string): Promise<Endpoint> {
    const endpoint = await scope.endpoints.findById(endpointId);
    if (!endpoint) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
    return endpoint;
  }

  /**
   * Prove a caller-supplied `retry_policy_id` belongs to this project.
   *
   * `ScopedRepository` checks declared foreign keys on write too, so this is
   * belt and braces - but it is checked HERE so the refusal carries the same
   * `Resource not found.` every other cross-tenant miss in this module carries,
   * rather than a per-resource sentence that would let a caller tell the two
   * apart.
   */
  private async requireRetryPolicy(
    scope: TenantScope,
    retryPolicyId: string | null | undefined,
  ): Promise<void> {
    if (retryPolicyId === undefined || retryPolicyId === null) return;
    const policy = await scope.retryPolicies.findById(retryPolicyId);
    if (!policy) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
  }

  /**
   * Refuse a create that would take the project past its endpoint ceiling.
   *
   * `count` through the scope, so it counts THIS project's rows and no one
   * else's. Deleted endpoints are excluded - they are kept forever for the
   * delivery ledger, and counting them would make a long-lived project
   * permanently uncreatable. See `MAX_ENDPOINTS_PER_PROJECT` for why a ceiling
   * exists at all.
   */
  private async requireHeadroom(scope: TenantScope): Promise<void> {
    const live = await scope.endpoints.count({ status: { not: 'deleted' } });
    if (live < MAX_ENDPOINTS_PER_PROJECT) return;
    // `limit_exceeded`, not `conflict`, and with structured details. `conflict`
    // on this module already means "this endpoint is deleted"; a client that had
    // to tell a ceiling from that by reading the sentence breaks the day someone
    // rewords one. The message is for a human, the details are the contract.
    throw new AppError(
      'limit_exceeded',
      `This project already has ${MAX_ENDPOINTS_PER_PROJECT} endpoints, which is the maximum. ` +
        'Delete one you no longer deliver to, or talk to us about a higher limit.',
      { limit: MAX_ENDPOINTS_PER_PROJECT, current: live, resource: 'endpoints' },
    );
  }

  private static assertNotDeleted(endpoint: Endpoint): void {
    if (endpoint.status !== 'deleted') return;
    // Not a 404: the caller is inside the tenant and can see the row through
    // GET, so hiding it here would be confusing rather than protective.
    throw new AppError(
      'conflict',
      'This endpoint has been deleted. Deleted endpoints are kept so the delivery ledger ' +
        'stays readable, but they cannot be modified.',
    );
  }

  /**
   * The subset of the DTO that maps to columns, snake_case to camelCase.
   *
   * Explicit rather than a spread: a spread would let any future request field
   * reach the write payload, and `ScopedRepository` would only catch the ones
   * that happen to collide with a column name. `status` is absent on purpose -
   * it has its own routes with their own preconditions.
   */
  private writableColumns(dto: CreateEndpointDto | UpdateEndpointDto): EndpointColumns {
    const data: EndpointColumns = {};
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.timeout_ms !== undefined) data.timeoutMs = dto.timeout_ms;
    if (dto.max_concurrency !== undefined) data.maxConcurrency = dto.max_concurrency;
    if (dto.rate_limit !== undefined) data.rateLimit = dto.rate_limit;
    if (dto.rate_limit_window_seconds !== undefined) {
      data.rateLimitWindowSeconds = dto.rate_limit_window_seconds;
    }
    if (dto.retry_policy_id !== undefined) data.retryPolicyId = dto.retry_policy_id;
    if (dto.custom_headers !== undefined) {
      data.customHeaders = normaliseCustomHeaders(dto.custom_headers) ?? Prisma.DbNull;
    }
    return data;
  }
}
