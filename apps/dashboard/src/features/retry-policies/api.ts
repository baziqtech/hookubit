import { useQuery } from '@tanstack/react-query';
import { api, queryString } from '../../lib/api';
import { offsetPage, pageParams } from '../../lib/pagination';
import { queryKeys } from '../../lib/query-keys';
import type { OffsetPage, RetryPolicy } from '../../types/api';

/**
 * `GET /v1/projects/:projectId/retry-policies`.
 *
 * SCOPED TO THE PROJECT, and that is the reason this hook exists at all. The
 * endpoint edit form took `retry_policy_id` as free text, so an id copied from
 * another project — the obvious thing to do when two projects should retry the
 * same way — answers 404 through the tenant scope, and the operator reads that
 * as "the platform lost my policy" rather than "that id is not addressable
 * here". A list the project actually owns is the only honest input.
 */
export function useRetryPolicies(projectId: string, offset = 0) {
  return useQuery({
    queryKey: queryKeys.retryPolicies(projectId, offset),
    queryFn: async () =>
      offsetPage(
        await api.get<OffsetPage<RetryPolicy>>(
          `/v1/projects/${projectId}/retry-policies${queryString(pageParams(offset))}`,
        ),
      ),
    enabled: Boolean(projectId),
  });
}

/**
 * "Up to 8 attempts, exponential from 1s" — the summary a picker needs.
 *
 * The delay figures are shown in seconds because the operator is reasoning
 * about how long a broken consumer stays broken, not about milliseconds, and
 * `max_attempts` leads because it is the number that decides whether a delivery
 * ends `exhausted` inside the incident or after it.
 */
export function describeRetryPolicy(policy: RetryPolicy): string {
  const attempts = `${policy.max_attempts} attempt${policy.max_attempts === 1 ? '' : 's'}`;
  const initial = formatMs(policy.initial_delay_ms);
  const max = formatMs(policy.max_delay_ms);
  switch (policy.strategy) {
    case 'exponential':
      return `${attempts}, exponential ×${policy.multiplier} from ${initial} up to ${max}`;
    case 'linear':
      return `${attempts}, linear +${initial} up to ${max}`;
    case 'constant':
      return `${attempts}, every ${initial}`;
  }
}

function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds < 90) return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Number(minutes.toFixed(minutes < 10 ? 1 : 0))}m`;
  return `${Number((minutes / 60).toFixed(1))}h`;
}
