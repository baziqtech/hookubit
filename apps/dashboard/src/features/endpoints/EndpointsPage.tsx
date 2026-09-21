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
import { cn } from '../../lib/cn';
import { formatCount, formatDuration, formatPercent, formatRelativeTime } from '../../lib/format';
import { DEFAULT_PAGE_SIZE, type CreatedEndpoint, type Endpoint } from '../../types/api';
import { useOrganization } from '../organizations/api';
import { useCreateEndpoint, useEndpoints } from './api';
import { EndpointActions } from './EndpointActions';
import { EndpointEditDialog } from './EndpointEditDialog';
import { EndpointSecretsDialog } from './EndpointSecretsDialog';
import { SOURCE_LABEL, endpointFacts } from './endpoint-state';

/** What the Secrets dialog needs of an endpoint — a created one qualifies too. */
type SecretsTarget = Pick<Endpoint, 'id' | 'name' | 'status' | 'has_live_secret'>;

export function EndpointsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const [offset, setOffset] = useState(0);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [creating, setCreating] = useState(false);
  // One dialog for the whole table, driven by which row was clicked. A dialog
  // per row would put sixty `<dialog>` elements — and sixty copies of the same
  // element id — in the document.
  const [editing, setEditing] = useState<Endpoint | null>(null);
  const [secretsFor, setSecretsFor] = useState<SecretsTarget | null>(null);

  const endpoints = useEndpoints(projectId, { offset, includeDeleted });
  // The caller's own role, for the Secrets dialog's denial copy: signing
  // secrets are owner/admin only, and "you cannot" should name the role.
  const role = useOrganization(orgId).data?.role;
  const columns = buildColumns(projectId, setEditing, setSecretsFor);

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
        onOpenSecrets={(endpoint) => {
          setCreating(false);
          setSecretsFor(endpoint);
        }}
      />

      {editing && (
        <EndpointEditDialog
          endpoint={editing}
          projectId={projectId}
          onClose={() => setEditing(null)}
        />
      )}

      {secretsFor && (
        <EndpointSecretsDialog
          endpoint={secretsFor}
          currentRole={role}
          onClose={() => setSecretsFor(null)}
        />
      )}
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
  onOpenSecrets,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /** The cure for `secret_pending`: hands the created endpoint to the Secrets dialog. */
  onOpenSecrets: (endpoint: SecretsTarget) => void;
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
        <EndpointCreatedNotice endpoint={created} onOpenSecrets={() => onOpenSecrets(created)} />
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
export function EndpointCreatedNotice({
  endpoint,
  onOpenSecrets,
}: {
  endpoint: CreatedEndpoint;
  /** Opens the Secrets dialog for this endpoint — where the rotation happens. */
  onOpenSecrets?: () => void;
}) {
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
        {onOpenSecrets && (
          <p>
            <Button size="sm" variant="secondary" onClick={onOpenSecrets}>
              Open secrets for this endpoint
            </Button>
            <span className="ml-2 text-2xs text-ink-subtle">
              Rotation happens there. It names the role required if yours is not enough.
            </span>
          </p>
        )}
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
 *
 * "Your setting" and "HookuBit" are two columns rather than one status, and
 * that is the most load-bearing decision on this screen. `enabled` is what the
 * operator asked for; `status` is what the platform did about it. They are
 * separate columns in the database because they DISAGREE — an endpoint
 * auto-disabled after too many failures still reads `enabled: true` — and an
 * endpoint you still want delivering that we stopped is a different problem,
 * with a different fix, from one you paused yourself.
 *
 * Built per render rather than declared once at module scope, because the
 * actions need the project id — every write route is nested under it — and the
 * edit dialog is owned by the page.
 */
function buildColumns(
  projectId: string,
  onEdit: (endpoint: Endpoint) => void,
  onSecrets: (endpoint: Endpoint) => void,
): Column<Endpoint>[] {
  return [
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
      key: 'intent',
      header: 'Your setting',
      render: (row) => {
        const facts = endpointFacts(row);
        return (
          <Badge tone={facts.intent.tone} dot>
            {facts.intent.label}
          </Badge>
        );
      },
    },
    {
      // Two columns, because they are two different facts. See
      // `endpoint-state.ts` for why folding them into one is the thing that
      // makes an outage unreadable at 2am.
      key: 'platform',
      header: 'HookuBit',
      render: (row) => {
        const facts = endpointFacts(row);
        const source = SOURCE_LABEL[facts.source];
        return (
          <span className="flex flex-col items-start gap-1">
            <Badge tone={facts.platform.tone} dot>
              {facts.platform.label}
            </Badge>
            {source && (
              <span className="text-[0.5625rem] font-bold tracking-wide text-ink-subtle">
                {source}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'success',
      header: 'Success (1h)',
      align: 'right',
      /*
       * `null` and `0%` are NOT the same reading, and this is the column where
       * conflating them does the most damage. Zero means every delivery we
       * attempted failed — the loudest thing this table can say. An endpoint
       * that simply had no traffic in the last hour, which includes every
       * endpoint created today, would wear that badge for its first hour of
       * life and page somebody.
       */
      render: (row) =>
        row.health?.success_rate_1h === null || row.health === null ? (
          <span className="text-2xs text-ink-subtle" title="Nothing settled in the last hour">
            no data
          </span>
        ) : (
          <span
            className={cn(
              'text-xs font-medium tabular',
              row.health.success_rate_1h >= 0.99
                ? 'text-ink'
                : row.health.success_rate_1h >= 0.9
                  ? 'text-warn'
                  : 'text-danger',
            )}
            title={`${row.health.deliveries_1h} deliveries created in the last hour`}
          >
            {formatPercent(row.health.success_rate_1h)}
          </span>
        ),
    },
    {
      key: 'waiting',
      header: 'Waiting',
      align: 'right',
      secondary: true,
      /*
       * Not hour-bounded, unlike the column beside it. "What is queued behind
       * this problem?" is not a question about the last hour — an endpoint
       * stopped for a day has a day of backlog, and an hourly count would
       * report almost none of it.
       */
      render: (row) =>
        !row.health || row.health.deliveries_waiting === 0 ? (
          <span className="text-2xs text-ink-subtle">—</span>
        ) : (
          <span className="text-xs tabular text-warn">
            {formatCount(row.health.deliveries_waiting)}
          </span>
        ),
    },
    {
      key: 'last-delivery',
      header: 'Last delivery',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-2xs text-ink-subtle">
          {row.health?.last_delivery_at ? formatRelativeTime(row.health.last_delivery_at) : 'never'}
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
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) =>
        // A deleted endpoint is kept forever so the ledger stays readable, and
        // every write against it answers 409. No controls, rather than controls
        // that are guaranteed to fail.
        row.status === 'deleted' ? (
          <span className="text-2xs text-ink-subtle">kept for the ledger</span>
        ) : (
          <span className="flex flex-wrap items-center justify-end gap-2">
            <EndpointActions
              endpoint={row}
              projectId={projectId}
              onOpenSecrets={() => onSecrets(row)}
            />
            <Button size="sm" onClick={() => onEdit(row)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant={row.has_live_secret ? 'secondary' : 'primary'}
              onClick={() => onSecrets(row)}
            >
              Secrets
            </Button>
          </span>
        ),
    },
  ];
}


