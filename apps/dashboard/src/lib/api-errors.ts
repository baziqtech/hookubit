/**
 * Telling "slow down" apart from "you have hit a limit" apart from
 * "that one field is wrong".
 *
 * Every write route on the control API carries a `@Throttle`, and creates can
 * additionally fail on a RESOURCE CEILING — organizations per user, projects
 * per organization, endpoints, API keys and subscriptions per project. These
 * are different problems with different remedies and they must not share a
 * message:
 *
 *   - A 429 `rate_limited` is transient. Waiting fixes it. The guard sets a
 *     `Retry-After` header and puts `retry_after_seconds` in `error.details`.
 *   - A ceiling is permanent until the user deletes something or an operator
 *     raises the configured maximum. Waiting does nothing.
 *   - A validation rejection names a FIELD, and belongs under that field.
 *
 * ## `limit_exceeded` now exists — this file no longer reads prose
 *
 * It used to. `ERROR_CODES` in control-api `src/common/errors.ts` had no code
 * for a ceiling, so a ceiling was a 409 `conflict` indistinguishable from "that
 * slug is already taken" except by matching the sentence, and only two of the
 * four ceilings attached `details`. Both halves of that are fixed: the code
 * exists, and every ceiling raises it with `{ limit, current, resource }` —
 * endpoints at `endpoints.service.ts` `requireHeadroom` and organizations at
 * `organizations.service.ts` `create` included.
 *
 * So the message-matching fallback is GONE. Keeping it would now do harm
 * rather than good: a genuine `conflict` that happens to be worded "…which is
 * the limit" would be classified as a ceiling and the user told to delete
 * something. The code is the contract; the message is for a human.
 *
 *   1. 429, or `rate_limited`             → throttled, transient.
 *   2. `limit_exceeded`                   → ceiling, with numbers and resource.
 *   3. any other 409                      → an ordinary conflict.
 *   4. 400 / `invalid_request`            → invalid, with per-field issues.
 */
import { ApiRequestError } from './api';

/**
 * One rejected property, as the server named it.
 *
 * `field` is the DTO property (`url`, `custom_headers`, `name`), which is what
 * lets a form call `setError` on the input that caused it instead of showing a
 * paragraph. It is null when the message carries no property prefix — an
 * `AppError` raised by a service rather than by the validation pipe.
 */
export interface ValidationIssue {
  field: string | null;
  reason: string;
  message: string;
}

export type WriteFailure =
  | { kind: 'throttled'; retryAfterSeconds: number | null; message: string }
  | {
      kind: 'ceiling';
      limit: number | null;
      current: number | null;
      /** `endpoints`, `projects`, … — names the thing to delete. */
      resource: string | null;
      message: string;
    }
  | { kind: 'conflict'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; message: string; issues: ValidationIssue[] }
  | { kind: 'other'; message: string };

/**
 * `details` is TYPED now — `ApiError.details` is the document's own schema, so
 * `limit`, `current`, `resource` and `retry_after_seconds` arrive with their
 * declared types and these two take those rather than `unknown`. That is the guard that matters: the schema's `details` stays open
 * (`additionalProperties`), so reading a key it does NOT declare yields
 * `unknown` and fails to compile here. A rename on the server is caught at
 * build time instead of quietly becoming `null` and a vaguer message.
 *
 * The runtime checks stay because these values still arrive over a network.
 */
function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Splits `"url: is not a deliverable URL"` into its property and its reason.
 *
 * The prefix is produced by class-validator's `defaultMessage`, which the
 * endpoint DTO writes as `` `${args.property}: ${reason}` `` for both the SSRF
 * mirror and the reserved-header check. A property name is a single
 * identifier-shaped token, so anything else before the first colon (a URL, a
 * sentence) is left alone rather than mistaken for a field.
 */
const PROPERTY_PREFIX = /^([a-z_][a-z0-9_]*):\s+(.*)$/is;

export function parseValidationIssues(error: ApiRequestError): ValidationIssue[] {
  const messages = error.body.messages ?? [error.body.message];
  return messages
    .filter((message) => message.length > 0)
    .map((message) => {
      const match = PROPERTY_PREFIX.exec(message);
      if (!match) return { field: null, reason: message, message };
      return { field: match[1], reason: match[2], message };
    });
}

export function classifyWriteError(error: unknown): WriteFailure {
  if (!(error instanceof ApiRequestError)) {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';
    return { kind: 'other', message };
  }

  const { code, message, details } = error.body;

  // A 429 is always transient, whatever else is going on.
  if (error.status === 429 || code === 'rate_limited') {
    return {
      kind: 'throttled',
      retryAfterSeconds: numberOrNull(details?.retry_after_seconds),
      message,
    };
  }

  // A ceiling has its own code and always carries details. Matching the code
  // rather than the sentence is the whole point of it existing.
  if (code === 'limit_exceeded') {
    return {
      kind: 'ceiling',
      limit: numberOrNull(details?.limit),
      current: numberOrNull(details?.current),
      resource: stringOrNull(details?.resource),
      message,
    };
  }

  // Every other 409 is an ordinary conflict: a duplicate slug, a deleted
  // endpoint, an endpoint with no active signing secret.
  if (error.status === 409 || code === 'conflict') return { kind: 'conflict', message };

  if (code === 'forbidden' || error.status === 403) return { kind: 'forbidden', message };
  if (code === 'invalid_request' || error.status === 400) {
    return { kind: 'invalid', message, issues: parseValidationIssues(error) };
  }
  return { kind: 'other', message };
}

/** Short, actionable headline per failure kind. The remedy differs; so does the copy. */
export function writeFailureTitle(failure: WriteFailure): string {
  switch (failure.kind) {
    case 'throttled':
      return 'Too many requests — slow down';
    case 'ceiling':
      return 'You have reached a limit';
    case 'conflict':
      return 'That conflicts with something that already exists';
    case 'forbidden':
      return 'You do not have permission to do this';
    case 'invalid':
      return 'Check the details and try again';
    default:
      return 'Request failed';
  }
}

/**
 * What the user should DO. A throttle resolves itself; a ceiling never does,
 * so its copy must not say "try again".
 */
export function writeFailureRemedy(failure: WriteFailure): string {
  switch (failure.kind) {
    case 'throttled': {
      const seconds = failure.retryAfterSeconds;
      if (seconds === null) return 'Wait a moment, then try again. Nothing was created.';
      const unit = seconds === 1 ? 'second' : 'seconds';
      return `Wait about ${seconds} ${unit}, then try again. Nothing was created.`;
    }
    case 'ceiling': {
      const counts =
        failure.limit !== null && failure.current !== null
          ? ` You are at ${failure.current} of ${failure.limit}.`
          : '';
      const what = failure.resource ? ` one of your ${failure.resource}` : ' something';
      return (
        `Waiting will not help — this limit does not reset.${counts} ` +
        `Delete${what} you no longer need, or ask an operator to raise the limit.`
      );
    }
    default:
      return failure.message;
  }
}
