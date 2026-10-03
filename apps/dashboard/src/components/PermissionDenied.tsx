import { ApiRequestError } from '../lib/api';
import { EmptyState } from './EmptyState';
import type { Role } from '../types/api';

/**
 * A 403, answered properly.
 *
 * "You do not have permission" is the least useful sentence in an operator
 * surface: it does not say what permission, who has it, or what to do. Three
 * facts turn it into something actionable, and all three are available:
 *
 *   1. WHICH ROLE is required for this action.
 *   2. WHAT ROLE THE CALLER HAS — `Organization.role` on the session is the
 *      caller's own role, so this is real rather than guessed.
 *   3. THE REQUEST ID, because the first thing a support thread asks for is the
 *      identifier that appears on every log line for the failed request.
 *
 * The remedy is always the same and is always stated: ask an owner or admin of
 * this organization, since roles are granted per organization on the Team page.
 */

const ROLE_ORDER: Role[] = ['viewer', 'billing', 'developer', 'admin', 'owner'];

export interface PermissionDeniedProps {
  /** What the caller was trying to do, in the infinitive: "create an API key". */
  action: string;
  /** Roles that would be allowed. Ordered least to most privileged for display. */
  requiredRoles: Role[];
  /** The caller's role in this organization, when it is known. */
  currentRole?: Role;
  /** The originating error, for its `request_id`. */
  error?: unknown;
  className?: string;
}

export function PermissionDenied({
  action,
  requiredRoles,
  currentRole,
  error,
  className,
}: PermissionDeniedProps) {
  const requestId = error instanceof ApiRequestError ? error.body.request_id : undefined;
  const allowed = [...requiredRoles].sort(
    (a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b),
  );

  return (
    <EmptyState
      tone="error"
      title={`You cannot ${action}`}
      className={className}
      description={
        <span className="flex flex-col items-center gap-2">
          <span>
            This needs the {formatRoles(allowed)} role
            {allowed.length > 1 ? 's' : ''}.
            {currentRole && (
              <>
                {' '}
                You are {article(currentRole)}{' '}
                <strong className="font-semibold text-ink">{currentRole}</strong> in this
                organization.
              </>
            )}
          </span>
          <span>
            Roles are granted per organization. Ask an owner or admin to change yours on the Team
            page.
          </span>
          {requestId && (
            <span className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-2xs text-ink-subtle">
              request_id: {requestId}
            </span>
          )}
        </span>
      }
    />
  );
}

/** "admin or owner" — a list a person reads, not `["admin","owner"]`. */
function formatRoles(roles: Role[]): string {
  if (roles.length === 0) return 'a higher';
  if (roles.length === 1) return roles[0];
  return `${roles.slice(0, -1).join(', ')} or ${roles[roles.length - 1]}`;
}

function article(role: Role): string {
  return /^[aeiou]/i.test(role) ? 'an' : 'a';
}
