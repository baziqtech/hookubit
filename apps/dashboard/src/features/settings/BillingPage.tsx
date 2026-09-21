import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Async, Badge, PageHeader, Panel } from '../../components';
import { api } from '../../lib/api';
import { formatCount, formatTimestamp } from '../../lib/format';
import { queryKeys } from '../../lib/query-keys';
import type { BillingSummary } from '../../types/api';

function useBilling(orgId: string) {
  return useQuery({
    queryKey: queryKeys.billing(orgId),
    queryFn: () => api.get<BillingSummary>(`/v1/organizations/${orgId}/billing`),
    enabled: Boolean(orgId),
  });
}

const METRIC_LABELS: Record<string, { label: string; detail: string }> = {
  events_ingested: {
    label: 'Events accepted',
    detail: 'Published to this organization and stored. Counted once, however many times we try.',
  },
  deliveries: {
    label: 'Deliveries created',
    detail: 'One per matching subscription per event. Retries are not counted again.',
  },
  replays: {
    label: 'Replays',
    detail: 'Deliveries created by replaying an earlier one.',
  },
};

/**
 * What this organization is using.
 *
 * ## What this page refuses to draw
 *
 * There is no payment provider, no invoice and no price in this system. The
 * response says so (`billable: false`) and the page prints a sentence rather
 * than an invoice table with a total of $0.00 — a fabricated invoice is worse
 * than no invoice, because somebody will believe it, and the somebody is
 * usually in finance.
 *
 * ## What is real
 *
 * The volume. It comes from hourly rollups rather than from counting the source
 * tables, which is also why the period ends at the last COMPLETE hour: the hour
 * in progress has not been rolled up, and labelling a number that stops at
 * 10:00 as covering 10:37 would hide exactly the traffic somebody opening this
 * page during an incident is looking for.
 */
export function BillingPage() {
  const { orgId = '' } = useParams();
  const billing = useBilling(orgId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Billing"
        description="What this organization is using, across every project in it."
      />

      <Async query={billing}>
        {(data) => (
          <>
            <Panel
              title="Plan"
              actions={
                data.status ? (
                  <Badge tone={data.status === 'active' ? 'ok' : 'warn'} dot>
                    {data.status}
                  </Badge>
                ) : (
                  <Badge tone="neutral">no plan</Badge>
                )
              }
            >
              {data.plan ? (
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  <Row label="Plan" value={data.plan.name} />
                  <Row label="Payload history" value={`${data.plan.retention_days} days`} />
                  <Row
                    label="Included events a month"
                    value={
                      data.plan.included_events_per_month
                        ? formatCount(Number(data.plan.included_events_per_month))
                        : 'unlimited'
                    }
                  />
                  <Row
                    label="Projects"
                    value={data.plan.max_projects ? String(data.plan.max_projects) : 'unlimited'}
                  />
                </dl>
              ) : (
                <p className="text-xs leading-relaxed text-ink-muted">
                  This organization is not on a plan. That is not a free tier and not an allowance
                  of zero — no plans are defined in this system yet, so there is nothing to be on.
                  Every limit you are subject to today is the platform default.
                </p>
              )}
            </Panel>

            <Panel
              title="This period so far"
              description={`${formatTimestamp(data.period_start)} — ${formatTimestamp(data.period_end)}`}
            >
              <dl className="flex flex-col gap-3">
                {data.usage.map((line) => {
                  const meta = METRIC_LABELS[line.metric] ?? {
                    label: line.metric,
                    detail: '',
                  };
                  return (
                    <div key={line.metric} className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <dt className="text-xs font-medium text-ink">{meta.label}</dt>
                        <dd className="text-2xs leading-relaxed text-ink-muted">{meta.detail}</dd>
                      </div>
                      <span className="shrink-0 text-sm font-semibold tabular text-ink">
                        {formatCount(Number(line.used))}
                      </span>
                    </div>
                  );
                })}
              </dl>

              <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">
                Counted from hourly rollups, so the period ends at the last complete hour rather
                than at this moment. Per-project figures are on{' '}
                <Link to={`/orgs/${orgId}/usage`} className="text-accent hover:underline">
                  Usage
                </Link>
                .
              </p>
            </Panel>

            {!data.billable && (
              <Panel title="Charges, invoices and payment">
                <p className="text-xs leading-relaxed text-ink-muted">
                  <strong className="font-semibold text-ink">
                    Nothing here is charged for, and there are no invoices.
                  </strong>{' '}
                  There is no payment provider connected to this system, no price attached to any
                  of the numbers above, and no invoice has ever been issued. The volume is real;
                  the bill does not exist. When it does, this page will show the same numbers with
                  prices beside them.
                </p>
              </Panel>
            )}
          </>
        )}
      </Async>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-2xs text-ink-subtle">{label}</dt>
      <dd className="text-xs text-ink">{value}</dd>
    </div>
  );
}
