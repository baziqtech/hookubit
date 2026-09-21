import { Injectable, Logger } from '@nestjs/common';
import { EndpointStatus, Prisma } from '@prisma/client';
import { RequestContext, ResolvedProject, TenantScope, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';

/** What a copy actually produced, so the UI can say so rather than guess. */
export interface TemplateResult {
  endpoints: number;
  subscriptions: number;
  retry_policies: number;
  /** Always 0. Present so the response can say so out loud. */
  signing_secrets: number;
}

/** A ceiling on what one copy will move, so this cannot become a bulk import. */
const MAX_COPIED = 100;

/**
 * Starting a project from an existing one.
 *
 * ## What is copied, and what is NEVER copied
 *
 * Copied: endpoints with their timeouts, concurrency, rate limits and custom
 * headers; retry policies; subscriptions.
 *
 * Never copied: signing secrets, API keys, the delivery record, notification
 * destinations. The rule is one sentence and it is the reason this feature is
 * safe to offer at all — a leak in one project stays in one project. A copied
 * secret would mean two projects a single stolen value can forge requests for,
 * and the customer would have no idea the second one existed.
 *
 * ## Why every copied endpoint arrives PAUSED
 *
 * Because the URL it points at is the source project's URL, and the source
 * project is very often the test one. An endpoint that arrived live would
 * start delivering real traffic to a staging server the moment the first event
 * was published — before anybody had looked at the list.
 *
 * It arrives with no signing secret either, which means `POST …/enable`
 * refuses it until somebody issues one. Two independent reasons it cannot
 * send, and that is deliberate: the operator has to act twice, and both acts
 * are things they would have had to do anyway.
 *
 * ## Why the copy is not transactional with the create
 *
 * A project that exists with nothing in it is a recoverable state — the
 * operator can copy again, or start from empty. A create that rolls back
 * because one subscription referenced a deleted endpoint would lose the
 * project and tell them nothing about why. So the copy is best-effort per
 * resource, and the result says what actually landed.
 */
@Injectable()
export class ProjectTemplateService {
  private readonly logger = new Logger(ProjectTemplateService.name);

  constructor(private readonly scopes: TenantScopeFactory) {}

  /**
   * Copy the configuration of `sourceProjectId` into `targetProjectId`.
   *
   * The source is read through the CALLER'S scope, so a project in another
   * organization is a 404 rather than a copy. That check is the whole tenancy
   * story here: the target was just created inside the same context.
   */
  async copy(
    context: RequestContext,
    sourceProjectId: string,
    targetProjectId: string,
  ): Promise<TemplateResult> {
    const scope = this.scopes.for(context);

    /*
     * `projects` is ORGANIZATION-scoped, so this read is the tenancy check: a
     * source in another organization is simply not found, and answers the same
     * way a typo does.
     */
    const source = await scope.projects.findById(sourceProjectId);
    if (!source) {
      throw new AppError(
        'invalid_request',
        'The project to copy from does not exist, or belongs to another organization.',
      );
    }
    if (source.id === targetProjectId) {
      throw new AppError('invalid_request', 'A project cannot be copied from itself.');
    }

    /*
     * TWO SCOPES, and this is the part that is easy to get silently wrong.
     *
     * `endpoints`, `subscriptions` and `retryPolicies` are PROJECT-scoped, and
     * the project they are scoped to comes from the request context — which is
     * the TARGET, because that is the project this request created. Reading the
     * source through that scope ANDs `projectId = target` with
     * `projectId = source`, which matches nothing at all: the copy silently
     * produces an empty project and reports success.
     *
     * So the source is read through a context pinned to the source project.
     * That is safe precisely because of the read above — the source has already
     * been proved to be inside this caller's organization, through a scope they
     * did not choose — and it is built here rather than passed in so no caller
     * can hand this method a context for a tenant they do not belong to.
     */
    const resolvedSource: ResolvedProject = {
      id: source.id,
      organizationId: source.organizationId,
      name: source.name,
      slug: source.slug,
      environment: source.environment,
      status: source.status,
    };
    const sourceContext: RequestContext = {
      ...context,
      project: resolvedSource,
      has: (permission) => context.has(permission),
      requireProject: () => resolvedSource,
    };
    const from = this.scopes.for(sourceContext);

    const policies = await this.copyRetryPolicies(from, scope, source.id);
    const endpoints = await this.copyEndpoints(from, scope, source.id, policies);
    const subscriptions = await this.copySubscriptions(from, scope, source.id, endpoints);

    return {
      endpoints: endpoints.size,
      subscriptions,
      retry_policies: policies.size,
      // Stated, not omitted. "0 signing secrets" is the sentence that explains
      // why nothing is delivering yet.
      signing_secrets: 0,
    };
  }

  /** Source policy id → new policy id. */
  /*
   * `targetProjectId` is deliberately absent from every create payload below.
   *
   * `ScopedRepository.create` REFUSES a tenant column in the payload and sets
   * it from the scope instead — a row cannot be moved between tenants by what
   * a caller writes. `into` is the target's scope, so the target id is already
   * where it needs to be, and supplying it would be an error rather than a
   * belt-and-braces.
   */
  private async copyRetryPolicies(
    from: TenantScope,
    into: TenantScope,
    sourceProjectId: string,
  ): Promise<Map<string, string>> {
    const page = await from.retryPolicies.findPage({
      where: { projectId: sourceProjectId } satisfies Prisma.RetryPolicyWhereInput,
      take: MAX_COPIED,
    });

    const mapping = new Map<string, string>();
    for (const policy of page.rows) {
      const id = newId('retryPolicy');
      await into.retryPolicies.create({
        id,
        name: policy.name,
        isDefault: policy.isDefault,
        strategy: policy.strategy,
        maxAttempts: policy.maxAttempts,
        initialDelayMs: policy.initialDelayMs,
        maxDelayMs: policy.maxDelayMs,
        multiplier: policy.multiplier,
        jitterRatio: policy.jitterRatio,
        maxRetryDurationMs: policy.maxRetryDurationMs,
      } as never);
      mapping.set(policy.id, id);
    }
    return mapping;
  }

  /** Source endpoint id → new endpoint id. */
  private async copyEndpoints(
    from: TenantScope,
    into: TenantScope,
    sourceProjectId: string,
    policies: Map<string, string>,
  ): Promise<Map<string, string>> {
    const page = await from.endpoints.findPage({
      where: {
        projectId: sourceProjectId,
        // A deleted endpoint is kept so the ledger stays readable. Copying one
        // would create a live row from a row the operator already removed.
        status: { not: EndpointStatus.deleted },
      } satisfies Prisma.EndpointWhereInput,
      take: MAX_COPIED,
    });

    const mapping = new Map<string, string>();
    for (const endpoint of page.rows) {
      const id = newId('endpoint');
      await into.endpoints.create({
        id,
        name: endpoint.name,
        url: endpoint.url,
        description: endpoint.description,
        // PAUSED, and with no secret. Two independent reasons it cannot send.
        status: EndpointStatus.paused,
        enabled: false,
        disabledReason:
          'Copied from another project. Check the URL, issue a signing secret, then resume it.',
        timeoutMs: endpoint.timeoutMs,
        maxConcurrency: endpoint.maxConcurrency,
        rateLimit: endpoint.rateLimit,
        rateLimitWindowSeconds: endpoint.rateLimitWindowSeconds,
        // Remapped, never carried across: the source id names a policy in the
        // source project, and a delivery pointing at another project's policy
        // is a tenancy hole.
        retryPolicyId: endpoint.retryPolicyId ? (policies.get(endpoint.retryPolicyId) ?? null) : null,
        customHeaders: endpoint.customHeaders ?? undefined,
      } as never);
      mapping.set(endpoint.id, id);
    }
    return mapping;
  }

  private async copySubscriptions(
    from: TenantScope,
    into: TenantScope,
    sourceProjectId: string,
    endpoints: Map<string, string>,
  ): Promise<number> {
    const page = await from.subscriptions.findPage({
      where: { projectId: sourceProjectId } satisfies Prisma.WebhookSubscriptionWhereInput,
      take: MAX_COPIED,
    });

    let copied = 0;
    for (const subscription of page.rows) {
      const endpointId = endpoints.get(subscription.endpointId);
      // A subscription whose endpoint was not copied has nowhere to point. It
      // is skipped rather than pointed at the source project's endpoint, which
      // would deliver this project's events into another project's consumer.
      if (!endpointId) {
        this.logger.warn(
          `Skipped subscription ${subscription.id}: its endpoint was not among the copied ones.`,
        );
        continue;
      }
      await into.subscriptions.create({
        id: newId('subscription'),
        name: subscription.name,
        eventTypes: subscription.eventTypes,
        payloadFilter: subscription.payloadFilter ?? undefined,
        enabled: subscription.enabled,
        endpointId,
      } as never);
      copied += 1;
    }
    return copied;
  }
}
