import { useEffect, useId, useRef } from 'react';
import { useForm, type UseFormRegister } from 'react-hook-form';
import { Button, Dialog, Field, Input, Select, WriteErrorNotice } from '../../components';
import { classifyWriteError, type ValidationIssue } from '../../lib/api-errors';
import { cn } from '../../lib/cn';
import {
  MAX_EVENT_TYPES_PER_SUBSCRIPTION,
  MAX_SUBSCRIPTION_NAME_LENGTH,
  type CreateSubscriptionBody,
  type Subscription,
  type UpdateSubscriptionBody,
} from '../../types/api';
import { useEndpoints } from '../endpoints/api';
import { useCreateSubscription, useUpdateSubscription } from './api';
import {
  formatEventTypesInput,
  parseEventTypesInput,
  validateEventTypesInput,
} from './event-types';
import {
  formatPayloadFilterInput,
  parsePayloadFilterInput,
  validatePayloadFilterInput,
} from './payload-filter';

/**
 * Create and edit, one form — everything `CreateSubscriptionDto` and
 * `UpdateSubscriptionDto` accept, and nothing they do not.
 *
 * `enabled` is a checkbox ON CREATE ONLY. `UpdateSubscriptionDto` deliberately
 * has no `enabled`: enabling and disabling are their own routes so that
 * pausing a route is a distinct, separately audited act, and a body carrying
 * it is refused by `forbidNonWhitelisted`. `SubscriptionActions` owns those.
 *
 * ## The event-types textarea is where this form earns its keep
 *
 * The server stores a filter EXACTLY as sent or refuses it — never widens it
 * to `*`, never trims, never de-duplicates. `event-types.ts` mirrors the
 * server's validator in the server's own words, so the operator is told
 * "`pay*` would be matched as an exact event type and would never fire" under
 * the textarea before the request is sent, and told the same thing by the
 * server if the mirror is ever stale. A 400 from `EventTypesConstraint` has
 * no `property:` prefix (its message IS the reason, and it begins with
 * `event_types`), so `placeServerIssue` routes it by that prefix.
 *
 * ## The payload filter is inert, and the form says so
 *
 * `payload_filter` is validated and stored, and the data plane does not
 * evaluate it yet. A form that offered the field without saying so would let
 * someone believe a filter was keeping data away from an endpoint.
 */
type FormValues = {
  name: string;
  endpoint_id: string;
  /** One pattern per line, or comma-separated — see `parseEventTypesInput`. */
  event_types: string;
  /** JSON text, or blank for no filter. */
  payload_filter: string;
  enabled: boolean;
};

/** Property names the server may name in a 400, mapped to this form's fields. */
const SERVER_FIELDS: readonly (keyof FormValues)[] = [
  'name',
  'endpoint_id',
  'event_types',
  'payload_filter',
  'enabled',
];

function toFormValues(subscription: Subscription | null): FormValues {
  if (!subscription) {
    return { name: '', endpoint_id: '', event_types: '', payload_filter: '', enabled: true };
  }
  return {
    name: subscription.name ?? '',
    endpoint_id: subscription.endpoint_id,
    event_types: formatEventTypesInput(subscription.event_types),
    payload_filter: formatPayloadFilterInput(subscription.payload_filter),
    enabled: subscription.enabled,
  };
}

function toCreateBody(values: FormValues): CreateSubscriptionBody {
  const body: CreateSubscriptionBody = {
    endpoint_id: values.endpoint_id,
    event_types: parseEventTypesInput(values.event_types),
  };
  const name = values.name.trim();
  if (name) body.name = name;
  const filter = parsePayloadFilterInput(values.payload_filter);
  if (filter.ok && filter.value !== null) body.payload_filter = filter.value;
  // The server defaults to true; only say so when the operator chose otherwise.
  if (!values.enabled) body.enabled = false;
  return body;
}

/**
 * Only what changed. Restating `endpoint_id` re-runs the deleted-endpoint
 * check against a value nobody touched, and restating `event_types` writes an
 * audit entry saying the filter changed when it did not.
 */
function changedFields(before: FormValues, after: FormValues): UpdateSubscriptionBody | null {
  const body: UpdateSubscriptionBody = {};
  if (after.name.trim() !== before.name) {
    // Null CLEARS the name; an empty string would be stored as a name.
    body.name = after.name.trim() || null;
  }
  if (after.endpoint_id !== before.endpoint_id) body.endpoint_id = after.endpoint_id;
  if (after.event_types !== before.event_types) {
    body.event_types = parseEventTypesInput(after.event_types);
  }
  if (after.payload_filter !== before.payload_filter) {
    const filter = parsePayloadFilterInput(after.payload_filter);
    if (filter.ok) body.payload_filter = filter.value;
  }
  return Object.keys(body).length === 0 ? null : body;
}

/**
 * Which input a server rejection belongs under.
 *
 * `EventTypesConstraint.defaultMessage` returns the bare reason, which
 * `classifyWriteError` cannot split into `{ field, reason }` because there is
 * no `property:` prefix. The reason always begins with `event_types`, though,
 * so it is routed by that.
 */
function placeServerIssue(issue: ValidationIssue): keyof FormValues | null {
  const named = SERVER_FIELDS.find((candidate) => candidate === issue.field);
  if (named) return named;
  if (issue.field === null && /^event_types\b/.test(issue.message)) return 'event_types';
  return null;
}

export function SubscriptionFormDialog({
  projectId,
  subscription,
  onClose,
}: {
  projectId: string;
  /** Null creates; a row edits it. */
  subscription: Subscription | null;
  onClose: () => void;
}) {
  // A per-instance id, not a literal. A dialog can be mounted more than once
  // on a page (the switcher and the empty state both own a create dialog), and
  // a footer button's `form` attribute binds to the FIRST element with that
  // id in the document - which was the other, closed dialog's form, whose
  // validation failed on empty fields and never sent a request.
  const formId = useId();
  const editing = subscription !== null;
  const create = useCreateSubscription(projectId);
  const update = useUpdateSubscription(projectId, subscription?.id ?? '');
  const mutation = editing ? update : create;
  const endpoints = useEndpoints(projectId);
  const initial = toFormValues(subscription);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: initial });
  const errorRef = useRef<HTMLDivElement>(null);
  const claimed = SERVER_FIELDS.filter((field) => errors[field]);

  // Focus the panel only when the failure belongs to no single input; when the
  // server named a field, `onError` already put the caret there.
  useEffect(() => {
    if (mutation.isError && claimed.length === 0) errorRef.current?.focus();
  }, [mutation.isError, claimed.length]);

  const onError = (error: unknown, body: { endpoint_id?: string }) => {
    const failure = classifyWriteError(error);
    // "That endpoint has been deleted" is a 409 about ONE field.
    if (failure.kind === 'conflict' && body.endpoint_id !== undefined) {
      setError('endpoint_id', { type: 'server', message: failure.message });
      setFocus('endpoint_id');
      return;
    }
    if (failure.kind !== 'invalid') return;
    let focused = false;
    for (const issue of failure.issues) {
      const field = placeServerIssue(issue);
      if (!field) continue;
      setError(field, { type: 'server', message: issue.reason });
      if (!focused) {
        setFocus(field);
        focused = true;
      }
    }
  };

  const onSubmit = handleSubmit(
    (values) => {
      if (editing) {
        const body = changedFields(initial, values);
        if (!body) {
          onClose();
          return;
        }
        update.mutate(body, { onSuccess: onClose, onError: (error) => onError(error, body) });
        return;
      }
      const body = toCreateBody(values);
      create.mutate(body, { onSuccess: onClose, onError: (error) => onError(error, body) });
    },
    () => {
      const first = SERVER_FIELDS.find((field) => errors[field]);
      if (first) setFocus(first);
    },
  );

  const eventTypesInvalid = Boolean(errors.event_types);
  const filterInvalid = Boolean(errors.payload_filter);

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? 'Edit subscription' : 'New subscription'}
      description={
        editing
          ? (subscription.name ?? subscription.id)
          : 'Bind an endpoint to the event types it should receive. The filter is stored exactly as written, or refused.'
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
            {editing ? 'Save changes' : 'Create subscription'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={mutation.error} claimedFields={claimed} />
        </div>

        <Field
          label="Name"
          error={errors.name?.message}
          hint="For people reading the list. Optional; leave it blank for an unnamed subscription."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="Finance ledger — settlements only"
              {...register('name', {
                maxLength: {
                  value: MAX_SUBSCRIPTION_NAME_LENGTH,
                  message: `At most ${MAX_SUBSCRIPTION_NAME_LENGTH} characters.`,
                },
              })}
            />
          )}
        </Field>

        <EndpointField
          endpoints={endpoints}
          currentId={subscription?.endpoint_id ?? null}
          error={errors.endpoint_id?.message}
          register={register}
        />

        <Field
          label="Event types"
          required
          error={errors.event_types?.message}
          hint={
            <>
              One per line, or comma-separated. Three forms only: <code className="font-mono">*</code>{' '}
              (everything, on its own), <code className="font-mono">payment.*</code> (every type
              beginning with the literal <code className="font-mono">payment.</code>) or an exact
              type such as <code className="font-mono">payment.settled</code>. Anything else is
              refused — never widened to <code className="font-mono">*</code>. Up to{' '}
              {MAX_EVENT_TYPES_PER_SUBSCRIPTION}.
              {editing && ' Saving replaces the whole list.'}
            </>
          }
        >
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              rows={4}
              spellCheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              placeholder={'payment.settled\npayment.refunded\npayout.*'}
              className={textareaClass(invalid || eventTypesInvalid)}
              {...register('event_types', { validate: validateEventTypesInput })}
            />
          )}
        </Field>

        <Field
          label="Payload filter"
          error={errors.payload_filter?.message}
          hint={
            <>
              Optional JSON predicate over the event body, applied after the event types match.
              Implicit AND over field paths; <code className="font-mono">$and</code>/
              <code className="font-mono">$or</code>/<code className="font-mono">$not</code> combine;{' '}
              <code className="font-mono">$eq $ne $gt $gte $lt $lte $in $nin $exists</code> compare.
              Blank means no filter{editing && ', and blanking it clears the stored one'}.
            </>
          }
        >
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              rows={4}
              spellCheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              placeholder={'{ "data.currency": "GHS", "data.amount": { "$gte": 1000 } }'}
              className={textareaClass(invalid || filterInvalid)}
              {...register('payload_filter', { validate: validatePayloadFilterInput })}
            />
          )}
        </Field>

        <p
          role="note"
          className="rounded-md border border-warn/30 bg-warn-soft/50 px-3 py-2 text-2xs leading-relaxed text-warn"
        >
          <strong className="font-semibold">Payload filters are not evaluated yet.</strong> The
          data plane matches on event type only, so a subscription with a filter currently
          receives every event its event types match. The filter is validated and stored now so it
          means the same thing when evaluation lands. Do not rely on it to keep data away from an
          endpoint.
        </p>

        {editing ? (
          <p className="text-2xs leading-relaxed text-ink-subtle">
            Enabling and disabling are not on this form. They have their own routes so that
            pausing a route is a separately audited act rather than a field riding along in a
            rename — use the controls next to the subscription’s state.
          </p>
        ) : (
          <label className="flex items-start gap-2 text-xs text-ink-muted">
            <input type="checkbox" className="mt-0.5" {...register('enabled')} />
            <span>
              <span className="font-medium text-ink">Enabled</span> — start matching events as
              soon as it is created. Untick to create it paused; a disabled subscription matches
              nothing at all until it is enabled.
            </span>
          </label>
        )}
      </form>
    </Dialog>
  );
}

function textareaClass(invalid: boolean): string {
  return cn(
    'w-full rounded-md border bg-panel px-2.5 py-1.5 font-mono text-xs text-ink',
    'placeholder:text-ink-subtle transition-colors',
    invalid ? 'border-danger' : 'border-line hover:border-line-strong',
  );
}

/**
 * The endpoint, as a picker over the endpoints THIS PROJECT owns.
 *
 * `endpoint_id` is resolved through the tenant scope, so an id from another
 * project answers 404 with the same message as one that does not exist; a
 * picker makes that mistake unreachable. Deleted endpoints are excluded because
 * the service refuses them with a 409 — offering one would be offering a
 * refusal. The one page this reads may not hold the endpoint an existing
 * subscription points at, so that id is kept as an explicit option: a select
 * that quietly lacks the saved value would re-point the subscription on the
 * next save.
 */
function EndpointField({
  endpoints,
  currentId,
  error,
  register,
}: {
  endpoints: ReturnType<typeof useEndpoints>;
  currentId: string | null;
  error?: string;
  register: UseFormRegister<FormValues>;
}) {
  const rows = (endpoints.data?.rows ?? []).filter((endpoint) => endpoint.status !== 'deleted');
  const registration = register('endpoint_id', { required: 'Choose an endpoint.' });

  if (endpoints.isPending) {
    return (
      <Field label="Endpoint" required hint="Loading this project’s endpoints…">
        {({ id }) => (
          <Select id={id} disabled options={[]} placeholder="Loading…" aria-busy="true" />
        )}
      </Field>
    );
  }

  if (endpoints.isError) {
    return (
      <Field
        label="Endpoint"
        required
        error={error ?? 'This project’s endpoints could not be loaded. Paste the endpoint id.'}
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            mono
            placeholder="ep_…"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...registration}
          />
        )}
      </Field>
    );
  }

  if (rows.length === 0 && currentId === null) {
    return (
      <Field
        label="Endpoint"
        required
        error={error}
        hint="This project has no endpoints, so there is nothing to subscribe. Add an endpoint first — a subscription is a route TO something."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            disabled
            aria-describedby={describedBy}
            options={[]}
            placeholder="No endpoints in this project"
            {...registration}
          />
        )}
      </Field>
    );
  }

  const missing = currentId !== null && !rows.some((endpoint) => endpoint.id === currentId);

  return (
    <Field
      label="Endpoint"
      required
      error={error}
      hint="Only endpoints in this project. A deleted endpoint is refused — a subscription pointed at it could never deliver."
    >
      {({ id, describedBy, invalid }) => (
        <Select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          placeholder="Choose an endpoint"
          options={[
            ...rows.map((endpoint) => ({
              value: endpoint.id,
              label: `${endpoint.name} — ${endpoint.url}${endpoint.status === 'active' ? '' : ` (${endpoint.status})`}`,
            })),
            ...(missing ? [{ value: currentId, label: `${currentId} — not on this page` }] : []),
          ]}
          {...registration}
        />
      )}
    </Field>
  );
}
