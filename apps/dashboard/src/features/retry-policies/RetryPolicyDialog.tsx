import { useEffect, useId, useRef } from 'react';
import { useForm } from 'react-hook-form';
import {
  Button,
  Dialog,
  Field,
  Input,
  PermissionDenied,
  Select,
  WriteErrorNotice,
} from '../../components';
import {
  MAX_RETRY_POLICY_NAME_LENGTH,
  RETRY_POLICY_LIMITS,
  RETRY_STRATEGIES,
  type CreateRetryPolicyBody,
  type RetryPolicy,
  type RetryStrategy,
  type Role,
  type UpdateRetryPolicyBody,
} from '../../types/api';
import { POLICY_WRITE_ROLES } from '../policies/permissions';
import { isForbidden, placeServerErrors } from '../policies/write-errors';
import { formatMs, useCreateRetryPolicy, useUpdateRetryPolicy } from './api';
import {
  DEFAULT_RETRY_SETTINGS,
  retryPolicyCoherenceIssues,
  retrySchedule,
  settingsOf,
  type RetrySettings,
  type RetrySettingsField,
} from './retry-policy-rules';

/**
 * Creating or editing a retry policy — every field `CreateRetryPolicyDto`
 * accepts, and on edit everything `UpdateRetryPolicyDto` does, which is the
 * same set minus `is_default`.
 *
 * `is_default` is a checkbox on CREATE only. On edit it is not a field at all,
 * because the API does not accept it there: "exactly one default per project"
 * is a property of a set of rows, held by a SERIALIZABLE clear-then-set on
 * `POST …/default`, and a patchable flag would be a second writer that skips
 * the clear. The table's "Make default" action is that route.
 *
 * ## Three kinds of rejection, and where each is shown
 *
 *   - Per-field BOUNDS: `min`/`max` here, with a message that says WHY the
 *     bound exists, because "must be at least 1" teaches nothing and "0 means
 *     no cap downstream" does.
 *   - CROSS-FIELD rules (`initial_delay_ms` above `max_delay_ms`, a budget
 *     shorter than the first delay, an exponential multiplier of 1): mirrored
 *     from the server in `retry-policy-rules.ts`, run as `validate` on the
 *     field the server would name, with `deps` so fixing the other half of the
 *     pair re-checks this one.
 *   - What the server still refuses: a 400 whose reason is placed under the
 *     input it names — both the pipe's `"field: reason"` array and the
 *     service's `details.field` shape — and anything else in the panel above.
 *
 * The schedule preview under the numbers is the dialog's reason to exist: an
 * operator choosing between "5s ×2 up to 1h" and "linear +1m" is choosing a
 * curve, and the numbers alone do not show one.
 */
type FormValues = {
  name: string;
  is_default: boolean;
  strategy: RetryStrategy;
  max_attempts: number;
  initial_delay_ms: number;
  max_delay_ms: number;
  multiplier: number;
  jitter_ratio: number;
  max_retry_duration_ms: number;
};

const SETTINGS_FIELDS: readonly RetrySettingsField[] = [
  'strategy',
  'max_attempts',
  'initial_delay_ms',
  'max_delay_ms',
  'multiplier',
  'jitter_ratio',
  'max_retry_duration_ms',
];

/** Property names the server may name in a 400, mapped to this form's fields. */
const SERVER_FIELDS: readonly (keyof FormValues)[] = ['name', 'is_default', ...SETTINGS_FIELDS];

function toFormValues(policy: RetryPolicy | undefined): FormValues {
  if (!policy) return { name: '', is_default: false, ...DEFAULT_RETRY_SETTINGS };
  return { name: policy.name, is_default: policy.is_default, ...settingsOf(policy) };
}

/** The settings half of the form, or null while a number field is empty. */
function settingsFrom(values: FormValues): RetrySettings | null {
  const settings: RetrySettings = {
    strategy: values.strategy,
    max_attempts: Number(values.max_attempts),
    initial_delay_ms: Number(values.initial_delay_ms),
    max_delay_ms: Number(values.max_delay_ms),
    multiplier: Number(values.multiplier),
    jitter_ratio: Number(values.jitter_ratio),
    max_retry_duration_ms: Number(values.max_retry_duration_ms),
  };
  for (const field of SETTINGS_FIELDS) {
    if (field !== 'strategy' && !Number.isFinite(settings[field])) return null;
  }
  return settings;
}

/**
 * Only what changed. The server validates the MERGED settings either way, so
 * sending the diff costs nothing in safety — and it keeps a rename a rename
 * in the audit row's `fields` list rather than "every field".
 */
function changedFields(before: FormValues, after: FormValues): UpdateRetryPolicyBody | null {
  const body: UpdateRetryPolicyBody = {};
  if (after.name.trim() !== before.name) body.name = after.name.trim();
  if (after.strategy !== before.strategy) body.strategy = after.strategy;
  for (const field of SETTINGS_FIELDS) {
    if (field === 'strategy') continue;
    if (Number(after[field]) !== before[field]) body[field] = Number(after[field]);
  }
  return Object.keys(body).length === 0 ? null : body;
}

export function RetryPolicyDialog({
  projectId,
  policy,
  hasDefault,
  currentRole,
  onClose,
}: {
  projectId: string;
  /** Absent for create. */
  policy?: RetryPolicy;
  /** Whether the project already has a default — the first policy becomes it regardless. */
  hasDefault: boolean;
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
  const create = useCreateRetryPolicy(projectId);
  const update = useUpdateRetryPolicy(projectId, policy?.id ?? '');
  const mutation = editing ? update : create;
  const initial = toFormValues(policy);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    getValues,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: initial });
  const errorRef = useRef<HTMLDivElement>(null);
  const claimed = SERVER_FIELDS.filter((field) => errors[field]);

  useEffect(() => {
    if (mutation.isError && claimed.length === 0) errorRef.current?.focus();
  }, [mutation.isError, claimed.length]);

  /** The cross-field rule for one field, against the whole form as it stands. */
  const coherence = (field: RetrySettingsField) => () => {
    const settings = settingsFrom(getValues());
    if (!settings) return true;
    const issue = retryPolicyCoherenceIssues(settings).find((candidate) => candidate.field === field);
    return issue ? issue.reason : true;
  };

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
      const settings = settingsFrom(values);
      if (!settings) return;
      const body: CreateRetryPolicyBody = { name: values.name.trim(), ...settings };
      // Only sent when ticked: the server promotes the first policy itself,
      // and an explicit `false` is not the same statement as "no opinion".
      if (values.is_default) body.is_default = true;
      create.mutate(body, { onSuccess: onClose, onError });
    },
    () => {
      const first = SERVER_FIELDS.find((field) => errors[field]);
      if (first) setFocus(first);
    },
  );

  const watched = watch();
  const strategy = watched.strategy;

  if (isForbidden(mutation.error)) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={editing ? 'Edit retry policy' : 'Create retry policy'}
        footer={<Button onClick={onClose}>Close</Button>}
      >
        <PermissionDenied
          action={editing ? 'edit a retry policy' : 'create a retry policy'}
          requiredRoles={[...POLICY_WRITE_ROLES]}
          currentRole={currentRole}
          error={mutation.error}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? 'Edit retry policy' : 'Create retry policy'}
      description={
        editing
          ? policy.name
          : 'The backoff curve the delivery workers run for endpoints that choose this policy.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={mutation.isPending}
          >
            {editing ? 'Save changes' : 'Create policy'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={mutation.error} claimedFields={claimed} />
        </div>

        <Field label="Name" required error={errors.name?.message}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="Patient partners"
              {...register('name', {
                required: 'A name is required.',
                validate: (value) => value.trim().length > 0 || 'A name is required.',
                maxLength: {
                  value: MAX_RETRY_POLICY_NAME_LENGTH,
                  message: `At most ${MAX_RETRY_POLICY_NAME_LENGTH} characters.`,
                },
              })}
            />
          )}
        </Field>

        {!editing && (
          <label className="flex items-start gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 rounded border-line accent-accent"
              {...register('is_default')}
            />
            <span>
              <span className="font-medium text-ink">Make this the project default</span>
              <span className="block text-2xs leading-relaxed text-ink-subtle">
                {hasDefault
                  ? 'Clears the current default in the same transaction. Endpoints without their own policy start using this one for deliveries created from now on.'
                  : 'This project has no policies yet, so the first one becomes the default whether or not this is ticked — a project with policies and no default is a state nothing can resolve.'}
              </span>
            </span>
          </label>
        )}

        <Field
          label="Strategy"
          error={errors.strategy?.message}
          hint="exponential multiplies the previous delay by the multiplier; linear adds the initial delay each time; constant repeats it."
        >
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              options={RETRY_STRATEGIES.map((value) => ({ value, label: value }))}
              {...register('strategy', { deps: ['multiplier'] })}
            />
          )}
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Max attempts"
            error={errors.max_attempts?.message}
            hint={`Total attempts INCLUDING the first delivery. ${RETRY_POLICY_LIMITS.max_attempts.min}–${RETRY_POLICY_LIMITS.max_attempts.max}.`}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('max_attempts', {
                  valueAsNumber: true,
                  required: 'An attempt count is required.',
                  deps: ['max_retry_duration_ms'],
                  min: {
                    value: RETRY_POLICY_LIMITS.max_attempts.min,
                    message: 'At least 1 — attempt 1 is the first delivery, and 0 means "no cap" to the workers.',
                  },
                  max: {
                    value: RETRY_POLICY_LIMITS.max_attempts.max,
                    message: `At most ${RETRY_POLICY_LIMITS.max_attempts.max}.`,
                  },
                  validate: (value) => Number.isInteger(value) || 'Whole numbers only.',
                })}
              />
            )}
          </Field>

          <Field
            label="Retry budget (ms)"
            error={errors.max_retry_duration_ms?.message}
            hint="Wall-clock budget from the first attempt. Time spent deferred (open breaker, rate limit) counts. 1 second to 7 days."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('max_retry_duration_ms', {
                  valueAsNumber: true,
                  required: 'A budget is required.',
                  deps: ['initial_delay_ms'],
                  min: {
                    value: RETRY_POLICY_LIMITS.max_retry_duration_ms.min,
                    message: 'At least 1000 ms — 0 means "no budget cap" to the workers, and eight attempts with an hour ceiling would keep a dead endpoint hot for days.',
                  },
                  max: {
                    value: RETRY_POLICY_LIMITS.max_retry_duration_ms.max,
                    message: 'At most 7 days (604 800 000 ms) — the column is a PostgreSQL integer, so 30 days would wrap.',
                  },
                  validate: {
                    integer: (value) => Number.isInteger(value) || 'Whole milliseconds only.',
                    coherent: coherence('max_retry_duration_ms'),
                  },
                })}
              />
            )}
          </Field>

          <Field
            label="Initial delay (ms)"
            error={errors.initial_delay_ms?.message}
            hint="Wait before the FIRST retry. Must not exceed the max delay, or every retry is clamped to the ceiling and the strategy does nothing."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('initial_delay_ms', {
                  valueAsNumber: true,
                  required: 'An initial delay is required.',
                  deps: ['max_delay_ms', 'max_retry_duration_ms'],
                  min: {
                    value: RETRY_POLICY_LIMITS.initial_delay_ms.min,
                    message: 'At least 1 ms — a 0 ms first delay is an immediate re-attempt on every retry, a tight loop against an endpoint that is already failing.',
                  },
                  max: {
                    value: RETRY_POLICY_LIMITS.initial_delay_ms.max,
                    message: 'At most 1 day (86 400 000 ms).',
                  },
                  validate: {
                    integer: (value) => Number.isInteger(value) || 'Whole milliseconds only.',
                    coherent: coherence('initial_delay_ms'),
                  },
                })}
              />
            )}
          </Field>

          <Field
            label="Max delay (ms)"
            error={errors.max_delay_ms?.message}
            hint="Ceiling on any computed delay. Must be positive: an unset ceiling once let the exponential term overflow and schedule retries permanently in the past."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('max_delay_ms', {
                  valueAsNumber: true,
                  required: 'A max delay is required.',
                  deps: ['initial_delay_ms'],
                  min: {
                    value: RETRY_POLICY_LIMITS.max_delay_ms.min,
                    message: 'At least 1 ms — a 0 ceiling is the value that overflowed the workers’ delay arithmetic to a negative duration.',
                  },
                  max: {
                    value: RETRY_POLICY_LIMITS.max_delay_ms.max,
                    message: 'At most 1 day (86 400 000 ms).',
                  },
                  validate: (value) => Number.isInteger(value) || 'Whole milliseconds only.',
                })}
              />
            )}
          </Field>

          <Field
            label="Multiplier"
            error={errors.multiplier?.message}
            hint={
              strategy === 'exponential'
                ? 'Growth factor per retry. Must be greater than 1: the workers replace any multiplier of 1 or less with 2, so a stored 1 would not describe what happens.'
                : `Read by the exponential strategy only — the workers ignore it for ${strategy}.`
            }
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="decimal"
                step="any"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('multiplier', {
                  valueAsNumber: true,
                  required: 'A multiplier is required.',
                  min: {
                    value: RETRY_POLICY_LIMITS.multiplier.min,
                    message: `At least ${RETRY_POLICY_LIMITS.multiplier.min}.`,
                  },
                  max: {
                    value: RETRY_POLICY_LIMITS.multiplier.max,
                    message: 'At most 100 — above that the sequence hits the max delay on the second retry and every other field is decorative.',
                  },
                  validate: {
                    finite: (value) => Number.isFinite(value) || 'A number is required.',
                    coherent: coherence('multiplier'),
                  },
                })}
              />
            )}
          </Field>

          <Field
            label="Jitter ratio"
            error={errors.jitter_ratio?.message}
            hint="Symmetric jitter as a fraction of the computed delay (0 to 1), so a thousand deliveries to one recovering endpoint do not stampede in lockstep."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="decimal"
                step="any"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('jitter_ratio', {
                  valueAsNumber: true,
                  required: 'A jitter ratio is required.',
                  min: {
                    value: RETRY_POLICY_LIMITS.jitter_ratio.min,
                    message: 'At least 0.',
                  },
                  max: {
                    value: RETRY_POLICY_LIMITS.jitter_ratio.max,
                    message: 'At most 1 — above that the jittered delay goes negative and is clamped to zero, which is the stampede again by another route.',
                  },
                  validate: (value) => Number.isFinite(value) || 'A number is required.',
                })}
              />
            )}
          </Field>
        </div>

        <SchedulePreview values={watched} />

        {editing && (
          <p className="text-2xs leading-relaxed text-ink-subtle">
            Whether this policy is the project default is not on this form. Moving the default
            clears the previous one inside a single transaction, so it has its own action in the
            table. Deliveries already fanned out keep the attempt budget stamped on their row; the
            change applies to deliveries created from now on.
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * What the policy DOES: the wait before each retry, as the workers compute it
 * (jitter aside), and whether the wall-clock budget cuts the chain short.
 *
 * `aria-live="polite"` so a screen-reader user editing the numbers hears the
 * curve change without moving focus; `aria-atomic` so it reads as one
 * sentence rather than a diff.
 */
function SchedulePreview({ values }: { values: FormValues }) {
  const settings = settingsFrom(values);
  if (!settings || retryPolicyCoherenceIssues(settings).length > 0) return null;

  const schedule = retrySchedule(settings, 8);
  const waits = schedule.delays.map(formatMs).join(', ');

  return (
    <p
      aria-live="polite"
      aria-atomic="true"
      className="rounded-md border border-line bg-raised/50 px-3 py-2 text-2xs leading-relaxed text-ink-muted"
    >
      {settings.max_attempts === 1 ? (
        <>
          <strong className="font-semibold text-ink">No retries.</strong> One attempt, then the
          delivery is final either way.
        </>
      ) : (
        <>
          <strong className="font-semibold text-ink">Retries after</strong> {waits}
          {schedule.truncated ? ', …' : ''} — {settings.max_attempts - 1} retr
          {settings.max_attempts === 2 ? 'y' : 'ies'} after the first delivery, jitter aside.
          {schedule.exhaustedAt !== null && (
            <>
              {' '}
              <strong className="font-semibold text-warn">
                The {formatMs(settings.max_retry_duration_ms)} budget runs out before attempt{' '}
                {schedule.exhaustedAt}
              </strong>
              , so later attempts never happen; the delivery ends exhausted on the budget rather
              than on the attempt count.
            </>
          )}
        </>
      )}
    </p>
  );
}
