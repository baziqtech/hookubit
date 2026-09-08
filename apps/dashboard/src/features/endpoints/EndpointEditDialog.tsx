import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Dialog, Field, Input, WriteErrorNotice } from '../../components';
import { classifyWriteError } from '../../lib/api-errors';
import { cn } from '../../lib/cn';
import {
  ENDPOINT_LIMITS,
  MAX_ENDPOINT_DESCRIPTION_LENGTH,
  MAX_ENDPOINT_NAME_LENGTH,
  MAX_ENDPOINT_URL_LENGTH,
  type Endpoint,
  type UpdateEndpointBody,
} from '../../types/api';
import { useUpdateEndpoint } from './api';
import { formatCustomHeaders, parseCustomHeaders } from './custom-headers';

/**
 * Editing an endpoint — everything `UpdateEndpointDto` accepts, and nothing it
 * does not.
 *
 * `status` is absent because it is not in the DTO: enabling, disabling and
 * deleting are separate routes, each with a precondition a PATCH would walk
 * past. `EndpointActions` owns those. A dropdown here would be an input whose
 * value the server refuses.
 *
 * ## The two rejections this form exists to render properly
 *
 * The URL and the custom headers are validated server-side on UPDATE with the
 * same rules as on create — the SSRF usability mirror and the reserved-header
 * list — and both come back as a 400 whose `error.message` is the ARRAY of
 * per-property messages the validation pipe produced. Shown as one generic
 * "request failed", they are useless: the operator has changed six fields and
 * is told only that something is wrong. `classifyWriteError` parses each entry
 * into `{ field, reason }` and this form puts the reason under the input that
 * caused it, so `url: loopback address` lands beneath the URL box.
 */
type FormValues = {
  name: string;
  url: string;
  description: string;
  timeout_ms: number;
  max_concurrency: number;
  /** Empty string means "no per-endpoint limit" — sent as null, not omitted. */
  rate_limit: string;
  rate_limit_window_seconds: number;
  retry_policy_id: string;
  custom_headers: string;
};

function toFormValues(endpoint: Endpoint): FormValues {
  return {
    name: endpoint.name,
    url: endpoint.url,
    description: endpoint.description ?? '',
    timeout_ms: endpoint.timeout_ms,
    max_concurrency: endpoint.max_concurrency,
    rate_limit: endpoint.rate_limit === null ? '' : String(endpoint.rate_limit),
    rate_limit_window_seconds: endpoint.rate_limit_window_seconds,
    retry_policy_id: endpoint.retry_policy_id ?? '',
    custom_headers: formatCustomHeaders(endpoint.custom_headers),
  };
}

/**
 * Only what changed.
 *
 * A PATCH that restates every field is not the same request: it re-runs the
 * URL check and the header check against values the operator did not touch, so
 * an endpoint saved before a rule tightened could no longer be renamed. Sending
 * the diff keeps an edit to one field an edit to one field.
 */
function changedFields(before: FormValues, after: FormValues): UpdateEndpointBody | null {
  const body: UpdateEndpointBody = {};

  if (after.name !== before.name) body.name = after.name.trim();
  if (after.url !== before.url) body.url = after.url.trim();
  if (after.description !== before.description) body.description = after.description.trim();
  if (Number(after.timeout_ms) !== before.timeout_ms) body.timeout_ms = Number(after.timeout_ms);
  if (Number(after.max_concurrency) !== before.max_concurrency) {
    body.max_concurrency = Number(after.max_concurrency);
  }
  if (after.rate_limit !== before.rate_limit) {
    body.rate_limit = after.rate_limit.trim() === '' ? null : Number(after.rate_limit);
  }
  if (Number(after.rate_limit_window_seconds) !== before.rate_limit_window_seconds) {
    body.rate_limit_window_seconds = Number(after.rate_limit_window_seconds);
  }
  if (after.retry_policy_id !== before.retry_policy_id) {
    body.retry_policy_id = after.retry_policy_id.trim() === '' ? null : after.retry_policy_id.trim();
  }
  if (after.custom_headers !== before.custom_headers) {
    const parsed = parseCustomHeaders(after.custom_headers);
    // Guarded by the field validator before submit; this is the type narrowing.
    if (parsed.ok) body.custom_headers = parsed.headers;
  }

  return Object.keys(body).length === 0 ? null : body;
}

/** Property names the server may name in a 400, mapped to this form's fields. */
const SERVER_FIELDS: readonly (keyof FormValues)[] = [
  'name',
  'url',
  'description',
  'timeout_ms',
  'max_concurrency',
  'rate_limit',
  'rate_limit_window_seconds',
  'retry_policy_id',
  'custom_headers',
];

export function EndpointEditDialog({
  endpoint,
  projectId,
  onClose,
}: {
  endpoint: Endpoint;
  projectId: string;
  onClose: () => void;
}) {
  const update = useUpdateEndpoint(projectId, endpoint.id);
  const initial = toFormValues(endpoint);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: initial });
  const errorRef = useRef<HTMLDivElement>(null);
  const claimed = SERVER_FIELDS.filter((field) => errors[field]);

  /*
   * A failure that is not attributable to one input still has to take focus, or
   * a screen-reader user is left on a submit button whose label never changed
   * while the reason sits above it unread.
   *
   * But ONLY then. When the server named a field, `onError` has already put the
   * caret in that input, and this would immediately take it back out to a panel
   * that — by design — is rendering nothing at all.
   */
  useEffect(() => {
    if (update.isError && claimed.length === 0) errorRef.current?.focus();
  }, [update.isError, claimed.length]);

  const onSubmit = handleSubmit(
    (values) => {
      const body = changedFields(initial, values);
      if (!body) {
        onClose();
        return;
      }
      update.mutate(body, {
        onSuccess: onClose,
        onError: (error) => {
          const failure = classifyWriteError(error);
          if (failure.kind !== 'invalid') return;
          // Put each server rejection under the input that caused it. The first
          // one takes focus; anything the server named that this form does not
          // render stays in the panel above rather than vanishing.
          let focused = false;
          for (const issue of failure.issues) {
            const field = SERVER_FIELDS.find((candidate) => candidate === issue.field);
            if (!field) continue;
            setError(field, { type: 'server', message: issue.reason });
            if (!focused) {
              setFocus(field);
              focused = true;
            }
          }
        },
      });
    },
    () => {
      // Client-side rejection: focus the first field the user has to fix.
      const first = SERVER_FIELDS.find((field) => errors[field]);
      if (first) setFocus(first);
    },
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Edit endpoint"
      description={endpoint.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="edit-endpoint-form"
            variant="primary"
            loading={update.isPending}
          >
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-endpoint-form" onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={update.error} claimedFields={claimed} />
        </div>

        <Field label="Name" required error={errors.name?.message}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...register('name', {
                required: 'A name is required.',
                maxLength: {
                  value: MAX_ENDPOINT_NAME_LENGTH,
                  message: `At most ${MAX_ENDPOINT_NAME_LENGTH} characters.`,
                },
              })}
            />
          )}
        </Field>

        <Field
          label="URL"
          required
          error={errors.url?.message}
          hint="http or https. Credentials in the URL, and literal private, loopback, link-local or cloud-metadata addresses, are refused at save time; a hostname is re-checked against the address it resolves to at delivery time."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              mono
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...register('url', {
                required: 'A URL is required.',
                maxLength: {
                  value: MAX_ENDPOINT_URL_LENGTH,
                  message: `At most ${MAX_ENDPOINT_URL_LENGTH} characters.`,
                },
              })}
            />
          )}
        </Field>

        <Field label="Description" error={errors.description?.message}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="What this endpoint is for"
              {...register('description', {
                maxLength: {
                  value: MAX_ENDPOINT_DESCRIPTION_LENGTH,
                  message: `At most ${MAX_ENDPOINT_DESCRIPTION_LENGTH} characters.`,
                },
              })}
            />
          )}
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Timeout (ms)"
            error={errors.timeout_ms?.message}
            hint={`How long one attempt may hold a worker slot. ${ENDPOINT_LIMITS.timeout_ms.min}–${ENDPOINT_LIMITS.timeout_ms.max}.`}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('timeout_ms', {
                  valueAsNumber: true,
                  required: 'A timeout is required.',
                  min: {
                    value: ENDPOINT_LIMITS.timeout_ms.min,
                    message: `At least ${ENDPOINT_LIMITS.timeout_ms.min} ms — a shorter one fails every attempt before the handshake finishes and burns the whole retry budget.`,
                  },
                  max: {
                    value: ENDPOINT_LIMITS.timeout_ms.max,
                    message: `At most ${ENDPOINT_LIMITS.timeout_ms.max} ms.`,
                  },
                })}
              />
            )}
          </Field>

          <Field
            label="Max concurrency"
            error={errors.max_concurrency?.message}
            hint={`In-flight attempts allowed at once. ${ENDPOINT_LIMITS.max_concurrency.min}–${ENDPOINT_LIMITS.max_concurrency.max}.`}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('max_concurrency', {
                  valueAsNumber: true,
                  required: 'A concurrency is required.',
                  min: {
                    value: ENDPOINT_LIMITS.max_concurrency.min,
                    message: `At least ${ENDPOINT_LIMITS.max_concurrency.min}.`,
                  },
                  max: {
                    value: ENDPOINT_LIMITS.max_concurrency.max,
                    message: `At most ${ENDPOINT_LIMITS.max_concurrency.max}.`,
                  },
                })}
              />
            )}
          </Field>

          <Field
            label="Rate limit"
            error={errors.rate_limit?.message}
            hint="Deliveries per window. Leave blank for no per-endpoint limit."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                placeholder="unlimited"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('rate_limit', {
                  validate: (value) => {
                    if (value.trim() === '') return true;
                    const parsed = Number(value);
                    if (!Number.isInteger(parsed)) return 'Whole numbers only.';
                    if (
                      parsed < ENDPOINT_LIMITS.rate_limit.min ||
                      parsed > ENDPOINT_LIMITS.rate_limit.max
                    ) {
                      return `Between ${ENDPOINT_LIMITS.rate_limit.min} and ${ENDPOINT_LIMITS.rate_limit.max}, or blank for unlimited.`;
                    }
                    return true;
                  },
                })}
              />
            )}
          </Field>

          <Field
            label="Rate limit window (seconds)"
            error={errors.rate_limit_window_seconds?.message}
            hint={`The window the limit above is counted over. ${ENDPOINT_LIMITS.rate_limit_window_seconds.min}–${ENDPOINT_LIMITS.rate_limit_window_seconds.max}.`}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...register('rate_limit_window_seconds', {
                  valueAsNumber: true,
                  required: 'A window is required.',
                  min: {
                    value: ENDPOINT_LIMITS.rate_limit_window_seconds.min,
                    message: 'A window of zero is a division by zero in the refill rate.',
                  },
                  max: {
                    value: ENDPOINT_LIMITS.rate_limit_window_seconds.max,
                    message: `At most ${ENDPOINT_LIMITS.rate_limit_window_seconds.max} seconds.`,
                  },
                })}
              />
            )}
          </Field>
        </div>

        <Field
          label="Custom headers"
          error={errors.custom_headers?.message}
          hint="One per line, as “Name: value”. Webhook-*, Authorization, Host, Content-Length and Transfer-Encoding are reserved — they carry the signature or frame the request, so the platform refuses them."
        >
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              rows={4}
              spellCheck={false}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              placeholder="X-Tenant: shaq-express"
              className={cn(
                'w-full rounded-md border bg-panel px-2.5 py-1.5 font-mono text-xs text-ink',
                'placeholder:text-ink-subtle transition-colors',
                invalid ? 'border-danger' : 'border-line hover:border-line-strong',
              )}
              {...register('custom_headers', {
                validate: (value) => {
                  const parsed = parseCustomHeaders(value);
                  return parsed.ok ? true : parsed.reason;
                },
              })}
            />
          )}
        </Field>

        <Field
          label="Retry policy ID"
          error={errors.retry_policy_id?.message}
          hint="A retry policy in THIS project. Leave blank to use the project default. There is no picker yet — an id from another project answers 404, because the tenant scope resolves it."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              mono
              placeholder="none"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              {...register('retry_policy_id', {
                maxLength: { value: 64, message: 'At most 64 characters.' },
              })}
            />
          )}
        </Field>

        <p className="text-2xs leading-relaxed text-ink-subtle">
          Pausing and resuming are not on this form. They have their own routes because each has a
          precondition an edit would walk past — an endpoint cannot be resumed without a live
          signing secret — so they live next to the endpoint’s status instead.
        </p>
      </form>
    </Dialog>
  );
}
