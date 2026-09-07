import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Endpoint, Prisma, WebhookSubscription } from '@prisma/client';
import {
  AuditService,
  RequestContext,
  TenantScope,
  TenantScopeFactory,
} from '../authz';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { TenantTransactionRunner } from '../organizations/tenant-transaction';
import {
  CreateSubscriptionDto,
  ListSubscriptionsQueryDto,
  SubscriptionDto,
  SubscriptionListDto,
  UpdateSubscriptionDto,
  toSubscriptionDto,
} from './dto';
import { rejectEventTypes } from './event-type-pattern';
import { crossTenantNotFound, withCrossTenantNotFound } from './not-found';
import { rejectPayloadFilter } from './payload-filter';
import {
  SUBSCRIPTIONS_PER_PROJECT,
  maxSubscriptionsPerProject,
} from './subscription-limits';

/**
 * The columns a request body is allowed to reach.
 *
 * Named one by one rather than spread, so a future request field cannot arrive
 * in the write payload by accident. `projectId` and `enabled` are absent on
 * purpose: the first is the tenant scope's (and `ScopedRepository` refuses it),
 * the second has its own routes.
 */
interface SubscriptionColumns {
  name?: string | null;
  endpointId?: string;
  eventTypes?: string[];
  payloadFilter?: Prisma.InputJsonValue | typeof Prisma.DbNull;
}

/**
 * The same names, as Prisma sees them.
 *
 * This exists only to be typechecked. `SubscriptionColumns` above is written by
 * hand because `payload_filter` and `event_types` need looser value types than
 * either of Prisma's generated inputs offers on its own; that hand-written type
 * would then go on compiling happily after a column was renamed in
 * `schema.prisma`, and the rename would surface as a runtime
 * `'payloadFilter' is not a column on this table` from `ScopedRepository`.
 * Pinning the KEYS against the generated input turns that into a build failure.
 */
export const WRITABLE_COLUMNS: readonly (keyof Pick<
  Prisma.WebhookSubscriptionCreateManyInput,
  'name' | 'endpointId' | 'eventTypes' | 'payloadFilter'
>)[] = ['name', 'endpointId', 'eventTypes', 'payloadFilter'];

/**
 * Webhook subscriptions: which endpoint receives which events.
 *
 * ## This is the module the platform exists for
 *
 * CLAUDE.md opens with it. Convoy's community licence turns
 * `advanced_subscriptions` off and, with it off, a subscription filtered to
 * `["payment.settled"]` is silently rewritten to `["*"]` - it reads back as
 * filtered and receives every event in the project. Finance sees payroll.
 * Support sees settlement. Nothing in the UI says so.
 *
 * Everything below follows from refusing to do that:
 *
 * - A pattern the router cannot honour EXACTLY is a 400, never a coercion.
 *   `event-type-pattern.ts` is the validator and it mirrors
 *   `internal/router/match.go` line for line.
 * - An empty `event_types` is a 400, in both directions. It matches nothing,
 *   the column default matches everything, and guessing which the caller meant
 *   is precisely the move that produced Convoy's bug.
 * - The response returns the stored array verbatim. No sorting, no
 *   de-duplication, no defaulting.
 * - Every filter change is audited with the array before and after, because
 *   "who widened this subscription, and when?" is the question that gets asked
 *   after a leak and it must be answerable without a database session.
 *
 * ## Delete is a HARD delete, and that is a decision, not an omission
 *
 * `endpoints` and `projects` are soft-deleted (`status = 'deleted'`) because
 * `deliveries.endpoint_id` is `ON DELETE RESTRICT` and the delivery ledger is
 * the answer to "did finance ever receive this?" (HANDOFF, "Delivery ledger is
 * no longer cascade-deletable"). Subscriptions are different in three ways that
 * all point the same direction:
 *
 * 1. **`webhook_subscriptions` has no status column and nothing has a foreign
 *    key to it.** `deliveries.subscription_id` is a nullable TEXT column with
 *    NO relation in `schema.prisma` - a reference by convention, not by
 *    constraint. There is no cascade to fear and no constraint to violate, and
 *    a soft delete would need a column this module is not permitted to add.
 * 2. **The ledger does not lose its answer.** A delivery row carries
 *    `endpoint_id` (a real RESTRICT-ed key to a row that is kept forever) and
 *    `event_id`. Deleting a subscription costs the ability to say which ROUTING
 *    RULE matched - not who received what. That is a smaller loss, and it is
 *    repaid: `remove()` writes the whole rule (endpoint, event types, payload
 *    filter, enabled) into the audit log, so the rule behind a historical
 *    delivery is still reconstructable from `audit_logs`.
 * 3. **The alternative is actively worse.** With no status column, "soft
 *    delete" could only mean `enabled = false` - which is what PAUSE already
 *    means. The two would become indistinguishable: a deleted subscription
 *    would sit in the customer's list forever, count against the ceiling, and
 *    be one click from being re-enabled by someone who thought it had been
 *    removed. A tombstone you can accidentally resurrect is not a tombstone.
 *
 * The consequence, stated for whoever implements the operator UI:
 * **`deliveries.subscription_id` can dangle.** It must be rendered as "the
 * subscription that matched has since been deleted", never as a broken link and
 * never as a lookup that throws.
 *
 * ## Two flags? No - one, deliberately
 *
 * Endpoints carry both `enabled` (operator intent) and `status` (current
 * state), because a circuit breaker in the data plane writes the second.
 * Nothing auto-disables a subscription, so it has one flag and `enable` /
 * `disable` are its only writers. A disabled subscription is skipped by
 * `Match()` before the event-type test, so it matches nothing at all - which is
 * the legible way to say "stop delivering" without touching the filter.
 */
@Injectable()
export class WebhookSubscriptionsService {
  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
    private readonly transactions: TenantTransactionRunner,
    private readonly config: ConfigService,
  ) {}

  /**
   * A PAGE of subscriptions, and whether there are more.
   *
   * `findPage`, never `findMany`: a bounded read returning a bare array cannot
   * tell its caller the bound was reached, and the script that loops over this
   * result to disable every subscription pointed at a melting endpoint would
   * cover the first page and report success.
   *
   * Ordered by `id` descending, not `created_at`. Subscription ids are ULIDs, so
   * id order IS creation order - but unlike `created_at` it is a TOTAL order.
   * Two subscriptions created in the same millisecond tie on `created_at`, and a
   * tie at a page boundary is how offset pagination silently repeats one row and
   * skips another. The ordering that makes the boundary correct is the one worth
   * having.
   */
  async list(
    context: RequestContext,
    query: ListSubscriptionsQueryDto,
  ): Promise<SubscriptionListDto> {
    const scope = this.scopes.for(context);

    const where: Prisma.WebhookSubscriptionWhereInput = {};
    if (query.endpoint_id !== undefined) {
      // Resolved through its own scoped repository before it becomes a filter.
      // The tenant predicate would already make a foreign id match nothing, but
      // "no subscriptions" and "not your endpoint" must not be distinguishable
      // by trying, and every other route in this module answers the second with
      // a 404.
      await this.requireEndpoint(scope, query.endpoint_id);
      where.endpointId = query.endpoint_id;
    }
    if (query.enabled !== undefined) where.enabled = query.enabled;

    const page = await scope.subscriptions.findPage({
      where,
      orderBy: { id: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      data: page.rows.map(toSubscriptionDto),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  async get(context: RequestContext, subscriptionId: string): Promise<SubscriptionDto> {
    const scope = this.scopes.for(context);
    return toSubscriptionDto(await this.require(scope, subscriptionId));
  }

  /**
   * Create a subscription.
   *
   * Runs inside one SERIALIZABLE transaction (`TenantTransactionRunner`)
   * because the ceiling is a read-then-write over a SET of rows: count the
   * project's subscriptions, then insert one more. At READ COMMITTED two
   * concurrent creates both read `n`, both insert, and the project ends up at
   * `n + 2` with a ceiling of `n + 1` - and the two INSERTs touch different
   * rows, so nothing blocks and nothing notices. That is the exact shape the
   * members module's last-owner bug had; see the `TenantTransactionRunner`
   * docblock.
   *
   * The ceiling is not cosmetic here. Subscriptions are the fan-out multiplier:
   * one event becomes one `deliveries` row PER matching subscription, each with
   * its own retry chain. An unbounded subscription count is an unbounded
   * amplification factor on every event the project ingests.
   *
   * The id is minted OUTSIDE the callback so a serialisation retry re-uses it
   * rather than burning a fresh ULID per attempt.
   */
  async create(context: RequestContext, dto: CreateSubscriptionDto): Promise<SubscriptionDto> {
    // Asserted here as well as at the DTO edge. The DTO is only reached over
    // HTTP; this rule must hold for a job, a CLI or a test too, and it is the
    // one rule in this codebase whose failure is a silent cross-customer data
    // leak rather than an error.
    WebhookSubscriptionsService.assertEventTypes(dto.event_types);
    WebhookSubscriptionsService.assertPayloadFilter(dto.payload_filter);

    const id = newId('subscription');
    const now = new Date();

    return withCrossTenantNotFound(
      this.transactions.run(context, async (scope, audit) => {
        const endpoint = await this.requireEndpoint(scope, dto.endpoint_id);
        await this.requireHeadroom(scope);

        const created = await scope.subscriptions.create({
          id,
          endpointId: endpoint.id,
          name: dto.name ?? null,
          eventTypes: [...dto.event_types],
          payloadFilter: WebhookSubscriptionsService.filterColumn(dto.payload_filter),
          enabled: dto.enabled ?? true,
          // Stated rather than defaulted, so `created_at` and `updated_at` come
          // off one clock reading.
          createdAt: now,
          updatedAt: now,
        });

        await audit.record({
          action: 'subscription.created',
          resourceType: 'subscription',
          resourceId: id,
          metadata: {
            endpoint_id: created.endpointId,
            name: created.name,
            // The whole filter, because "what was this subscribed to?" is the
            // question the audit log exists to answer here. It is bounded by
            // `rejectEventTypes` and `rejectPayloadFilter`, so it cannot be
            // large enough to matter.
            event_types: [...created.eventTypes],
            has_payload_filter: created.payloadFilter !== null,
            enabled: created.enabled,
          },
        });

        return toSubscriptionDto(created);
      }),
    );
  }

  /**
   * Replace fields. Not a merge: `event_types` and `payload_filter` are
   * wholesale replacements, which is what the DTO says and what the audit entry
   * records.
   *
   * In a transaction with the audit write, so the log and the change commit
   * together - an audit row for a filter change that rolled back is worse than
   * none, and this is the log someone reads after a leak.
   */
  async update(
    context: RequestContext,
    subscriptionId: string,
    dto: UpdateSubscriptionDto,
  ): Promise<SubscriptionDto> {
    if (dto.event_types !== undefined) {
      WebhookSubscriptionsService.assertEventTypes(dto.event_types);
    }
    if (dto.payload_filter !== undefined) {
      WebhookSubscriptionsService.assertPayloadFilter(dto.payload_filter);
    }

    return withCrossTenantNotFound(
      this.transactions.run(context, async (scope, audit) => {
        const current = await this.require(scope, subscriptionId);

        const data: SubscriptionColumns = {};
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.event_types !== undefined) data.eventTypes = [...dto.event_types];
        if (dto.payload_filter !== undefined) {
          data.payloadFilter = WebhookSubscriptionsService.filterColumn(dto.payload_filter);
        }
        if (dto.endpoint_id !== undefined) {
          // Proved to be in this tenant, and not deleted, before it is written.
          // `ScopedRepository` would check ownership on the write too; doing it
          // here is what makes the refusal carry this module's single 404
          // message rather than "Endpoint not found."
          const endpoint = await this.requireEndpoint(scope, dto.endpoint_id);
          data.endpointId = endpoint.id;
        }

        if (Object.keys(data).length === 0) return toSubscriptionDto(current);

        const updated = await scope.subscriptions.updateById(subscriptionId, data);
        await audit.record({
          action: 'subscription.updated',
          resourceType: 'subscription',
          resourceId: subscriptionId,
          metadata: {
            fields: Object.keys(data).sort(),
            // The filter is THE security-relevant field, so both sides of a
            // change to it are recorded rather than "event_types changed".
            // Widening a subscription is the move this whole module is built to
            // make visible, and it must be visible afterwards too.
            ...(data.eventTypes !== undefined
              ? {
                  event_types_from: [...current.eventTypes],
                  event_types_to: [...updated.eventTypes],
                }
              : {}),
            ...(data.endpointId !== undefined && current.endpointId !== updated.endpointId
              ? { endpoint_id_from: current.endpointId, endpoint_id_to: updated.endpointId }
              : {}),
            ...(data.payloadFilter !== undefined
              ? { has_payload_filter: updated.payloadFilter !== null }
              : {}),
          },
        });
        return toSubscriptionDto(updated);
      }),
    );
  }

  /** Resume matching. Idempotent. */
  async enable(context: RequestContext, subscriptionId: string): Promise<SubscriptionDto> {
    return this.setEnabled(context, subscriptionId, true);
  }

  /**
   * Stop matching, keep the filter.
   *
   * `Match()` skips a disabled subscription before it looks at `event_types`,
   * so this is the legible way to say "deliver nothing to this route" - and it
   * is what an empty `event_types` array is refused in favour of.
   */
  async disable(
    context: RequestContext,
    subscriptionId: string,
    reason?: string,
  ): Promise<SubscriptionDto> {
    return this.setEnabled(context, subscriptionId, false, reason);
  }

  /**
   * Hard delete. Idempotent: removing an already-removed subscription
   * succeeds with 204 rather than 404, so a retrying script is not punished for
   * having worked the first time.
   *
   * The row is really gone - see the class docblock for why that is right here
   * and wrong for endpoints. The whole routing rule goes into the audit log on
   * the way out, which is what keeps a historical `deliveries.subscription_id`
   * explainable after the row it names no longer exists.
   */
  async remove(context: RequestContext, subscriptionId: string): Promise<void> {
    await withCrossTenantNotFound(
      this.transactions.run(context, async (scope, audit) => {
        const current = await scope.subscriptions.findById(subscriptionId);
        if (!current) return;

        await scope.subscriptions.deleteById(subscriptionId);
        await audit.record({
          action: 'subscription.deleted',
          resourceType: 'subscription',
          resourceId: subscriptionId,
          metadata: {
            hard_delete: true,
            // The complete rule. `deliveries.subscription_id` has no foreign key
            // and will now dangle, so this entry is the only remaining record of
            // what matched.
            endpoint_id: current.endpointId,
            name: current.name,
            event_types: [...current.eventTypes],
            payload_filter: current.payloadFilter ?? null,
            enabled: current.enabled,
          },
        });
      }),
    );
  }

  // ---------------------------------------------------------------------------

  private async setEnabled(
    context: RequestContext,
    subscriptionId: string,
    enabled: boolean,
    reason?: string,
  ): Promise<SubscriptionDto> {
    return withCrossTenantNotFound(
      this.transactions.run(context, async (scope, audit) => {
        const current = await this.require(scope, subscriptionId);
        if (current.enabled === enabled) return toSubscriptionDto(current);

        const updated = await scope.subscriptions.updateById(subscriptionId, { enabled });
        await audit.record({
          action: enabled ? 'subscription.enabled' : 'subscription.disabled',
          resourceType: 'subscription',
          resourceId: subscriptionId,
          metadata: {
            endpoint_id: current.endpointId,
            event_types: [...current.eventTypes],
            reason: reason ?? null,
          },
        });
        return toSubscriptionDto(updated);
      }),
    );
  }

  /**
   * 404 with the layer's single message, for an absent id and a foreign id
   * alike. Never a fetch-then-check: the tenant predicate is already in the
   * WHERE clause, so a foreign id matches no row in the database.
   */
  private async require(
    scope: TenantScope,
    subscriptionId: string,
  ): Promise<WebhookSubscription> {
    const subscription = await scope.subscriptions.findById(subscriptionId);
    if (!subscription) throw crossTenantNotFound();
    return subscription;
  }

  /**
   * Prove a caller-supplied `endpoint_id` is an endpoint in THIS project, and
   * one that can actually receive anything.
   *
   * Two failures, two different answers, and the difference is deliberate:
   *
   * - Not in this tenant, or absent: 404 with `CROSS_TENANT_MESSAGE`. The
   *   caller learns nothing about whether the id is real somewhere else. This
   *   is the check the security review named - `endpoint_id` is the one field
   *   on this resource that points at another table, and left unchecked it
   *   would let a subscription be stamped with the caller's project while
   *   pointing at another customer's endpoint.
   * - Deleted: 409. The endpoint IS visible to this caller through
   *   `GET /endpoints/:id` (soft-deleted endpoints are returned so the delivery
   *   ledger stays readable), so a 404 here would be confusing rather than
   *   protective. Binding to it would create a subscription that can never
   *   deliver, silently.
   */
  private async requireEndpoint(scope: TenantScope, endpointId: string): Promise<Endpoint> {
    const endpoint = await scope.endpoints.findById(endpointId);
    if (!endpoint) throw crossTenantNotFound();
    if (endpoint.status === 'deleted') {
      throw new AppError(
        'conflict',
        'That endpoint has been deleted, so a subscription pointed at it could never deliver. ' +
          'Pick another endpoint, or create a new one.',
        { endpoint_id: endpointId },
      );
    }
    return endpoint;
  }

  /**
   * Refuse a create that would take the project past its subscription ceiling.
   *
   * Counted through the scope, so it counts THIS project's rows and no one
   * else's, and counted INSIDE the caller's transaction - which is what makes
   * it an invariant rather than an advisory limit two concurrent creates can
   * both walk past. `webhook-subscriptions.concurrency.spec.ts` asserts that
   * property under `Promise.allSettled` and demonstrates the count-outside
   * shape failing it.
   *
   * Every row counts. There is no soft delete here, so there is no class of row
   * that is kept for the ledger and must be excluded - the reason the endpoint
   * and API-key ceilings each need an exclusion clause.
   */
  private async requireHeadroom(scope: TenantScope): Promise<void> {
    const ceiling = maxSubscriptionsPerProject(this.config);
    const existing = await scope.subscriptions.count();
    if (existing < ceiling) return;
    throw new AppError(
      // A dedicated code, not `conflict`. `conflict` on this module already
      // means "that endpoint is deleted", and a client that had to tell the two
      // apart by reading the sentence would break the day someone reworded it.
      // The details are the contract; the message is for a human.
      'limit_exceeded',
      `This project already has ${existing} subscriptions, which is its limit of ${ceiling}. ` +
        'Every subscription multiplies the deliveries one event produces, so the ceiling is ' +
        'real work rather than a row count. Delete one you no longer need, or ask an operator ' +
        `to raise ${SUBSCRIPTIONS_PER_PROJECT.env}.`,
      { limit: ceiling, current: existing, resource: 'subscriptions' },
    );
  }

  /**
   * The service-side half of the filter guarantee.
   *
   * `EventTypesConstraint` runs first for HTTP callers; this runs for everyone.
   * It never rewrites - the only outcomes are "stored exactly as given" and a
   * 400 naming what is wrong. `event_types: null` reaches here from a PATCH
   * because `@IsOptional()` skips validation for null as well as undefined, and
   * `rejectEventTypes` answers that with "must be an array".
   */
  private static assertEventTypes(value: unknown): void {
    const rejection = rejectEventTypes(value);
    if (!rejection) return;
    throw new AppError('invalid_request', rejection, { field: 'event_types' });
  }

  private static assertPayloadFilter(value: unknown): void {
    const rejection = rejectPayloadFilter(value);
    if (!rejection) return;
    throw new AppError('invalid_request', rejection, { field: 'payload_filter' });
  }

  /**
   * `DbNull`, not `JsonNull`: the column should be SQL NULL when there is no
   * filter, not the JSON value `null`, which reads back as present-but-null and
   * would make "does this subscription filter on the body?" unanswerable in
   * SQL - and would be read by the Go side as a filter it cannot evaluate.
   */
  private static filterColumn(
    filter: Record<string, unknown> | null | undefined,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    if (filter === null || filter === undefined) return Prisma.DbNull;
    return filter as Prisma.InputJsonValue;
  }
}
