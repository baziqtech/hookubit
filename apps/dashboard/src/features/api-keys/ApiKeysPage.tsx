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
import { DEFAULT_PAGE_SIZE, type ApiKey, type CreatedApiKey } from '../../types/api';
import { useApiKeys, useCreateApiKey } from './api';

export function ApiKeysPage() {
  const { projectId = '' } = useParams();
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const keys = useApiKeys(projectId, offset);

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
    </div>
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

const columns: Column<ApiKey>[] = [
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
];
