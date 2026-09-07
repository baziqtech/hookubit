import { RateLimitScope } from '@prisma/client';
import { CROSS_TENANT_MESSAGE, RequestContext, TenantScope } from '../authz';
import { AppError } from '../common/errors';

/**
 * `resource_id` is a caller-supplied foreign key whose TARGET TABLE depends on
 * `scope`. That is why it is not in the repository's `foreignKeys` map (which
 * is column -> one repository, resolved automatically): there is no single
 * repository that owns it. It is resolved here instead, through the scoped
 * repository for whatever the scope names, and nothing else in the module is
 * allowed to write the column without going through this function.
 *
 * A rate limit pointing at another tenant's endpoint is a cross-tenant write:
 * the row would be stamped with the caller's `project_id` — so it passes every
 * read fence — while naming a resource inside someone else's project. What the
 * data plane would then do with it is worse than a leak in either direction:
 * it would either throttle a stranger's endpoint on this project's budget, or
 * silently never match anything and leave a limit the operator believes is in
 * force doing nothing.
 *
 * Every miss answers with `CROSS_TENANT_MESSAGE` — the one 404 string this
 * control plane uses — so "does not exist" and "belongs to someone else" are
 * indistinguishable.
 */
export async function resolveRateLimitResource(
  scope: TenantScope,
  context: RequestContext,
  rateLimitScope: RateLimitScope,
  resourceId: string | null,
): Promise<string | null> {
  // NULL is legal for every scope and means "every resource in this scope".
  // It is also the row the NULLS NOT DISTINCT index exists to keep unique —
  // see the note on `RateLimitsService.conflict`.
  if (resourceId === null) return null;

  switch (rateLimitScope) {
    case 'endpoint': {
      // Through the endpoints repository, so the tenant predicate is in the
      // WHERE clause and another tenant's endpoint matches zero rows in the
      // database rather than being fetched and then checked in memory.
      const endpoint = await scope.endpoints.findById(resourceId);
      if (!endpoint) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
      return endpoint.id;
    }

    case 'ingest': {
      // The ingest limiter's `Scope` (internal/ingest/limiter.go) carries
      // organization, project and API KEY, so a non-null resource_id at ingest
      // scope names an API key: a per-credential ceiling, which is what you
      // want when one integration's runaway retry loop must not consume the
      // project's whole ingest budget.
      const key = await scope.apiKeys.findById(resourceId);
      if (!key) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
      return key.id;
    }

    case 'project': {
      // Resolved through the projects repository first — which is
      // organization-scoped, so another tenant's project is a 404 — and then
      // narrowed to THIS project. A policy row lives in one project and cannot
      // meaningfully name a sibling: the data plane looks it up by the project
      // it is delivering for, so a row pointing at a sibling would never be
      // read by anything. That is a 400 rather than a 404, because the caller
      // is inside the tenant and can see the project they named.
      const project = await scope.projects.findById(resourceId);
      if (!project) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
      if (project.id !== context.requireProject().id) {
        throw new AppError(
          'invalid_request',
          'resource_id at project scope must be null or this project’s own id; a policy ' +
            'row stored in one project and pointing at another is never read by anything.',
          { field: 'resource_id' },
        );
      }
      return project.id;
    }

    case 'organization': {
      // The organization repository's predicate is `{ id: <resolved org> }`, so
      // any other organization id is a 404 by construction.
      const organization = await scope.organization.findById(resourceId);
      if (!organization) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
      return organization.id;
    }
  }
}

/**
 * Human-readable name of what a non-null `resource_id` points at, per scope.
 * Used in the conflict message so a 409 says which row already exists.
 */
export function resourceKindFor(scope: RateLimitScope): string {
  switch (scope) {
    case 'endpoint':
      return 'endpoint';
    case 'ingest':
      return 'API key';
    case 'project':
      return 'project';
    case 'organization':
      return 'organization';
  }
}
