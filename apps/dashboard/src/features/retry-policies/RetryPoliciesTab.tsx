import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Pager,
  Panel,
  PermissionDenied,
  Select,
  Table,
  WriteErrorNotice,
  type Column,
} from '../../components';
import { classifyWriteError } from '../../lib/api-errors';
import { formatRelativeTime } from '../../lib/format';
import { DEFAULT_PAGE_SIZE, type Endpoint, type RetryPolicy, type Role } from '../../types/api';
import { useEndpoints } from '../endpoints/api';
import {
  POLICY_WRITE_ROLES,
  mayWritePolicies,
  policyWriteDeniedReason,
  type PolicyWriteGate,
} from '../policies/permissions';
import { isForbidden, placeServerErrors } from '../policies/write-errors';
import { describeRetryPolicy, useDeleteRetryPolicy, useRetryPolicies, useSetDefaultRetryPolicy } from './api';
import { RetryPolicyDialog } from './RetryPolicyDialog';
import { formatBudget } from './retry-policy-rules';

/**
 * The retry-policies table and its three writes.
 *
 * Every row is described in words ("8 attempts, exponential ×2 from 5s up to
 * 60m") rather than as seven numbers, because the operator scanning this list
 * is choosing a curve for a consumer, and `describeRetryPolicy` is the same
 * sentence the endpoint form's picker shows — so what was chosen there can be
 * found here by reading, not by matching ids.
 *
 * The default is a badge, not a sort: `is_default` is on every row, and the
 * API deliberately does not sort it to the top.
 */
type Action =
  | { kind: 'create' }
  | { kind: 'edit'; policy: RetryPolicy }
  | { kind: 'default'; policy: RetryPolicy }
  | { kind: 'delete'; policy: RetryPolicy };

export function RetryPoliciesTab({
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
  const policies = useRetryPolicies(projectId, offset);
  // For the delete dialog's "these endpoints still use it" warning. One page;
  // the server's count is the authority and its 409 is rendered as such.
  const endpoints = useEndpoints(projectId);

  const writable = mayWritePolicies(gate);
  const deniedReason = policyWriteDeniedReason(gate);
  const rows = policies.data?.rows ?? [];
  const hasDefault = rows.some((policy) => policy.is_default);

  const columns: Column<RetryPolicy>[] = [
    {
      key: 'name',
      header: 'Policy',
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-ink">{row.name}</span>
            {row.is_default && (
              <Badge tone="info" dot>
                default
              </Badge>
            )}
          </span>
          <span className="font-mono text-2xs text-ink-subtle">{row.id}</span>
        </span>
      ),
    },
    {
      key: 'curve',
      header: 'Backoff',
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="text-xs text-ink">{describeRetryPolicy(row)}</span>
          <span className="text-2xs text-ink-subtle">
            {row.strategy}
            {row.jitter_ratio > 0 ? ` · jitter ${row.jitter_ratio}` : ' · no jitter'}
          </span>
        </span>
      ),
    },
    {
      key: 'attempts',
      header: 'Attempts',
      align: 'right',
      render: (row) => <span className="text-xs tabular text-ink">{row.max_attempts}</span>,
    },
    {
      key: 'budget',
      header: 'Budget',
      align: 'right',
      render: (row) => (
        <span className="text-xs tabular text-ink" title={`${row.max_retry_duration_ms} ms`}>
          {formatBudget(row.max_retry_duration_ms)}
        </span>
      ),
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
          {!row.is_default && (
            <Button
              size="sm"
              disabled={!writable}
              title={deniedReason}
              onClick={() => setAction({ kind: 'default', policy: row })}
            >
              Make default
            </Button>
          )}
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
        title="Retry policies"
        description="Which policy a delivery uses is resolved at fan-out and stamped on the row: the endpoint’s own, else the project default, else the built-in one (8 attempts, exponential ×2 from 5s up to 1h, 24h budget)."
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
              title="No retry policies"
              description="Every endpoint in this project retries on the built-in default. Create a policy to retry a consumer differently, then choose it on the endpoint."
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
              <Table caption="Retry policies" columns={columns} rows={page.rows} rowKey={(row) => row.id} />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="Retry policies"
              />
            </>
          )}
        </Async>
      </Panel>

      {action?.kind === 'create' && (
        <RetryPolicyDialog
          projectId={projectId}
          hasDefault={hasDefault}
          currentRole={currentRole}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'edit' && (
        <RetryPolicyDialog
          projectId={projectId}
          policy={action.policy}
          hasDefault={hasDefault}
          currentRole={currentRole}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'default' && (
        <SetDefaultDialog
          projectId={projectId}
          policy={action.policy}
          previous={rows.find((row) => row.is_default)}
          currentRole={currentRole}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'delete' && (
        <DeleteRetryPolicyDialog
          projectId={projectId}
          policy={action.policy}
          others={rows.filter((row) => row.id !== action.policy.id)}
          othersTruncated={policies.data?.hasMore ?? false}
          endpoints={endpoints.data?.rows ?? []}
          currentRole={currentRole}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}

function useFocusOnError(isError: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isError) ref.current?.focus();
  }, [isError]);
  return ref;
}

/**
 * `POST …/default`. A confirmation rather than a bare button, because the
 * effect is on every endpoint WITHOUT its own policy, and that set is not
 * visible from this table.
 */
function SetDefaultDialog({
  projectId,
  policy,
  previous,
  currentRole,
  onClose,
}: {
  projectId: string;
  policy: RetryPolicy;
  previous?: RetryPolicy;
  currentRole?: Role;
  onClose: () => void;
}) {
  const setDefault = useSetDefaultRetryPolicy(projectId);
  const errorRef = useFocusOnError(setDefault.isError);

  if (isForbidden(setDefault.error)) {
    return (
      <Dialog open onClose={onClose} title="Make this the default?" footer={<Button onClick={onClose}>Close</Button>}>
        <PermissionDenied
          action="change the default retry policy"
          requiredRoles={[...POLICY_WRITE_ROLES]}
          currentRole={currentRole}
          error={setDefault.error}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Make this the default?"
      description={policy.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={setDefault.isPending}
            onClick={() => setDefault.mutate(policy.id, { onSuccess: onClose })}
          >
            Make default
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={setDefault.error} />
        </div>
        <p>
          Endpoints that have not chosen a policy of their own start retrying as{' '}
          <strong className="text-ink">{describeRetryPolicy(policy)}</strong> for deliveries created
          from now on. Deliveries already fanned out keep the attempt budget stamped on their row.
        </p>
        {previous && (
          <p>
            <strong className="text-ink">{previous.name}</strong> stops being the default in the same
            transaction. Endpoints that chose it explicitly are unaffected.
          </p>
        )}
      </div>
    </Dialog>
  );
}

type DeleteForm = { replacement_id: string };

/**
 * `DELETE …/:policyId`, with the two preconditions the service holds spelled
 * out before the button rather than discovered as a 409.
 *
 *   - Live endpoints still on it: refused, with a count. The endpoints loaded
 *     on this page that reference it are named here so the operator knows
 *     what to re-point; the server's count is the authority.
 *   - The project default, with other policies remaining: the successor is
 *     REQUIRED in the same request, so no reader ever sees a project with
 *     policies and no default. It is a select over the other policies on this
 *     page; if the list is longer than one page the note says so.
 */
function DeleteRetryPolicyDialog({
  projectId,
  policy,
  others,
  othersTruncated,
  endpoints,
  currentRole,
  onClose,
}: {
  projectId: string;
  policy: RetryPolicy;
  others: RetryPolicy[];
  othersTruncated: boolean;
  endpoints: Endpoint[];
  currentRole?: Role;
  onClose: () => void;
}) {
  // A per-instance id, not a literal. A dialog can be mounted more than once
  // on a page (the switcher and the empty state both own a create dialog), and
  // a footer button's `form` attribute binds to the FIRST element with that
  // id in the document - which was the other, closed dialog's form, whose
  // validation failed on empty fields and never sent a request.
  const formId = useId();
  const remove = useDeleteRetryPolicy(projectId);
  const errorRef = useFocusOnError(remove.isError);
  const needsReplacement = policy.is_default && (others.length > 0 || othersTruncated);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<DeleteForm>({ defaultValues: { replacement_id: '' } });

  const using = endpoints.filter(
    (endpoint) => endpoint.retry_policy_id === policy.id && endpoint.status !== 'deleted',
  );
  const failure = remove.error ? classifyWriteError(remove.error) : null;

  const onSubmit = handleSubmit(
    (values) => {
      remove.mutate(
        {
          policyId: policy.id,
          replacementId: needsReplacement ? values.replacement_id : undefined,
        },
        {
          onSuccess: onClose,
          onError: (error) =>
            placeServerErrors(error, ['replacement_id'] as const, setError, setFocus),
        },
      );
    },
    () => setFocus('replacement_id'),
  );

  if (isForbidden(remove.error)) {
    return (
      <Dialog open onClose={onClose} title="Delete this retry policy?" footer={<Button onClick={onClose}>Close</Button>}>
        <PermissionDenied
          action="delete a retry policy"
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
      title="Delete this retry policy?"
      description={policy.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="danger" loading={remove.isPending}>
            Delete policy
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice
            error={remove.error}
            claimedFields={errors.replacement_id ? ['replacement_id'] : []}
          />
          {failure?.kind === 'conflict' && (
            <p className="mt-1.5 text-2xs leading-relaxed text-ink-subtle">
              Nothing was deleted. Re-point the endpoints named in the refusal at another policy on
              the Endpoints page, then try again.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
          <p>
            <strong className="text-ink">Refused while any live endpoint still uses it.</strong>{' '}
            Deleting would silently move those endpoints onto the built-in default backoff with
            nothing in the record to say so, so the API asks you to re-point them first. Deleted
            endpoints that still reference it do not block this; they are unlinked and the count is
            recorded in the audit log.
          </p>

          {using.length > 0 && (
            <p className="rounded border border-warn/30 bg-warn-soft/50 px-2.5 py-1.5 text-2xs text-warn">
              On the first page of Endpoints, {using.length === 1 ? 'this endpoint uses' : 'these endpoints use'}{' '}
              it: <strong className="font-semibold">{using.map((endpoint) => endpoint.name).join(', ')}</strong>.
              The delete will be refused until they are moved.
            </p>
          )}

          {policy.is_default && !needsReplacement && (
            <p>
              This is the only policy in the project, so no successor is needed: the project falls
              back to the built-in default (8 attempts, exponential ×2 from 5s up to 1h, 24h budget),
              which is a defined state.
            </p>
          )}
        </div>

        {needsReplacement && (
          <Field
            label="Successor"
            required
            error={errors.replacement_id?.message}
            hint={
              othersTruncated
                ? 'This is the project default, so its replacement is named in the same request and promoted in the same transaction. Only the policies on this page are listed; page through the table to find another.'
                : 'This is the project default, so its replacement is named in the same request and promoted in the same transaction — the project is never observed with policies and no default.'
            }
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Choose the next default"
                options={others.map((other) => ({
                  value: other.id,
                  label: `${other.name} — ${describeRetryPolicy(other)}`,
                }))}
                {...register('replacement_id', {
                  required: 'Name the policy that becomes the default.',
                })}
              />
            )}
          </Field>
        )}

        <p className="text-2xs text-ink-subtle">
          This is a hard delete. Nothing in the delivery ledger references a retry policy — a
          delivery records its attempts, not the curve that produced them — so there is no history
          to keep.
        </p>
      </form>
    </Dialog>
  );
}
