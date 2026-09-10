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
import { formatRelativeTime } from '../../lib/format';
import { useFocusOnError } from '../../lib/use-focus-on-error';
import { DEFAULT_PAGE_SIZE, type ApiKey, type CreatedApiKey } from '../../types/api';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from './api';

export function ApiKeysPage() {
  const { projectId = '' } = useParams();
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  // One confirm dialog for the table, keyed on the row that was clicked.
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const keys = useApiKeys(projectId, offset);
  const columns = buildColumns(setRevoking);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="API keys"
        description="Server-to-server keys for publishing events. The full key is shown once, at creation, and can never be shown again."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create key
          </Button>
        }
      />

      <Panel flush>
        <Async
          query={keys}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <EmptyState
              title="No API keys"
              description="A publisher needs a key to post events to this project."
            />
          }
        >
          {(page) => (
            <>
              <Table
                caption="API keys"
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
              />
              {/*
               * Pagination matters more here than anywhere else in the product.
               * The reason to read this list is "revoke everything that can
               * authenticate as us", and a page that looked complete while the
               * server held more would answer that question wrongly.
               */}
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="API keys"
              />
            </>
          )}
        </Async>
      </Panel>

      <CreateApiKeyDialog
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
      />

      {revoking && (
        <RevokeApiKeyDialog
          apiKey={revoking}
          projectId={projectId}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}

/**
 * Revocation, stated as what it is before the button.
 *
 * `POST …/api-keys/:id/revoke` takes effect immediately — the ingest path
 * refuses the key on its next request — and is irreversible: only a hash of
 * the key was ever stored, so nothing can bring it back. The row stays, with
 * `status: revoked` and its `revoked_at`, so everything the key published
 * remains attributable. The route is idempotent, which is why the dialog does
 * not fret about a double click.
 *
 * Offered on every key that has not been revoked, expired ones included: the
 * per-project ceiling counts UN-REVOKED keys, and revocation is the only
 * operation that frees an expired key's slot (`ApiKeysService.assertBelowCeiling`).
 */
function RevokeApiKeyDialog({
  apiKey,
  projectId,
  onClose,
}: {
  apiKey: ApiKey;
  projectId: string;
  onClose: () => void;
}) {
  const revoke = useRevokeApiKey(projectId);
  const errorRef = useFocusOnError(revoke.isError);
  const expired = apiKey.status === 'expired';

  return (
    <Dialog
      open
      onClose={onClose}
      title={expired ? 'Revoke this expired key?' : 'Revoke this API key?'}
      description={
        <span>
          <strong className="text-ink">{apiKey.name}</strong> ·{' '}
          <span className="font-mono">{apiKey.key_prefix}…</span> · {apiKey.environment}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={revoke.isPending}
            onClick={() => revoke.mutate(apiKey.id, { onSuccess: onClose })}
          >
            Revoke key
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={revoke.error} />
        </div>
        {expired ? (
          <p>
            This key already stopped authenticating when it expired
            {apiKey.expires_at && ` ${formatRelativeTime(apiKey.expires_at)}`}. Revoking it
            changes nothing for the caller that held it; it frees the slot the key still holds
            against this project’s ceiling, which counts every un-revoked key.
          </p>
        ) : (
          <p>
            <strong className="text-ink">This takes effect immediately and cannot be undone.</strong>{' '}
            The publisher holding this key is refused on its very next request. Only a hash was
            ever stored, so the key cannot be reinstated — issue a new one and hand it over if
            that publisher should keep sending.
          </p>
        )}
        <p>
          The row stays in this list as <span className="font-mono">revoked</span>, so the events it
          published remain attributable to it.
        </p>
        {apiKey.last_used_at && !expired && (
          <p className="text-2xs text-ink-subtle">
            Last used {formatRelativeTime(apiKey.last_used_at)}. Recent use means a live
            integration is about to start failing.
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The plaintext key lives in this component's state and nowhere else — not the
 * query cache, not the URL, not `localStorage`. It is dropped when the dialog
 * closes, which is the same moment it stops being recoverable anywhere.
 */
function CreateApiKeyDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const create = useCreateApiKey(projectId);

  const close = () => {
    setCreated(null);
    setName('');
    create.reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={created ? 'API key created' : 'Create API key'}
      description={created ? undefined : 'The key is returned once and is not stored in plaintext.'}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            I have copied it
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={create.isPending || !name}
              onClick={() => create.mutate({ name }, { onSuccess: (result) => setCreated(result) })}
            >
              {create.isPending ? 'Creating…' : 'Create key'}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-ink-muted">
            <strong className="text-ink">{created.name}</strong> · {created.key_prefix}… ·{' '}
            {created.environment}
          </p>
          <SecretReveal value={created.key} label="API key" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {create.isError && <WriteErrorNotice error={create.error} />}
          <Field
            label="Name"
            required
            hint="What holds this key — an integration, not a person."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="payment-gateway (production)"
              />
            )}
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Built per render so the Revoke action can reach the page's dialog state; a
 * dialog per row would put fifty `<dialog>` elements in the document.
 */
function buildColumns(onRevoke: (key: ApiKey) => void): Column<ApiKey>[] {
  return [
  {
    key: 'name',
    header: 'Key',
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-xs font-medium text-ink">{row.name}</span>
        {/* `key_prefix` is the first 12 characters — never enough to reconstruct the credential. */}
        <span className="font-mono text-2xs text-ink-subtle">{row.key_prefix}…</span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <span className="flex flex-wrap gap-1">
        {/*
         * Derived server-side from revoked_at/expires_at, revoked outranking
         * expired, exactly as the ingest path derives it. Rendering our own
         * guess from `revoked_at` alone would disagree with the data plane on
         * an expired key.
         */}
        <Badge tone={row.status === 'active' ? 'ok' : 'danger'} dot>
          {row.status}
        </Badge>
        <Badge tone="neutral">{row.environment}</Badge>
      </span>
    ),
  },
  {
    key: 'used',
    header: 'Last used',
    align: 'right',
    render: (row) => (
      <span className="text-2xs text-ink-subtle">
        {row.last_used_at ? formatRelativeTime(row.last_used_at) : 'never'}
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
      // A revoked key is final. Offering the button again would be offering
      // a no-op (the route is idempotent), which reads as "did it work?".
      row.status === 'revoked' ? (
        <span className="text-2xs text-ink-subtle">
          revoked {row.revoked_at ? formatRelativeTime(row.revoked_at) : ''}
        </span>
      ) : (
        <Button size="sm" onClick={() => onRevoke(row)}>
          Revoke
        </Button>
      ),
  },
  ];
}
