import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  Button,
  DeliveryStatusBadge,
  EmptyState,
  PageHeader,
  Panel,
  Table,
  type Column,
} from '../../components';
import { cn } from '../../lib/cn';
import { formatCount, formatDuration, formatPercent, formatRelativeTime, truncateId } from '../../lib/format';
import { deliveryOutcome, describeDelivery } from '../../lib/delivery-status';
import type { Delivery, Endpoint } from '../../types/api';
import { useDeliveries } from '../deliveries/api';
import { useOrganization } from '../organizations/api';
import { useEndpoint } from './api';
import { EndpointActions } from './EndpointActions';
import { EndpointEditDialog } from './EndpointEditDialog';
import { EndpointSecretsDialog } from './EndpointSecretsDialog';
import { SOURCE_LABEL, endpointFacts } from './endpoint-state';

/**
 * One endpoint: what it is configured to do, what it is actually doing, and the
 * last few things that happened to it.
 *
 * ## Why this page exists
 *
 * Everything here was previously reachable only through dialogs launched from a
 * row in a table. That is fine for editing and wrong for reading: the question
 * this page answers — "what is going on with partner-acme?" — needs the
 * configuration, the health, the recent deliveries and the secret state
 * side by side, and a dialog can hold exactly one of them at a time. It is also
 * the page a delivery in the ledger should link to, which a dialog cannot be.
 *
 * ## Why the secrets stay in a dialog
 *
 * The design draws them as a panel. They are launched from here instead,
 * because issuing a secret shows a plaintext exactly once and that reveal is
 * held in component state, never in the query cache and never in the URL. A
 * panel on a page that can be navigated away from and back to is a worse home
 * for it than a dialog that is destroyed on close.
 */
export function EndpointDetailPage() {
  const { orgId = '', projectId = '', endpointId = '' } = useParams();
  const endpoint = useEndpoint(projectId, endpointId);
  const organization = useOrganization(orgId);
  const [editing, setEditing] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);

  const base = `/orgs/${orgId}/projects/${projectId}`;

  return (
    <div className="flex flex-col gap-4">
      <Async query={endpoint}>
        {(row) => {
          const facts = endpointFacts(row);
          const source = SOURCE_LABEL[facts.source];

          return (
            <div className="flex flex-col gap-4">
              <PageHeader
                eyebrow={
                  <Link to={`${base}/endpoints`} className="text-ink-muted hover:text-ink">
                    ← Back to endpoints
                  </Link>
                }
                title={row.name}
                description={<span className="font-mono text-2xs break-all">{row.url}</span>}
                actions={
                  row.status === 'deleted' ? (
                    <span className="text-2xs text-ink-subtle">kept for the ledger</span>
                  ) : (
                    <>
                      <EndpointActions
                        endpoint={row}
                        projectId={projectId}
                        onOpenSecrets={() => setSecretsOpen(true)}
                      />
                      <Button size="sm" onClick={() => setEditing(true)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant={row.has_live_secret ? 'secondary' : 'primary'}
                        onClick={() => setSecretsOpen(true)}
                      >
                        Signing secrets
                      </Button>
                    </>
                  )
                }
              />

              {/*
                Two facts, side by side, with the caption saying whose decision
                the situation is — which is the part that tells you which of
                them to act on.
              */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[0.625rem] border border-line bg-panel px-4 py-3">
                <FactPair label="Your setting" value={facts.intent.label} tone={facts.intent.tone} />
                <FactPair label="HookuBit" value={facts.platform.label} tone={facts.platform.tone} />
                {source && (
                  <span className="text-[0.5625rem] font-bold tracking-wide text-ink-subtle">
                    {source}
                  </span>
                )}
              </div>

              {facts.remedy && (
                <p
                  role="status"
                  className={cn(
                    'rounded-[0.625rem] border px-3.5 py-2.5 text-xs leading-relaxed',
                    facts.platform.tone === 'danger'
                      ? 'border-danger/30 bg-danger-soft text-danger'
                      : 'border-warn/30 bg-warn-soft text-warn',
                  )}
                >
                  {facts.remedy}
                </p>
              )}

              <div className="grid gap-4 xl:grid-cols-[3fr,2fr]">
                <Configuration endpoint={row} />
                <Health endpoint={row} />
              </div>

              <CustomHeaders endpoint={row} onEdit={() => setEditing(true)} />

              <RecentDeliveries orgId={orgId} projectId={projectId} endpoint={row} />

              {editing && (
                <EndpointEditDialog
                  projectId={projectId}
                  endpoint={row}
                  onClose={() => setEditing(false)}
                />
              )}
              {secretsOpen && (
                <EndpointSecretsDialog
                  endpoint={row}
                  currentRole={organization.data?.role}
                  onClose={() => setSecretsOpen(false)}
                />
              )}
            </div>
          );
        }}
      </Async>
    </div>
  );
}

function FactPair({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">{label}</span>
      <Badge tone={tone} dot>
        {value}
      </Badge>
    </span>
  );
}

/** Every setting that applies to every delivery to this endpoint. */
function Configuration({ endpoint }: { endpoint: Endpoint }) {
  const rows: Array<[string, string]> = [
    ['Request timeout', formatDuration(endpoint.timeout_ms)],
    ['Max concurrency', `${endpoint.max_concurrency} in flight`],
    [
      'Rate limit',
      endpoint.rate_limit === null
        ? 'unlimited'
        : `${formatCount(endpoint.rate_limit)} per ${endpoint.rate_limit_window_seconds}s`,
    ],
    ['Retry policy', endpoint.retry_policy_id ? truncateId(endpoint.retry_policy_id) : 'project default'],
    ['Created', formatRelativeTime(endpoint.created_at)],
  ];

  return (
    <Panel title="Configuration" description="Applies to every delivery to this endpoint.">
      <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-2xs text-ink-subtle">{label}</dt>
            <dd className="text-xs text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/**
 * The last hour, and the breaker's counters.
 *
 * `success_rate_1h` is null when nothing settled — rendered as "no data", not
 * as 0%, because 0% means every delivery we attempted failed and this panel is
 * read by someone deciding whether to wake a person up.
 */
function Health({ endpoint }: { endpoint: Endpoint }) {
  const health = endpoint.health;

  if (!health) {
    return (
      <Panel title="Health">
        <p className="text-xs text-ink-muted">
          Could not work out how this endpoint has been doing. Its configuration above is
          unaffected, and deliveries are not stopped by this.
        </p>
      </Panel>
    );
  }

  const rows: Array<[string, string, string?]> = [
    [
      'Success rate (1h)',
      health.success_rate_1h === null ? 'no data' : formatPercent(health.success_rate_1h),
      health.success_rate_1h === null ? 'Nothing settled in the last hour' : undefined,
    ],
    ['Deliveries (1h)', formatCount(health.deliveries_1h)],
    [
      'Waiting',
      formatCount(health.deliveries_waiting),
      'Created and still moving, at any age — not just the last hour',
    ],
    ['Consecutive failures', formatCount(health.consecutive_failures)],
    [
      'Breaker opened',
      health.opened_at ? formatRelativeTime(health.opened_at) : 'not open',
    ],
    [
      'Last delivery',
      health.last_delivery_at ? formatRelativeTime(health.last_delivery_at) : 'never',
    ],
  ];

  return (
    <Panel title="Health" description="A fixed trailing hour, plus the circuit breaker.">
      <dl className="flex flex-col gap-2">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-ink-muted" title={hint}>
              {label}
            </dt>
            <dd className="text-xs font-medium tabular text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function CustomHeaders({ endpoint, onEdit }: { endpoint: Endpoint; onEdit: () => void }) {
  const headers = Object.entries(endpoint.custom_headers ?? {});

  return (
    <Panel
      title="Custom headers"
      description="Sent on every request, on top of the signature headers."
      actions={
        endpoint.status !== 'deleted' && (
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
        )
      }
    >
      {headers.length === 0 ? (
        <p className="text-xs text-ink-muted">
          None. Every request still carries the signature and delivery headers.
        </p>
      ) : (
        <dl className="flex flex-col gap-1.5">
          {headers.map(([name, value]) => (
            <div key={name} className="flex items-baseline gap-3">
              <dt className="w-56 shrink-0 truncate font-mono text-2xs text-ink">{name}</dt>
              <dd className="min-w-0 truncate font-mono text-2xs text-ink-muted">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  );
}

/**
 * The last few deliveries to this endpoint.
 *
 * Five, and a link to the filtered list rather than a pager. This panel exists
 * to answer "is it working right now?", and the answer is in the newest rows;
 * anything more is the deliveries page, which already does paging, filtering
 * and every status properly.
 */
function RecentDeliveries({
  orgId,
  projectId,
  endpoint,
}: {
  orgId: string;
  projectId: string;
  endpoint: Endpoint;
}) {
  const deliveries = useDeliveries(projectId, { endpoint_id: endpoint.id });
  const base = `/orgs/${orgId}/projects/${projectId}`;

  return (
    <Panel
      title="Recent deliveries"
      description="The newest first. Everything else is on the deliveries page."
      flush
      actions={
        <Link
          to={`${base}/deliveries?endpoint_id=${endpoint.id}`}
          className="text-xs text-ink-muted hover:text-ink"
        >
          View all
        </Link>
      }
    >
      <Async
        query={deliveries}
        isEmpty={(page) => page.rows.length === 0}
        empty={
          <EmptyState
            title="Nothing has been sent here"
            description="A delivery exists once a published event matches a subscription that names this endpoint."
          />
        }
      >
        {(page) => (
          <Table
            caption={`Recent deliveries to ${endpoint.name}`}
            columns={deliveryColumns(base)}
            rows={page.rows.slice(0, 5)}
            rowKey={(row) => row.id}
          />
        )}
      </Async>
    </Panel>
  );
}

function deliveryColumns(base: string): Column<Delivery>[] {
  return [
    {
      key: 'state',
      header: 'State',
      render: (row) => <DeliveryStatusBadge status={row.status} />,
    },
    {
      key: 'id',
      header: 'Delivery',
      render: (row) => (
        <Link to={`${base}/deliveries/${row.id}`} className="font-mono text-2xs hover:underline">
          {truncateId(row.id)}
        </Link>
      ),
    },
    {
      key: 'outcome',
      header: 'Outcome',
      secondary: true,
      // `deliveryOutcome` with no attempts in hand: the row carries the status,
      // the counters and the last error, which is everything the sentence needs
      // except the final status code. Fetching attempts for five rows to
      // recover one number is not worth five requests.
      render: (row) => (
        <span className="text-2xs text-ink-muted">{describeDelivery(deliveryOutcome(row))}</span>
      ),
    },
    {
      key: 'age',
      header: 'Age',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-2xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
      ),
    },
  ];
}
