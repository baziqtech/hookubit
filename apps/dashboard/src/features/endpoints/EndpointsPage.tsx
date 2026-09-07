import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pager,
  Panel,
  SecretReveal,
  Table,
  WriteErrorNotice,
  type Column,
} from '../../components';
import { formatDuration, formatRelativeTime } from '../../lib/format';
import { DEFAULT_PAGE_SIZE, type CreatedEndpoint, type Endpoint } from '../../types/api';
import { useCreateEndpoint, useEndpoints } from './api';

export function EndpointsPage() {
  const { projectId = '' } = useParams();
  const [offset, setOffset] = useState(0);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [creating, setCreating] = useState(false);

  const endpoints = useEndpoints(projectId, { offset, includeDeleted });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Endpoints"
        description="Each endpoint has its own concurrency, rate limit and circuit breaker — a slow one cannot starve the others."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Add endpoint
          </Button>
        }
      />

      <Panel flush>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(event) => {
                setIncludeDeleted(event.target.checked);
                setOffset(0);
              }}
            />
            Show deleted endpoints
          </label>
          <span className="text-2xs text-ink-subtle">
            Deleted endpoints are kept forever so the delivery ledger stays readable.
          </span>
        </div>

        <Async
          query={endpoints}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <EmptyState
              title="No endpoints"
              description="An endpoint is a URL the platform delivers to. Add one, then subscribe it to event types."
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  Add endpoint
                </Button>
              }
            />
          }
        >
          {(page) => (
            <>
              <Table
                caption="Endpoints"
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
              />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="endpoints"
              />
            </>
          )}
        </Async>
      </Panel>

      <CreateEndpointDialog
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}

/**
 * Create, and then tell the truth about what was created.
 *
 * A caller without `endpoint-secrets.write` gets a PAUSED endpoint with no
 * secret they can see. Closing the dialog on a green tick would present a
 * non-delivering endpoint as a working one — so the dialog stays open on
 * `secret_pending` and says what has to happen next, and by whom.
 */
function CreateEndpointDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [created, setCreated] = useState<CreatedEndpoint | null>(null);
  const create = useCreateEndpoint(projectId);

  const close = () => {
    setCreated(null);
    setName('');
    setUrl('');
    create.reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={created ? 'Endpoint created' : 'Add endpoint'}
      description={
        created ? undefined : 'The URL is validated now, so an unusable one is refused here rather than becoming silent delivery failures later.'
      }
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={create.isPending || !name || !url}
              onClick={() =>
                create.mutate({ name, url }, { onSuccess: (result) => setCreated(result) })
              }
            >
              {create.isPending ? 'Creating…' : 'Create endpoint'}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <EndpointCreatedNotice endpoint={created} />
      ) : (
        <div className="flex flex-col gap-3">
          {create.isError && <WriteErrorNotice error={create.error} />}
          <Field label="Name" required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="finance-api"
              />
            )}
          </Field>
          <Field label="URL" required hint="HTTPS only. Private and loopback addresses are refused.">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/webhooks"
              />
            )}
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/**
 * The two outcomes of a successful create, which are NOT the same outcome.
 *
 * With a secret: the endpoint is active and the plaintext is shown once.
 * Without one (`secret_pending`): the endpoint exists but is PAUSED and is not
 * receiving anything. Presenting that as success is the failure this component
 * exists to prevent — the user would wire up a consumer and wait for
 * deliveries that are never going to arrive.
 */
export function EndpointCreatedNotice({ endpoint }: { endpoint: CreatedEndpoint }) {
  if (endpoint.secret_pending || endpoint.secret === null) {
    return (
      <div
        role="alert"
        data-testid="secret-pending-notice"
        className="flex flex-col gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs"
      >
        <p className="font-semibold text-warn">
          This endpoint is paused and will not receive deliveries yet.
        </p>
        <p className="text-ink-muted">
          It was created without a signing secret you are allowed to see, so there is no key to
          sign its deliveries with. <strong>An owner or admin must rotate its secret</strong>, hand
          the plaintext to whoever runs the consumer, and then enable the endpoint.
        </p>
        <p className="text-ink-subtle">
          Enabling it now would sign every delivery with a key nobody holds: the consumer would
          reject all of them, and the rotation that fixed it would change the secret again — two
          verification outages instead of none.
        </p>
        <p className="text-2xs text-ink-subtle">
          Status: <Badge tone="neutral">{endpoint.status}</Badge> · secret version{' '}
          {endpoint.secret_version} pending
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">
        <strong className="text-ink">{endpoint.name}</strong> is active and will receive matching
        deliveries. Its version {endpoint.secret_version} signing secret is below.
      </p>
      <SecretReveal value={endpoint.secret} label="signing secret" />
    </div>
  );
}

/**
 * Columns follow `EndpointDto`. There is no `circuit_state` and no
 * `success_rate_24h` on the wire: the breaker reports through `status` plus
 * `disabled_reason`/`disabled_at`, and the token bucket is `rate_limit` per
 * `rate_limit_window_seconds` rather than a per-second scalar.
 */
const columns: Column<Endpoint>[] = [
  {
    key: 'name',
    header: 'Endpoint',
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-xs font-medium text-ink">{row.name}</span>
        <span className="font-mono text-2xs text-ink-subtle">{row.url}</span>
        {row.disabled_reason && (
          <span className="mt-0.5 text-2xs text-danger">{row.disabled_reason}</span>
        )}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <span className="flex flex-wrap gap-1">
        <Badge tone={statusTone(row.status)} dot>
          {row.status}
        </Badge>
        {/*
         * Operator intent versus what the breaker did. `enabled: true` with a
         * `disabled` status means the operator wants this endpoint delivering
         * and the platform stopped it — a distinction an operator at 2am needs.
         */}
        {row.enabled && row.status === 'disabled' && <Badge tone="danger">auto-disabled</Badge>}
        {!row.enabled && row.status !== 'deleted' && <Badge tone="neutral">operator paused</Badge>}
      </span>
    ),
  },
  {
    key: 'limits',
    header: 'Limits',
    secondary: true,
    render: (row) => (
      <span className="text-2xs text-ink-muted">
        {row.rate_limit === null
          ? 'unlimited'
          : `${row.rate_limit}/${row.rate_limit_window_seconds}s`}{' '}
        · {formatDuration(row.timeout_ms)} timeout · {row.max_concurrency} concurrent
      </span>
    ),
  },
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    secondary: true,
    render: (row) => (
      <span className="text-2xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
    ),
  },
];

function statusTone(status: Endpoint['status']): 'ok' | 'neutral' | 'danger' {
  if (status === 'active') return 'ok';
  if (status === 'paused') return 'neutral';
  return 'danger';
}
