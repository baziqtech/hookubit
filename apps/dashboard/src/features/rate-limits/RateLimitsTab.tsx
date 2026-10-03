import { useEffect, useRef, useState } from 'react';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Pager,
  Panel,
  PermissionDenied,
  Table,
  WriteErrorNotice,
  type Column,
} from '../../components';
import { formatRelativeTime } from '../../lib/format';
import { DEFAULT_PAGE_SIZE, RATE_LIMIT_SCOPES, type RateLimit, type Role } from '../../types/api';
import { useApiKeys } from '../api-keys/api';
import { useEndpoints } from '../endpoints/api';
import {
  POLICY_WRITE_ROLES,
  mayWritePolicies,
  policyWriteDeniedReason,
  type PolicyWriteGate,
} from '../policies/permissions';
import { isForbidden } from '../policies/write-errors';
import { useDeleteRateLimit, useRateLimits } from './api';
import { RateLimitDialog } from './RateLimitDialog';
import {
  describeResource,
  describeScope,
  enforcementVerdict,
  formatRate,
  resourceKindFor,
  type EnforcementVerdict,
} from './rate-limit-rules';

/**
 * The rate-limit policies table, its two writes, and — most importantly — a
 * column that says whether each row is a ceiling in force or a row in a table.
 *
 * The control API's own service docblock puts it plainly: "a table of
 * ceilings that nothing enforces is worse than no table". The data plane has
 * since wired the INGEST path (`ingest`, `project` and `organization` rows are
 * charged when an event is accepted) and not the delivery path (the workers
 * read only `endpoints.rate_limit`). So every row carries a verdict, read from
 * `rate-limit-rules.ts`, which cites the Go code it was read from.
 */
type Action =
  | { kind: 'create' }
  | { kind: 'edit'; policy: RateLimit }
  | { kind: 'delete'; policy: RateLimit };

function verdictTone(verdict: EnforcementVerdict): 'ok' | 'warn' | 'danger' {
  switch (verdict.kind) {
    case 'enforced':
      return 'ok';
    case 'partial':
      return 'warn';
    case 'inert':
      return 'danger';
  }
}

export function RateLimitsTab({
  projectId,
  gate,
  currentRole,
}: {
  projectId: string;
  gate: PolicyWriteGate;
  currentRole?: Role;
}) {
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const policies = useRateLimits(projectId, offset);
  // For resolving `resource_id` to a name. Both lists are one page; an id past
  // the page renders as the id, flagged, never dropped.
  const endpoints = useEndpoints(projectId);
  const apiKeys = useApiKeys(projectId);
  const lookup = { endpoints: endpoints.data?.rows ?? [], apiKeys: apiKeys.data?.rows ?? [] };

  const writable = mayWritePolicies(gate);
  const deniedReason = policyWriteDeniedReason(gate);

  const columns: Column<RateLimit>[] = [
    {
      key: 'scope',
      header: 'Scope',
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <Badge tone="neutral">{row.scope}</Badge>
          <span className="font-mono text-2xs text-ink-subtle">{row.id}</span>
        </span>
      ),
    },
    {
      key: 'resource',
      header: 'Applies to',
      render: (row) => {
        const resource = describeResource(row, lookup);
        return (
          <span className="flex flex-col gap-0.5">
            <span className={resource.unresolved ? 'font-mono text-2xs text-ink' : 'text-xs text-ink'}>
              {resource.label}
            </span>
            {resource.unresolved && (
              <span className="text-2xs text-ink-subtle">
                {resourceKindFor(row.scope)} not on the first page of its list
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'rate',
      header: 'Limit',
      align: 'right',
      render: (row) => (
        <span className="text-xs tabular text-ink">{formatRate(row.limit, row.window_seconds)}</span>
      ),
    },
    {
      key: 'burst',
      header: 'Burst',
      align: 'right',
      render: (row) => (
        <span className="text-xs tabular text-ink-muted">
          {row.burst === null ? <span className="text-ink-subtle">= limit</span> : row.burst.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'enforced',
      header: 'Enforced today',
      render: (row) => {
        const verdict = enforcementVerdict(row.scope);
        return (
          <Badge tone={verdictTone(verdict)} dot>
            {verdict.label}
          </Badge>
        );
      },
    },
    {
      key: 'updated',
      header: 'Updated',
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-2xs text-ink-subtle">{formatRelativeTime(row.updated_at)}</span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <span className="flex flex-wrap justify-end gap-1.5">
          <Button
            size="sm"
            disabled={!writable}
            title={deniedReason}
            onClick={() => setAction({ kind: 'edit', policy: row })}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!writable}
            title={deniedReason}
            onClick={() => setAction({ kind: 'delete', policy: row })}
          >
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4 pt-4">
      <Panel
        flush
        title="Rate limits"
        description="Nested budgets, not fallbacks: every applicable row is charged and any one may refuse. Within one scope the row naming a specific resource beats the every-resource row."
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={!writable}
            title={deniedReason}
            onClick={() => setAction({ kind: 'create' })}
          >
            Create policy
          </Button>
        }
      >
        <Async
          query={policies}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <EmptyState
              title="No rate-limit policies"
              description="Ingest runs on the installation’s configured ceiling, and delivery on each endpoint’s own Rate limit setting. Add a policy to bound one API key, or the whole project’s ingest."
              action={
                <Button
                  variant="primary"
                  disabled={!writable}
                  title={deniedReason}
                  onClick={() => setAction({ kind: 'create' })}
                >
                  Create policy
                </Button>
              }
            />
          }
        >
          {(page) => (
            <>
              <Table caption="Rate-limit policies" columns={columns} rows={page.rows} rowKey={(row) => row.id} />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="Rate-limit policies"
              />
            </>
          )}
        </Async>
      </Panel>

      <EnforcementLegend />

      {action?.kind === 'create' && (
        <RateLimitDialog
          projectId={projectId}
          endpoints={lookup.endpoints}
          apiKeys={lookup.apiKeys}
          currentRole={currentRole}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'edit' && (
        <RateLimitDialog
          projectId={projectId}
          policy={action.policy}
          endpoints={lookup.endpoints}
          apiKeys={lookup.apiKeys}
          currentRole={currentRole}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'delete' && (
        <DeleteRateLimitDialog
          projectId={projectId}
          policy={action.policy}
          resourceLabel={describeResource(action.policy, lookup).label}
          currentRole={currentRole}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}

/**
 * Which scopes the data plane reads, stated once under the table so the
 * badges have a key. The citations are the point: this panel is a claim about
 * Go code, and a reader who doubts it should be able to open the file.
 */
function EnforcementLegend() {
  return (
    <Panel
      title="Which scopes are enforced today"
      description="Read from the data plane, not from the API’s description of intent."
    >
      <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
        {RATE_LIMIT_SCOPES.map((scope) => {
          const verdict = enforcementVerdict(scope);
          return (
            <div key={scope} className="contents">
              <dt className="flex items-center gap-2">
                <Badge tone="neutral">{scope}</Badge>
                <Badge tone={verdictTone(verdict)} dot>
                  {verdict.label}
                </Badge>
              </dt>
              <dd className="text-ink-muted">{describeScope(scope)}</dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">
        Ingest: <code className="font-mono">internal/ingest/handler.go:242</code> charges the policy
        limiter and <code className="font-mono">internal/ratelimit/policy.go:139–154</code> resolves
        the ingest, project and organization rows. Delivery:{' '}
        <code className="font-mono">internal/worker/deliver.go:173</code> charges only the endpoint’s
        own <code className="font-mono">rate_limit</code> column loaded at{' '}
        <code className="font-mono">internal/worker/store.go:239</code>;{' '}
        <code className="font-mono">internal/ratelimit/policy.go:161</code> marks the delivery-side
        resolver “nothing wires this yet”. Organization-scoped rows made under another project apply
        here too but are listed there.
      </p>
    </Panel>
  );
}

function useFocusOnError(isError: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isError) ref.current?.focus();
  }, [isError]);
  return ref;
}

function DeleteRateLimitDialog({
  projectId,
  policy,
  resourceLabel,
  currentRole,
  onClose,
}: {
  projectId: string;
  policy: RateLimit;
  resourceLabel: string;
  currentRole?: Role;
  onClose: () => void;
}) {
  const remove = useDeleteRateLimit(projectId);
  const errorRef = useFocusOnError(remove.isError);
  const verdict = enforcementVerdict(policy.scope);

  if (isForbidden(remove.error)) {
    return (
      <Dialog open onClose={onClose} title="Delete this rate limit?" footer={<Button onClick={onClose}>Close</Button>}>
        <PermissionDenied
          action="delete a rate-limit policy"
          requiredRoles={[...POLICY_WRITE_ROLES]}
          currentRole={currentRole}
          error={remove.error}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete this rate limit?"
      description={`${policy.scope} · ${resourceLabel} · ${formatRate(policy.limit, policy.window_seconds)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(policy.id, { onSuccess: onClose })}
          >
            Delete policy
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={remove.error} />
        </div>
        {verdict.kind === 'inert' ? (
          <p>
            This row is read by nothing today, so deleting it changes no behaviour. It stops being
            a ceiling that would come into force when the delivery workers start reading
            endpoint-scope policies.
          </p>
        ) : (
          <p>
            Events for <strong className="text-ink">{resourceLabel}</strong> stop being charged
            against this bucket within about 30 seconds (the policy cache TTL). They fall back to the
            next scope up
            {policy.scope === 'ingest' && policy.resource_id !== null
              ? ' — the every-key ingest row if there is one, else the project row, else the installation’s configured ingest ceiling'
              : policy.scope === 'ingest'
                ? ' — the project row if there is one, else the installation’s configured ingest ceiling'
                : ''}
            .
          </p>
        )}
        <p className="text-2xs text-ink-subtle">
          This is a hard delete with no preconditions: nothing in the delivery ledger references a
          rate-limit policy.
        </p>
      </div>
    </Dialog>
  );
}
