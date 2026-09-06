import { Injectable } from '@nestjs/common';
import {
  ApiKey,
  AuditLog,
  BillingSubscription,
  Delivery,
  DeliveryAttempt,
  Endpoint,
  EndpointHealth,
  EndpointSecret,
  Event,
  IdempotencyKey,
  Organization,
  OrganizationMember,
  Prisma,
  Project,
  RateLimitPolicy,
  RetryPolicy,
  UsageRecord,
  WebhookSubscription,
} from '@prisma/client';
import { AppError } from '../common/errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RequestContext } from './tenant-context';
import {
  ModelDelegate,
  OwnedRepository,
  OwnershipVerifier,
  ScopedRepository,
  TenantScopeKind,
  TransactionRunner,
} from './tenant-scope';

/**
 * Anything that exposes Prisma's model delegates: the client itself, or the
 * transaction client handed to a `$transaction` callback. Passing the latter
 * keeps a multi-write operation atomic without losing tenant scoping.
 */
export type TenantClient = PrismaService | Prisma.TransactionClient;

type Repo<TWhere, TOrderBy, TCreate extends object, TUpdate extends object, TRecord extends object> =
  ScopedRepository<TWhere, TOrderBy, TCreate, TUpdate, TRecord>;

/**
 * Every repository `TenantScope` exposes.
 *
 * A repository declares its tenant-owned foreign keys by naming one of these,
 * and the name is checked at compile time, so a typo in a `foreignKeys` map is
 * a build error rather than a silently skipped ownership check.
 */
export type TenantRepositoryName =
  | 'organization'
  | 'projects'
  | 'members'
  | 'auditLogs'
  | 'usageRecords'
  | 'billingSubscriptions'
  | 'endpoints'
  | 'endpointSecrets'
  | 'endpointHealth'
  | 'apiKeys'
  | 'subscriptions'
  | 'retryPolicies'
  | 'rateLimitPolicies'
  | 'idempotencyKeys'
  | 'events'
  | 'deliveries'
  | 'deliveryAttempts';

/** Column -> the repository that owns the table it points at. */
type ForeignKeys = Readonly<Record<string, TenantRepositoryName>>;

/** Prisma client property names for the tables covered here. */
type DelegateKey =
  | 'organization'
  | 'organizationMember'
  | 'project'
  | 'endpoint'
  | 'endpointSecret'
  | 'endpointHealth'
  | 'webhookSubscription'
  | 'apiKey'
  | 'retryPolicy'
  | 'rateLimitPolicy'
  | 'idempotencyKey'
  | 'event'
  | 'delivery'
  | 'deliveryAttempt'
  | 'auditLog'
  | 'usageRecord'
  | 'billingSubscription';

/**
 * Every tenant-owned table, already fenced to the request's organization and
 * project.
 *
 * A Phase 2 service should inject `TenantScopeFactory` and nothing else from
 * the data layer. Injecting `PrismaService` directly is the unsafe path, and it
 * is meant to be conspicuous: it shows up in a constructor, in review, and in
 * `grep -r 'PrismaService' src/<module>`. That argument only holds if the safe
 * path is complete, which is why `endpointHealth`, `organization`, `aggregate`
 * and `groupBy` are here: a dashboard that cannot be written through the scope
 * gets written through `PrismaService` instead, and `PrismaService` is
 * `@Global()`, so reaching for it costs an author nothing.
 *
 * Not covered here, on purpose: `users`, `sessions`, `user_tokens`, `plans` and
 * the outbox. They are not tenant-owned - they belong to the auth layer, to the
 * platform, or to the data plane - and pretending otherwise by inventing a
 * scope for them would be worse than leaving them out.
 */
export class TenantScope implements OwnershipVerifier {
  constructor(
    private readonly client: TenantClient,
    readonly context: RequestContext,
  ) {}

  /** The same scope bound to a transaction client. Use inside `$transaction`. */
  withClient(client: TenantClient): TenantScope {
    return new TenantScope(client, this.context);
  }

  get organizationId(): string {
    return this.context.organization.id;
  }

  /** Throws a loud programming error on a route that resolved no project. */
  get projectId(): string {
    return this.context.requireProject().id;
  }

  /**
   * Resolve a sibling repository by name, so one repository can prove a
   * caller-supplied foreign key belongs to this tenant before writing it.
   * Part of `OwnershipVerifier`; not meant to be called by module authors.
   */
  repositoryFor(name: string): OwnedRepository {
    const candidate = (this as unknown as Record<string, unknown>)[name];
    if (
      !candidate ||
      typeof (candidate as OwnedRepository).requireById !== 'function'
    ) {
      throw new AppError(
        'internal_error',
        `TenantScope has no repository named '${name}'; fix the foreignKeys map in tenant-scope.factory.ts.`,
      );
    }
    return candidate as OwnedRepository;
  }

  // --- the organization itself --------------------------------------------

  /**
   * The caller's own organization row, and only ever that one: the predicate is
   * `{ id: <resolved org> }`, so `findMany` returns exactly one row and
   * `findById(<another org>)` is a 404 like everything else.
   */
  get organization(): Repo<
    Prisma.OrganizationWhereInput,
    Prisma.OrganizationOrderByWithRelationInput,
    Prisma.OrganizationCreateManyInput,
    Prisma.OrganizationUncheckedUpdateManyInput,
    Organization
  > {
    return this.repo('organization', 'organizationSelf', 'Organization');
  }

  // --- organization-scoped ------------------------------------------------

  get projects(): Repo<
    Prisma.ProjectWhereInput,
    Prisma.ProjectOrderByWithRelationInput,
    Prisma.ProjectCreateManyInput,
    Prisma.ProjectUncheckedUpdateManyInput,
    Project
  > {
    return this.repo('project', 'organization', 'Project');
  }

  get members(): Repo<
    Prisma.OrganizationMemberWhereInput,
    Prisma.OrganizationMemberOrderByWithRelationInput,
    Prisma.OrganizationMemberCreateManyInput,
    Prisma.OrganizationMemberUncheckedUpdateManyInput,
    OrganizationMember
  > {
    return this.repo('organizationMember', 'organization', 'Member');
  }

  get auditLogs(): Repo<
    Prisma.AuditLogWhereInput,
    Prisma.AuditLogOrderByWithRelationInput,
    Prisma.AuditLogCreateManyInput,
    Prisma.AuditLogUncheckedUpdateManyInput,
    AuditLog
  > {
    return this.repo('auditLog', 'organization', 'Audit log entry');
  }

  get usageRecords(): Repo<
    Prisma.UsageRecordWhereInput,
    Prisma.UsageRecordOrderByWithRelationInput,
    Prisma.UsageRecordCreateManyInput,
    Prisma.UsageRecordUncheckedUpdateManyInput,
    UsageRecord
  > {
    // Organization-scoped even when a project is resolved: org-level rollups
    // carry `project_id NULL`, and a `{ projectId }` predicate would silently
    // drop exactly the rows billing is computed from.
    return this.repo('usageRecord', 'organization', 'Usage record');
  }

  get billingSubscriptions(): Repo<
    Prisma.BillingSubscriptionWhereInput,
    Prisma.BillingSubscriptionOrderByWithRelationInput,
    Prisma.BillingSubscriptionCreateManyInput,
    Prisma.BillingSubscriptionUncheckedUpdateManyInput,
    BillingSubscription
  > {
    return this.repo('billingSubscription', 'organization', 'Billing subscription');
  }

  // --- project-scoped -----------------------------------------------------

  get endpoints(): Repo<
    Prisma.EndpointWhereInput,
    Prisma.EndpointOrderByWithRelationInput,
    Prisma.EndpointCreateManyInput,
    Prisma.EndpointUncheckedUpdateManyInput,
    Endpoint
  > {
    return this.repo('endpoint', 'project', 'Endpoint', {
      foreignKeys: { retryPolicyId: 'retryPolicies' },
    });
  }

  get apiKeys(): Repo<
    Prisma.ApiKeyWhereInput,
    Prisma.ApiKeyOrderByWithRelationInput,
    Prisma.ApiKeyCreateManyInput,
    Prisma.ApiKeyUncheckedUpdateManyInput,
    ApiKey
  > {
    return this.repo('apiKey', 'project', 'API key');
  }

  get subscriptions(): Repo<
    Prisma.WebhookSubscriptionWhereInput,
    Prisma.WebhookSubscriptionOrderByWithRelationInput,
    Prisma.WebhookSubscriptionCreateManyInput,
    Prisma.WebhookSubscriptionUncheckedUpdateManyInput,
    WebhookSubscription
  > {
    // `endpointId` is required and caller-supplied. Without the ownership check
    // a subscription could be stamped with this project and pointed at another
    // tenant's endpoint - or, worse, at an attacker's URL from inside the
    // victim's project - through the "safe" API.
    return this.repo('webhookSubscription', 'project', 'Subscription', {
      foreignKeys: { endpointId: 'endpoints' },
    });
  }

  get retryPolicies(): Repo<
    Prisma.RetryPolicyWhereInput,
    Prisma.RetryPolicyOrderByWithRelationInput,
    Prisma.RetryPolicyCreateManyInput,
    Prisma.RetryPolicyUncheckedUpdateManyInput,
    RetryPolicy
  > {
    return this.repo('retryPolicy', 'project', 'Retry policy');
  }

  get rateLimitPolicies(): Repo<
    Prisma.RateLimitPolicyWhereInput,
    Prisma.RateLimitPolicyOrderByWithRelationInput,
    Prisma.RateLimitPolicyCreateManyInput,
    Prisma.RateLimitPolicyUncheckedUpdateManyInput,
    RateLimitPolicy
  > {
    return this.repo('rateLimitPolicy', 'project', 'Rate limit policy');
  }

  get idempotencyKeys(): Repo<
    Prisma.IdempotencyKeyWhereInput,
    Prisma.IdempotencyKeyOrderByWithRelationInput,
    Prisma.IdempotencyKeyCreateManyInput,
    Prisma.IdempotencyKeyUncheckedUpdateManyInput,
    IdempotencyKey
  > {
    return this.repo('idempotencyKey', 'project', 'Idempotency key', {
      foreignKeys: { eventId: 'events' },
    });
  }

  // --- both columns -------------------------------------------------------

  get events(): Repo<
    Prisma.EventWhereInput,
    Prisma.EventOrderByWithRelationInput,
    Prisma.EventCreateManyInput,
    Prisma.EventUncheckedUpdateManyInput,
    Event
  > {
    return this.repo('event', 'projectAndOrganization', 'Event');
  }

  /**
   * Scoped through `delivery -> endpoint -> project`, with the denormalised
   * columns ANDed on for index selectivity. See `TenantScopeKind`.
   */
  get deliveries(): Repo<
    Prisma.DeliveryWhereInput,
    Prisma.DeliveryOrderByWithRelationInput,
    Prisma.DeliveryCreateManyInput,
    Prisma.DeliveryUncheckedUpdateManyInput,
    Delivery
  > {
    return this.repo('delivery', 'delivery', 'Delivery', {
      foreignKeys: {
        eventId: 'events',
        endpointId: 'endpoints',
        subscriptionId: 'subscriptions',
        replayOfDeliveryId: 'deliveries',
      },
    });
  }

  // --- reached through a parent ------------------------------------------

  get endpointSecrets(): Repo<
    Prisma.EndpointSecretWhereInput,
    Prisma.EndpointSecretOrderByWithRelationInput,
    Prisma.EndpointSecretCreateManyInput,
    Prisma.EndpointSecretUncheckedUpdateManyInput,
    EndpointSecret
  > {
    // endpoint_secrets -> endpoints -> projects -> organizations, expressed as a
    // relation filter so the join happens in PostgreSQL and there is no window
    // in which an unscoped row exists in application memory.
    return this.repo('endpointSecret', 'viaEndpoint', 'Endpoint secret', {
      foreignKeys: { endpointId: 'endpoints' },
    });
  }

  /**
   * Circuit-breaker state, keyed by `endpoint_id` rather than `id`. Read by the
   * operator UI; the data plane owns the writes.
   */
  get endpointHealth(): Repo<
    Prisma.EndpointHealthWhereInput,
    Prisma.EndpointHealthOrderByWithRelationInput,
    Prisma.EndpointHealthCreateManyInput,
    Prisma.EndpointHealthUncheckedUpdateManyInput,
    EndpointHealth
  > {
    return this.repo('endpointHealth', 'viaEndpoint', 'Endpoint health', {
      idField: 'endpointId',
      foreignKeys: { endpointId: 'endpoints' },
    });
  }

  get deliveryAttempts(): Repo<
    Prisma.DeliveryAttemptWhereInput,
    Prisma.DeliveryAttemptOrderByWithRelationInput,
    Prisma.DeliveryAttemptCreateManyInput,
    Prisma.DeliveryAttemptUncheckedUpdateManyInput,
    DeliveryAttempt
  > {
    return this.repo('deliveryAttempt', 'viaDelivery', 'Delivery attempt', {
      foreignKeys: { deliveryId: 'deliveries' },
    });
  }

  /**
   * The one type assertion in this layer.
   *
   * Prisma's generated delegates are heavily overloaded on `select`/`include`
   * generics, which does not structurally match the deliberately small
   * `ModelDelegate` surface. Narrowing here - once, at construction, with the
   * model's own `*WhereInput`/`*CreateManyInput` types named at the call site -
   * keeps every caller of `ScopedRepository` fully typed.
   *
   * `*CreateManyInput`/`*UncheckedUpdateManyInput` rather than
   * `*UncheckedCreateInput`/`*UncheckedUpdateInput`: those are Prisma's
   * scalars-only inputs, so a nested relation write
   * (`{ secrets: { connect: [{ id }] } }` - a bare unique key with no tenant
   * filter) does not typecheck. `create` only ever does flat inserts, so this
   * costs nothing.
   */
  private repo<
    TWhere,
    TOrderBy,
    TCreate extends object,
    TUpdate extends object,
    TRecord extends object,
  >(
    key: DelegateKey,
    kind: TenantScopeKind,
    resourceName: string,
    options?: { idField?: string; foreignKeys?: ForeignKeys },
  ): Repo<TWhere, TOrderBy, TCreate, TUpdate, TRecord> {
    return new ScopedRepository<TWhere, TOrderBy, TCreate, TUpdate, TRecord>({
      delegate: this.delegateFor<TWhere, TOrderBy, TCreate, TUpdate, TRecord>(this.client, key),
      kind,
      context: this.context,
      resourceName,
      // Prisma's client property names are the model name, camel-cased.
      model: key.charAt(0).toUpperCase() + key.slice(1),
      idField: options?.idField,
      foreignKeys: options?.foreignKeys,
      owner: this,
      transaction: this.transactionRunner<TWhere, TOrderBy, TCreate, TUpdate, TRecord>(key),
    });
  }

  private delegateFor<TWhere, TOrderBy, TCreate, TUpdate, TRecord>(
    client: TenantClient,
    key: DelegateKey,
  ): ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord> {
    return (client as unknown as Record<string, unknown>)[key] as ModelDelegate<
      TWhere,
      TOrderBy,
      TCreate,
      TUpdate,
      TRecord
    >;
  }

  /**
   * Runs a repository's read-after-write pair inside one transaction, against a
   * delegate bound to the transaction client - binding matters, or the second
   * statement would run outside it and see a different snapshot.
   *
   * Undefined when this scope is already inside a transaction
   * (`Prisma.TransactionClient` has no `$transaction`), which is the correct
   * answer: the caller's transaction is the atomic unit.
   */
  private transactionRunner<TWhere, TOrderBy, TCreate, TUpdate, TRecord>(
    key: DelegateKey,
  ): TransactionRunner<TWhere, TOrderBy, TCreate, TUpdate, TRecord> | undefined {
    const client = this.client as Partial<PrismaService>;
    if (typeof client.$transaction !== 'function') return undefined;
    const root = this.client as PrismaService;
    return <T>(
      run: (delegate: ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord>) => Promise<T>,
    ): Promise<T> =>
      root.$transaction((tx) =>
        run(this.delegateFor<TWhere, TOrderBy, TCreate, TUpdate, TRecord>(tx, key)),
      );
  }
}

/**
 * Builds a `TenantScope` for a request.
 *
 * Not request-scoped DI: a `Scope.REQUEST` provider makes every consumer
 * request-scoped too, which costs an instantiation of the whole injection
 * subtree per request and is a well-known Nest performance trap. Passing the
 * `RequestContext` explicitly is one extra argument, keeps services trivially
 * unit-testable, and makes it obvious in a signature which methods are
 * tenant-aware.
 */
@Injectable()
export class TenantScopeFactory {
  constructor(private readonly prisma: PrismaService) {}

  for(context: RequestContext, client?: TenantClient): TenantScope {
    return new TenantScope(client ?? this.prisma, context);
  }
}
