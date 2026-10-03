import { ApiRequestError } from '../../lib/api';
import { classifyWriteError } from '../../lib/api-errors';

/**
 * Putting a policy write's rejection under the input that caused it.
 *
 * The policy routes refuse a body in TWO shapes, and a form has to place both:
 *
 *   1. The global `ValidationPipe` — an ARRAY at `error.message`, one
 *      `"<property>: <reason>"` per rejected field. `classifyWriteError`
 *      already splits that into `{ field, reason }` issues.
 *   2. The service's own `AppError('invalid_request', message, { field })` —
 *      the cross-field rules (`initial_delay_ms` above `max_delay_ms`, an
 *      exponential `multiplier` of 1, `burst` below `limit`, a stale
 *      `resource_id` on a scope change, `replacement_id` where it is not
 *      accepted). The message is ONE sentence with no property prefix, and the
 *      field is in `details.field`. Left to the panel above the form, that
 *      reads as a paragraph next to the submit button — which is exactly what
 *      the pipe's array was kept structured to avoid.
 *
 * `details` is typed open (`[key: string]: unknown`) by the schema, so
 * `field` is read defensively rather than assumed.
 */
export function fieldNamedByServer(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  const field = error.body.details?.field;
  return typeof field === 'string' && field.length > 0 ? field : null;
}

/**
 * Places every rejection the form can, focusing the first, and returns the
 * fields it claimed so `WriteErrorNotice` can render only what is left.
 */
export function placeServerErrors<F extends string>(
  error: unknown,
  fields: readonly F[],
  setError: (field: F, error: { type: string; message: string }) => void,
  setFocus: (field: F) => void,
): F[] {
  const failure = classifyWriteError(error);
  if (failure.kind !== 'invalid') return [];

  const claimed: F[] = [];
  const claim = (field: F, message: string) => {
    setError(field, { type: 'server', message });
    if (claimed.length === 0) setFocus(field);
    claimed.push(field);
  };

  for (const issue of failure.issues) {
    const field = fields.find((candidate) => candidate === issue.field);
    if (field) claim(field, issue.reason);
  }

  // The service-level shape: one sentence, field in `details`.
  if (claimed.length === 0) {
    const named = fieldNamedByServer(error);
    const field = fields.find((candidate) => candidate === named);
    if (field) claim(field, failure.message);
  }

  return claimed;
}

/** A 403 — rendered as `PermissionDenied` naming the roles, never as "request failed". */
export function isForbidden(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    (error.status === 403 || error.body.code === 'forbidden')
  );
}
