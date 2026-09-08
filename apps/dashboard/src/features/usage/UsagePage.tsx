import { useParams } from 'react-router-dom';
import { Async, NoBackendRoute, PageHeader, Panel, Stat } from '../../components';
import { usingMockApi } from '../../lib/api';
import { formatCount, formatTimestamp } from '../../lib/format';
import { useUsage } from '../organizations/api';

/**
 * `GET /v1/organizations/:orgId/usage` IS NOT IN THE OPENAPI DOCUMENT. There is
 * no usage or billing module, so under the real transport this page states that
 * rather than rendering a 404 as an error — or, far worse, showing an operator
 * a plausible overage figure that was fabricated by a mock.
 */
export function UsagePage() {
  const { orgId = '' } = useParams();
  const usage = useUsage(orgId);

  if (!usingMockApi) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Usage"
          description="Metered on events ingested, not deliveries attempted."
        />
        <Panel>
          <NoBackendRoute
            title="Usage"
            path="GET /v1/organizations/:orgId/usage"
            purpose="It would need a billing period plus counts of events ingested and delivery attempts made inside it — an aggregate, not something a paged list can answer."
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Usage" description="Metered on events ingested, not deliveries attempted." />
      <Async query={usage}>
        {(data) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Events ingested"
                value={formatCount(data.events_ingested)}
                hint={`${formatCount(data.included_events)} included in plan`}
              />
              <Stat
                label="Overage"
                value={formatCount(data.overage_events)}
                tone={data.overage_events > 0 ? 'warn' : 'default'}
                hint="Billed at the end of the period"
              />
              <Stat
                label="Deliveries attempted"
                value={formatCount(data.deliveries_attempted)}
                hint="Includes retries"
              />
              <Stat
                label="Fan-out ratio"
                value={`${(data.deliveries_attempted / data.events_ingested).toFixed(2)}×`}
                hint="Deliveries per event"
              />
            </div>
            <Panel title="Billing period">
              <p className="text-xs text-ink-muted">
                {formatTimestamp(data.period_start)} — {formatTimestamp(data.period_end)}
              </p>
            </Panel>
          </>
        )}
      </Async>
    </div>
  );
}
