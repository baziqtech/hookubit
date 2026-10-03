import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  PermissionDenied,
  Select,
  WriteErrorNotice,
} from '../../components';
import {
  RATE_LIMIT_LIMITS,
  RATE_LIMIT_SCOPES,
  type ApiKey,
  type CreateRateLimitBody,
  type Endpoint,
  type RateLimit,
  type RateLimitScope,
  type Role,
  type UpdateRateLimitBody,
} from '../../types/api';
import { POLICY_WRITE_ROLES } from '../policies/permissions';
import { isForbidden, placeServerErrors } from '../policies/write-errors';
import { useCreateRateLimit, useUpdateRateLimit } from './api';
import {
  describeScope,
  enforcementVerdict,
  rateLimitCoherenceIssues,
  resourceKindFor,
} from './rate-limit-rules';

/**
 * Creating or editing a rate-limit policy — every field `CreateRateLimitDto`
 * accepts, and on edit everything `UpdateRateLimitDto` does (the same set:
 * `scope` and `resource_id` are patchable, because changing them re-runs the
 * create path's resolution and uniqueness inside one transaction, which is
 * safer than the delete-then-recreate a read-only identity would force).
 *
 * ## `resource_id` is polymorphic, so the control changes with the scope
 *
 *   - `endpoint`: a select over this project's endpoints; blank means every
 *     endpoint in the project.
 *   - `ingest`: a select over this project's API keys; blank means every key,
 *     as ONE shared budget (the wildcard row is keyed by the project, not
 *     copied per key).
 *   - `project` / `organization`: nothing to choose. A row can only name its
 *     own project (`resolveRateLimitResource` refuses a sibling with a 400)
 *     or its own organization (another one is a 404), and the null row means
 *     the same thing, so the form sends null and says so.
 *
 * On a scope change the resource is cleared and RE-SENT, because the server
 * refuses a scope change that leaves a non-null `resource_id` unstated — an
 * endpoint id under organization scope would resolve against the wrong table.
 *
 * ## Honesty about enforcement
 *
 * The scope picker shows, per scope, whether the data plane reads the row
 * today. That is not decoration: an operator who creates an `endpoint`-scope
 * ceiling and walks away believing a partner is throttled has been misled by
 * the product, and the place to prevent that is the moment they choose the
 * scope.
 */
type FormValues = {
  scope: RateLimitScope;
  /** Empty string means "every resource in this scope" — sent as null. */
  resource_id: string;
  limit: number;
  window_seconds: number;
  /** Empty string means "the same as limit" — sent as null. */
  burst: string;
};

const SERVER_FIELDS: readonly (keyof FormValues)[] = [
  'scope',
  'resource_id',
  'limit',
  'window_seconds',
  'burst',
];

function toFormValues(policy: RateLimit | undefined): FormValues {
  if (!policy) {
    return {
      scope: 'endpoint',
      resource_id: '',
      limit: 100,
      window_seconds: RATE_LIMIT_LIMITS.window_seconds.default,
      burst: '',
    };
  }
  return {
    scope: policy.scope,
    resource_id: policy.resource_id ?? '',
    limit: policy.limit,
    window_seconds: policy.window_seconds,
    burst: policy.burst === null ? '' : String(policy.burst),
  };
}

/** What the wire gets for `resource_id`: null for the singular scopes and for blank. */
function resourceFor(scope: RateLimitScope, value: string): string | null {
  if (scope === 'project' || scope === 'organization') return null;
  return value.trim() === '' ? null : value.trim();
}

function burstFor(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

/**
 * Only what changed — except that a scope change ALWAYS restates the
 * resource, because the server requires it and a diff that omitted it would
 * be refused with a 400 the operator did nothing to cause.
 */
function changedFields(before: FormValues, after: FormValues): UpdateRateLimitBody | null {
  const body: UpdateRateLimitBody = {};
  const scopeChanged = after.scope !== before.scope;
  const resourceBefore = resourceFor(before.scope, before.resource_id);
  const resourceAfter = resourceFor(after.scope, after.resource_id);

  if (scopeChanged) body.scope = after.scope;
  if (scopeChanged || resourceAfter !== resourceBefore) body.resource_id = resourceAfter;
  if (Number(after.limit) !== before.limit) body.limit = Number(after.limit);
  if (Number(after.window_seconds) !== before.window_seconds) {
    body.window_seconds = Number(after.window_seconds);
  }
  if (after.burst.trim() !== before.burst.trim()) body.burst = burstFor(after.burst);

  return Object.keys(body).length === 0 ? null : body;
}

export function RateLimitDialog({
  projectId,
  policy,
  endpoints,
  apiKeys,
  currentRole,
  onClose,
}: {
  projectId: string;
  /** Absent for create. */
  policy?: RateLimit;
  endpoints: Endpoint[];
  apiKeys: ApiKey[];
  currentRole?: Role;
  onClose: () => void;
}) {
  // A per-instance id, not a literal. A dialog can be mounted more than once
  // on a page (the switcher and the empty state both own a create dialog), and
  // a footer button's `form` attribute binds to the FIRST element with that
  // id in the document - which was the other, closed dialog's form, whose
  // validation failed on empty fields and never sent a request.
  const formId = useId();
  const editing = policy !== undefined;
  const create = useCreateRateLimit(projectId);
  const update = useUpdateRateLimit(projectId, policy?.id ?? '');
  const mutation = editing ? update : create;
  // Fixed for the dialog's life, so the scope-change effect below can list it
  // as a dependency without re-running on every render.
  const [initial] = useState(() => toFormValues(policy));
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    setValue,
    getValues,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: initial });
  const errorRef = useRef<HTMLDivElement>(null);
  const claimed = SERVER_FIELDS.filter((field) => errors[field]);

  useEffect(() => {
    if (mutation.isError && claimed.length === 0) errorRef.current?.focus();
  }, [mutation.isError, claimed.length]);

  const scope = watch('scope');
  const resourceId = watch('resource_id');

  // A resource chosen under one scope means nothing under another, so a scope
  // change clears it — back to the stored value if the operator returns to
  // the original scope, so an edit that changes nothing sends nothing.
  useEffect(() => {
    setValue('resource_id', scope === initial.scope ? initial.resource_id : '');
  }, [scope, initial, setValue]);

  const onError = (error: unknown) => {
    placeServerErrors(error, SERVER_FIELDS, setError, setFocus);
  };

  const onSubmit = handleSubmit(
    (values) => {
      if (editing) {
        const body = changedFields(initial, values);
        if (!body) {
          onClose();
          return;
        }
        update.mutate(body, { onSuccess: onClose, onError });
        return;
      }
      const body: CreateRateLimitBody = {
        scope: values.scope,
        resource_id: resourceFor(values.scope, values.resource_id),
        limit: Number(values.limit),
        window_seconds: Number(values.window_seconds),
        burst: burstFor(values.burst),
      };
      create.mutate(body, { onSuccess: onClose, onError });
    },
    () => {
      const first = SERVER_FIELDS.find((field) => errors[field]);
      if (first) setFocus(first);
    },
  );

  if (isForbidden(mutation.error)) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={editing ? 'Edit rate limit' : 'Create rate limit'}
        footer={<Button onClick={onClose}>Close</Button>}
      >
        <PermissionDenied
          action={editing ? 'edit a rate-limit policy' : 'create a rate-limit policy'}
          requiredRoles={[...POLICY_WRITE_ROLES]}
          currentRole={currentRole}
          error={mutation.error}
        />
      </Dialog>
    );
  }

  const verdict = enforcementVerdict(scope);
  const liveEndpoints = endpoints.filter((endpoint) => endpoint.status !== 'deleted');
  const liveKeys = apiKeys.filter((key) => key.status === 'active');
  // The stored resource, kept as an explicit option so an id not on the loaded
  // page cannot be silently unset by saving.
  const missingResource =
    editing &&
    scope === initial.scope &&
    initial.resource_id !== '' &&
    ((scope === 'endpoint' && !liveEndpoints.some((row) => row.id === initial.resource_id)) ||
      (scope === 'ingest' && !liveKeys.some((row) => row.id === initial.resource_id)));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? 'Edit rate limit' : 'Create rate limit'}
      description={
        editing
          ? `${policy.scope} · ${policy.resource_id ?? `every ${resourceKindFor(policy.scope)}`}`
          : 'A ceiling on how fast events are accepted, or — once the workers read these rows — delivered.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={mutation.isPending}>
            {editing ? 'Save changes' : 'Create policy'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={mutation.error} claimedFields={claimed} />
        </div>

        <Field label="Scope" required error={errors.scope?.message} hint={describeScope(scope)}>
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              options={RATE_LIMIT_SCOPES.map((value) => ({
                value,
                label: `${value} — ${enforcementVerdict(value).label.toLowerCase()}`,
              }))}
              {...register('scope', { required: 'A scope is required.' })}
            />
          )}
        </Field>

        <p
          className={
            verdict.kind === 'enforced'
              ? 'rounded-md border border-ok/30 bg-ok-soft/50 px-3 py-2 text-2xs leading-relaxed text-ok'
              : verdict.kind === 'partial'
                ? 'rounded-md border border-warn/30 bg-warn-soft/50 px-3 py-2 text-2xs leading-relaxed text-warn'
                : 'rounded-md border border-danger/30 bg-danger-soft/50 px-3 py-2 text-2xs leading-relaxed text-danger'
          }
        >
          <Badge tone={verdict.kind === 'enforced' ? 'ok' : verdict.kind === 'partial' ? 'warn' : 'danger'} dot>
            {verdict.label}
          </Badge>{' '}
          {verdict.kind === 'enforced' &&
            'The ingest service charges this row for every event it accepts. Changes take effect within the policy cache TTL (about 30 seconds).'}
          {verdict.kind === 'partial' &&
            'The ingest service charges this row when events are accepted. The delivery workers do not read it — they read only each endpoint’s own Rate limit setting — so this does not slow deliveries down.'}
          {verdict.kind === 'inert' &&
            'Stored and validated, read by nothing. The delivery workers read only the endpoint’s own Rate limit and Rate limit window on the Endpoints page (internal/worker/deliver.go:173); a row here does not throttle deliveries until that is wired.'}
        </p>

        {scope === 'endpoint' && (
          <Field
            label="Endpoint"
            error={errors.resource_id?.message}
            hint="Leave blank for every endpoint in this project. A policy naming one endpoint beats the every-endpoint policy for that endpoint; never both."
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Every endpoint in this project"
                options={[
                  ...liveEndpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name })),
                  ...(missingResource
                    ? [{ value: initial.resource_id, label: `${initial.resource_id} — not on this page` }]
                    : []),
                ]}
                {...register('resource_id')}
              />
            )}
          </Field>
        )}

        {scope === 'ingest' && (
          <Field
            label="API key"
            error={errors.resource_id?.message}
            hint="Leave blank for every key in this project as ONE shared budget. Name a key to give one integration its own ceiling, so its runaway retry loop cannot consume the project’s whole ingest budget."
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Every API key in this project"
                options={[
                  ...liveKeys.map((key) => ({ value: key.id, label: `${key.name} (${key.key_prefix}…)` })),
                  ...(missingResource
                    ? [{ value: initial.resource_id, label: `${initial.resource_id} — not on this page` }]
                    : []),
                ]}
                {...register('resource_id')}
              />
            )}
          </Field>
        )}

        {(scope === 'project' || scope === 'organization') && (
          <p className="text-2xs leading-relaxed text-ink-subtle">
            Applies to <strong className="font-semibold text-ink">this {scope}</strong>. A policy row
            can only name its own {scope} — a sibling is refused — and the every-{scope} row means
            the same thing, so nothing is chosen here.
            {scope === 'organization' &&
              ' The row is filed under this project; the data plane reads organization-scoped rows from every project in the organization, but this project’s list only shows the ones made here.'}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Limit"
            required
            error={errors.limit?.message}
            hint={`Requests per window. ${RATE_LIMIT_LIMITS.limit.min}–${RATE_LIMIT_LIMITS.limit.max.toLocaleString()}.`}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('limit', {
                  valueAsNumber: true,
                  required: 'A limit is required.',
                  deps: ['burst'],
                  min: {
                    value: RATE_LIMIT_LIMITS.limit.min,
                    message: 'At least 1 — 0 is not a very small limit, it switches delivery or ingestion off for whatever this covers.',
                  },
                  max: {
                    value: RATE_LIMIT_LIMITS.limit.max,
                    message: `At most ${RATE_LIMIT_LIMITS.limit.max.toLocaleString()}.`,
                  },
                  validate: (value) => Number.isInteger(value) || 'Whole numbers only.',
                })}
              />
            )}
          </Field>

          <Field
            label="Window (seconds)"
            error={errors.window_seconds?.message}
            hint={`The window the limit is counted over. ${RATE_LIMIT_LIMITS.window_seconds.min}–${RATE_LIMIT_LIMITS.window_seconds.max.toLocaleString()} (one day).`}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('window_seconds', {
                  valueAsNumber: true,
                  required: 'A window is required.',
                  min: {
                    value: RATE_LIMIT_LIMITS.window_seconds.min,
                    message: 'At least 1 — the refill rate is limit ÷ window, so a zero window is a division by zero downstream.',
                  },
                  max: {
                    value: RATE_LIMIT_LIMITS.window_seconds.max,
                    message: 'At most one day (86 400) — longer than that is a quota, not a rate limit.',
                  },
                  validate: (value) => Number.isInteger(value) || 'Whole seconds only.',
                })}
              />
            )}
          </Field>

          <Field
            label="Burst"
            error={errors.burst?.message}
            hint="Bucket capacity. Blank means the same as the limit. Must be at least the limit, or the bucket could never hold one window’s worth of tokens and the limit would be unreachable."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                placeholder="same as limit"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('burst', {
                  validate: (value) => {
                    if (value.trim() === '') return true;
                    const parsed = Number(value);
                    if (!Number.isInteger(parsed)) return 'Whole numbers only, or blank.';
                    if (parsed < RATE_LIMIT_LIMITS.burst.min || parsed > RATE_LIMIT_LIMITS.burst.max) {
                      return `Between ${RATE_LIMIT_LIMITS.burst.min} and ${RATE_LIMIT_LIMITS.burst.max.toLocaleString()}, or blank.`;
                    }
                    const limit = Number(getValues('limit'));
                    if (!Number.isFinite(limit)) return true;
                    const issue = rateLimitCoherenceIssues({
                      limit,
                      window_seconds: Number(getValues('window_seconds')),
                      burst: parsed,
                    })[0];
                    return issue ? issue.reason : true;
                  },
                })}
              />
            )}
          </Field>
        </div>

        <p className="text-2xs leading-relaxed text-ink-subtle">
          One policy per scope and resource
          {resourceId ? '' : ' — the every-resource row included'}: a second row for the same pair
          is refused as a conflict, because the data plane would have two answers to one question.
          Update the existing one instead.
        </p>
      </form>
    </Dialog>
  );
}
