import { Attributes, Span } from '@opentelemetry/api';
import { isCredentialKey } from '../authz/audit.service';
import type { TenantRequest } from '../authz/tenant-context';

/**
 * Tenant attributes, in our own namespace.
 *
 * `enduser.id` exists in the semantic conventions and is deliberately not used:
 * it is deprecated upstream and, more usefully, a `webhook.` prefix makes it
 * obvious in a trace backend which attributes this codebase is responsible for
 * and therefore which ones a review has to think about before adding.
 */
export const ATTR_WEBHOOK_ORGANIZATION_ID = 'webhook.organization_id';
export const ATTR_WEBHOOK_PROJECT_ID = 'webhook.project_id';
export const ATTR_WEBHOOK_MEMBER_ROLE = 'webhook.member_role';
export const ATTR_WEBHOOK_USER_ID = 'webhook.user_id';
export const ATTR_WEBHOOK_REQUEST_ID = 'webhook.request_id';

/**
 * An attribute value longer than this is truncated.
 *
 * Nothing we set is expected to approach it - ULIDs are 26 characters - so it
 * is a ceiling on the one attribute taken from a header (`user_agent.original`)
 * and on anything a future contributor adds without thinking about length.
 */
export const MAX_ATTRIBUTE_LENGTH = 256;

/**
 * The only way this codebase should put an attribute on a span.
 *
 * ## Why a guard and not just "don't set secrets"
 *
 * `audit.service.ts` already carries the long version of this argument: the
 * redaction there exists because someone eventually spreads a whole DTO into a
 * metadata bag, and a rule that lives in a reviewer's head is not a rule. Spans
 * are the same surface with a worse blast radius - they leave the process, go
 * to a collector, and are usually readable by more people than the audit table
 * is. So the same predicate decides both, and it decides on the KEY, because
 * that is the only thing available at the call site.
 *
 * This is a backstop, not a licence. The primary defence is that the set of
 * attributes written by this module is fixed, hand-written and small: no
 * request body, no header bag, no DTO, no endpoint URL (an endpoint URL can
 * carry a token in its query string), no route parameters. Nothing here loops
 * over caller-supplied keys.
 */
export function setSafeAttribute(span: Span, key: string, value: unknown): void {
  const safe = safeAttributeValue(key, value);
  if (safe === undefined) return;
  span.setAttribute(key, safe);
}

/** The value that would be set, or `undefined` if it must not be. */
export function safeAttributeValue(
  key: string,
  value: unknown,
): string | number | boolean | undefined {
  if (isCredentialKey(key)) return undefined;
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > MAX_ATTRIBUTE_LENGTH
    ? `${trimmed.slice(0, MAX_ATTRIBUTE_LENGTH - 1)}…`
    : trimmed;
}

/**
 * Tenant attributes for a request, or an empty object.
 *
 * ## The isolation rule, stated once
 *
 * These come from `req.tenantContext` and NEVER from route parameters. That is
 * the whole point. `TenantGuard` sets `tenantContext` only after the resolver
 * has proved the caller is a member of that organization, so every id here is
 * one the caller is already entitled to see. A cross-tenant request - the one
 * that gets the deliberately opaque `Resource not found.` - throws inside the
 * resolver and leaves `tenantContext` unset, so it produces no tenant
 * attributes at all.
 *
 * Reading `:projectId` off the path instead would have been one line shorter
 * and would have written the OTHER tenant's project id onto the span of a
 * refused request, undoing the indistinguishability the 404 exists to create -
 * in whatever backend receives the traces, for whoever can read it.
 */
export function tenantAttributes(req: TenantRequest): Attributes {
  const context = req.tenantContext;
  if (!context) return {};

  const attributes: Attributes = {};
  set(attributes, ATTR_WEBHOOK_ORGANIZATION_ID, context.organization.id);
  set(attributes, ATTR_WEBHOOK_PROJECT_ID, context.project?.id);
  set(attributes, ATTR_WEBHOOK_MEMBER_ROLE, context.role);
  set(attributes, ATTR_WEBHOOK_USER_ID, context.user.userId);
  return attributes;
}

function set(target: Attributes, key: string, value: unknown): void {
  const safe = safeAttributeValue(key, value);
  if (safe !== undefined) target[key] = safe;
}
