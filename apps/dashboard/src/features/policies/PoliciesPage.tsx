import { useParams, useSearchParams } from 'react-router-dom';
import { PageHeader, Tabs } from '../../components';
import type { Organization } from '../../types/api';
import { useOrganizations } from '../organizations/api';
import { RateLimitsTab } from '../rate-limits/RateLimitsTab';
import { RetryPoliciesTab } from '../retry-policies/RetryPoliciesTab';
import { policyWriteGate } from './permissions';

/**
 * Policies — the two project-level policy tables behind one nav item.
 *
 * Retry policies and rate limits are different objects with different rules,
 * and the reason they share a page rather than two nav entries is what they
 * have in common: both are "configuration a developer is expected to tune"
 * (`policies.read` / `policies.write` in the permission matrix), both were
 * listed under "Not built yet" on project settings while their routes sat
 * mounted and unwired, and an operator looking for either says "policies".
 *
 * The active tab is in the URL (`?tab=rate-limits`) so a link from project
 * settings or an incident channel lands on the right table.
 */
const TABS = [
  { value: 'retry', label: 'Retry policies' },
  { value: 'rate-limits', label: 'Rate limits' },
] as const;

type Tab = (typeof TABS)[number]['value'];

function readTab(raw: string | null): Tab {
  return TABS.some((tab) => tab.value === raw) ? (raw as Tab) : 'retry';
}

export function PoliciesPage() {
  const { orgId = '', projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readTab(searchParams.get('tab'));

  // Only for the gate and the denial copy — the caller's real role in THIS
  // organization. A failure here leaves the gate `unknown`, which means the
  // buttons stay enabled and the server answers; it never blocks the page.
  const organizations = useOrganizations();
  const organization: Organization | undefined = organizations.data?.rows.find(
    (row) => row.id === orgId,
  );
  const gate = policyWriteGate(organization);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Policies"
        description="How this project’s deliveries are retried, and how fast its events are accepted. Both are project configuration: a viewer can read them, a developer can change them."
      />

      <Tabs
        aria-label="Policy kind"
        items={[...TABS]}
        value={tab}
        onChange={(value) =>
          setSearchParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              if (value === 'retry') next.delete('tab');
              else next.set('tab', value);
              return next;
            },
            { replace: true },
          )
        }
      >
        {tab === 'retry' ? (
          <RetryPoliciesTab projectId={projectId} gate={gate} currentRole={organization?.role} />
        ) : (
          <RateLimitsTab projectId={projectId} gate={gate} currentRole={organization?.role} />
        )}
      </Tabs>
    </div>
  );
}
