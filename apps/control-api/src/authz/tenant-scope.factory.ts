import { Injectable } from '@nestjs/common';
import {
  ApiKey,
  AuditLog,
  BillingSubscription,
  Delivery,
  DeliveryAttempt,
  Endpoint,
  EndpointSecret,
  Event,
  IdempotencyKey,
  OrganizationMember,
  Prisma,
  Project,
  RateLimitPolicy,
  RetryPolicy,
  UsageRecord,
  WebhookSubscription,
} from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RequestContext } from './tenant-context';
import { ModelDelegate, ScopedRepository, TenantScopeKind } from './tenant-scope';

/**
 * Anything that exposes Prisma's model delegates: the client itself, or the
 * transaction client handed to a `$transaction` callback. Passing the latter
 * keeps a multi-write operation atomic without losing tenant scoping.
 */
export type TenantClient = PrismaService | Prisma.TransactionClient;

type Repo<TWhere, TOrderBy, TCreate extends object, TUpdate, TRecord extends { id: string }> =
  ScopedRepository<TWhere, TOrderBy, TCreate, TUpdate, TRecord>;

/**
 * Every tenant-owned table, already fenced to the request's organization and
 * project.
 *
 * A Phase 2 service should inject `TenantScopeFactory` and nothing else from
 * the data layer. Injecting `PrismaService` directly is the unsafe path, and it
 * is meant to be conspicuous: it shows up in a constructor, in review, and in
 * `grep -r 'PrismaService' src/<module>`.
 *
 * Not covered here, on purpose: `users`, `sessions`, `user_tokens`, `plans` and
 * the outbox. They are not tenant-owned - they belong to the auth layer, to the
 * platform, or to the data plane - and pretending otherwise by inventing a
 * scope for them would be worse than leaving them out.
 */
export class TenantScope {
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

  // --- organization-scoped ------------------------------------------------

  get projects(): Repo<
    Prisma.ProjectWhereInput,
    Prisma.ProjectOrderByWithRelationInput,
    Prisma.ProjectUncheckedCreateInput,
    Prisma.ProjectUncheckedUpdateInput,
    Project
  > {
    return this.repo(this.client.project, 'organization', 'Project');
  }

  get members(): Repo<
    Prisma.OrganizationMemberWhereInput,
    Prisma.OrganizationMemberOrderByWithRelationInput,
    Prisma.OrganizationMemberUncheckedCreateInput,
    Prisma.OrganizationMemberUncheckedUpdateInput,
    OrganizationMember
  > {
    return this.repo(this.client.organizationMember, 'organization', 'Member');
  }

  get auditLogs(): Repo<
    Prisma.AuditLogWhereInput,
    Prisma.AuditLogOrderByWithRelationInput,
    Prisma.AuditLogUncheckedCreateInput,
    Prisma.AuditLogUncheckedUpdateInput,
    AuditLog
  > {
    return this.repo(this.client.auditLog, 'organization', 'Audit log entry');
  }

  get usageRecords(): Repo<
    Prisma.UsageRecordWhereInput,
    Prisma.UsageRecordOrderByWithRelationInput,
    Prisma.UsageRecordUncheckedCreateInput,
    Prisma.UsageRecordUncheckedUpdateInput,
    UsageRecord
  > {
    // Organization-scoped even when a project is resolved: org-level rollups
    // carry `project_id NULL`, and a `{ projectId }` predicate would silently
    // drop exactly the rows billing is computed from.
    return this.repo(this.client.usageRecord, 'organization', 'Usage record');
  }

  get billingSubscriptions(): Repo<
    Prisma.BillingSubscriptionWhereInput,
    Prisma.BillingSubscriptionOrderByWithRelationInput,
    Prisma.BillingSubscriptionUncheckedCreateInput,
    Prisma.BillingSubscriptionUncheckedUpdateInput,
    BillingSubscription
  > {
    return this.repo(this.client.billingSubscription, 'organization', 'Billing subscription');
  }

  // --- project-scoped -----------------------------------------------------

  get endpoints(): Repo<
    Prisma.EndpointWhereInput,
    Prisma.EndpointOrderByWithRelationInput,
    Prisma.EndpointUncheckedCreateInput,
    Prisma.EndpointUncheckedUpdateInput,
    Endpoint
  > {
    return this.repo(this.client.endpoint, 'project', 'Endpoint');
  }

  get apiKeys(): Repo<
    Prisma.ApiKeyWhereInput,
    Prisma.ApiKeyOrderByWithRelationInput,
    Prisma.ApiKeyUncheckedCreateInput,
    Prisma.ApiKeyUncheckedUpdateInput,
    ApiKey
  > {
    return this.repo(this.client.apiKey, 'project', 'API key');
  }

  get subscriptions(): Repo<
    Prisma.WebhookSubscriptionWhereInput,
    Prisma.WebhookSubscriptionOrderByWithRelationInput,
    Prisma.WebhookSubscriptionUncheckedCreateInput,
    Prisma.WebhookSubscriptionUncheckedUpdateInput,
    WebhookSubscription
  > {
    return this.repo(this.client.webhookSubscription, 'project', 'Subscription');
  }

  get retryPolicies(): Repo<
    Prisma.RetryPolicyWhereInput,
    Prisma.RetryPolicyOrderByWithRelationInput,
    Prisma.RetryPolicyUncheckedCreateInput,
    Prisma.RetryPolicyUncheckedUpdateInput,
    RetryPolicy
  > {
    return this.repo(this.client.retryPolicy, 'project', 'Retry policy');
  }

  get rateLimitPolicies(): Repo<
    Prisma.RateLimitPolicyWhereInput,
    Prisma.RateLimitPolicyOrderByWithRelationInput,
    Prisma.RateLimitPolicyUncheckedCreateInput,
    Prisma.RateLimitPolicyUncheckedUpdateInput,
    RateLimitPolicy
  > {
    return this.repo(this.client.rateLimitPolicy, 'project', 'Rate limit policy');
  }

  get idempotencyKeys(): Repo<
    Prisma.IdempotencyKeyWhereInput,
    Prisma.IdempotencyKeyOrderByWithRelationInput,
    Prisma.IdempotencyKeyUncheckedCreateInput,
    Prisma.IdempotencyKeyUncheckedUpdateInput,
    IdempotencyKey
  > {
    return this.repo(this.client.idempotencyKey, 'project', 'Idempotency key');
  }

  // --- both columns -------------------------------------------------------

  get events(): Repo<
    Prisma.EventWhereInput,
    Prisma.EventOrderByWithRelationInput,
    Prisma.EventUncheckedCreateInput,
    Prisma.EventUncheckedUpdateInput,
    Event
  > {
    return this.repo(this.client.event, 'projectAndOrganization', 'Event');
  }

  get deliveries(): Repo<
    Prisma.DeliveryWhereInput,
    Prisma.DeliveryOrderByWithRelationInput,
    Prisma.DeliveryUncheckedCreateInput,
    Prisma.DeliveryUncheckedUpdateInput,
    Delivery
  > {
    return this.repo(this.client.delivery, 'projectAndOrganization', 'Delivery');
  }

  // --- reached through a parent ------------------------------------------

  get endpointSecrets(): Repo<
    Prisma.EndpointSecretWhereInput,
    Prisma.EndpointSecretOrderByWithRelationInput,
    Prisma.EndpointSecretUncheckedCreateInput,
    Prisma.EndpointSecretUncheckedUpdateInput,
    EndpointSecret
  > {
    // endpoint_secrets -> endpoints -> projects -> organizations, expressed as a
    // relation filter so the join happens in PostgreSQL and there is no window
    // in which an unscoped row exists in application memory.
    return this.repo(this.client.endpointSecret, 'viaEndpoint', 'Endpoint secret');
  }

  get deliveryAttempts(): Repo<
    Prisma.DeliveryAttemptWhereInput,
    Prisma.DeliveryAttemptOrderByWithRelationInput,
    Prisma.DeliveryAttemptUncheckedCreateInput,
    Prisma.DeliveryAttemptUncheckedUpdateInput,
    DeliveryAttempt
  > {
    return this.repo(this.client.deliveryAttempt, 'viaDelivery', 'Delivery attempt');
  }

  /**
   * The one type assertion in this layer.
   *
   * Prisma's generated delegates are heavily overloaded on `select`/`include`
   * generics, which does not structurally match the deliberately small
   * `ModelDelegate` surface. Narrowing here - once, at construction, with the
   * model's own `*WhereInput`/`*CreateInput` types named at the call site -
   * keeps every caller of `ScopedRepository` fully typed.
   */
  private repo<TWhere, TOrderBy, TCreate extends object, TUpdate, TRecord extends { id: string }>(
    delegate: unknown,
    kind: TenantScopeKind,
    resourceName: string,
  ): Repo<TWhere, TOrderBy, TCreate, TUpdate, TRecord> {
    return new ScopedRepository(
      delegate as ModelDelegate<TWhere, TOrderBy, TCreate, TUpdate, TRecord>,
      kind,
      this.context,
      resourceName,
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
