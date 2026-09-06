import { useParams } from 'react-router-dom';
import { Async, PageHeader, Panel, Stat } from '../../components';
import { formatCount, formatTimestamp } from '../../lib/format';
import { useUsage } from '../organizations/api';

export function UsagePage() {
  const { orgId = '' } = useParams();
  const usage = useUsage(orgId);

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
