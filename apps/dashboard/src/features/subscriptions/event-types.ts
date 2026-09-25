/**
 * Event-type filters, validated on the client in the SAME WORDS the server
 * uses — a mirror of control-api
 * `src/webhook-subscriptions/event-type-pattern.ts`.
 *
 * The rule that file exists to enforce, and that this one must not weaken:
 *
 *   A pattern is either honoured exactly as written, or refused. It is never
 *   widened, never narrowed, and never rewritten into something the router
 *   would read differently from what the operator typed.
 *
 * Three forms are accepted, because three forms are what the router
 * (`services/data-plane/internal/router/match.go`) implements:
 *
 * | pattern           | matches                                           |
 * |-------------------|---------------------------------------------------|
 * | `*`               | everything                                        |
 * | `payment.*`       | every type beginning with the literal `payment.`  |
 * | `payment.settled` | that type, byte for byte                          |
 *
 * This is a CONVENIENCE, not the authority: it lets the form put the reason
 * under the textarea before spending a round trip. The server validates again
 * and its answer wins. A value this file accepts and the server refuses costs
 * one 400 rendered under the same field; a value this file refused and the
 * server would accept costs a pattern the operator cannot save — so where the
 * two could disagree, this file errs towards the server's wording, never
 * towards being looser.
 *
 * `parseEventTypesInput` is the ONLY thing here that transforms text, and all
 * it does is split on newlines and commas and drop blank entries. Whitespace
 * around a pattern is NOT trimmed away silently: the router compares bytes, so
 * a trailing space is a real difference and the server refuses it. Trimming it
 * here would store something other than what was typed, which is the exact
 * class of lie this module is a mirror against — so the split trims the
 * separators only, and an interior space is left for the validator to name.
 */
import {
  MAX_EVENT_TYPES_PER_SUBSCRIPTION,
  MAX_EVENT_TYPE_LENGTH,
  MAX_EVENT_TYPE_SEGMENTS,
} from '../../types/api';

export const WILDCARD_ALL = '*';
export const WILDCARD_SUFFIX = '.*';

/** One dot-separated segment: letters, digits, `_` and `-`. No `*`, no whitespace. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

function rejectDottedName(value: string, what: string): string | null {
  const segments = value.split('.');
  if (segments.length > MAX_EVENT_TYPE_SEGMENTS) {
    return `${what} has ${segments.length} dot-separated segments; the maximum is ${MAX_EVENT_TYPE_SEGMENTS}`;
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      return `${what} has an empty segment - ".." and a leading or trailing "." are not event types`;
    }
    if (!SEGMENT.test(segment)) {
      return `${what} contains "${segment}", which is not a valid segment: use letters, digits, "_" or "-", separated by "."`;
    }
  }
  return null;
}

/** Why this ONE pattern cannot be stored, or null when it can. */
export function rejectEventTypePattern(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length === 0) return 'is empty';
  if (value.length > MAX_EVENT_TYPE_LENGTH) {
    return `is ${value.length} characters; the maximum is ${MAX_EVENT_TYPE_LENGTH}`;
  }
  if (value !== value.trim()) {
    return 'has leading or trailing whitespace; the router compares event types byte for byte';
  }

  if (value === WILDCARD_ALL) return null;

  if (value.endsWith(WILDCARD_SUFFIX)) {
    const prefix = value.slice(0, -WILDCARD_SUFFIX.length);
    if (prefix.length === 0) {
      return 'is ".*", which would match only event types beginning with a literal "."; write "*" if you mean everything';
    }
    if (prefix.includes(WILDCARD_ALL)) {
      return `has a "*" inside the prefix "${prefix}"; the only wildcards are "*" on its own and a single trailing ".*"`;
    }
    return rejectDottedName(prefix, `the prefix "${prefix}" before ".*"`);
  }

  if (value.includes(WILDCARD_ALL)) {
    // The silent-nothing case: the router falls through to exact equality, so
    // `pay*` would be stored as a subscription that matches the literal string
    // `pay*` and therefore never fires.
    return `contains "*" but is not a wildcard pattern; the only forms are "*" (everything) and "prefix.*" (a trailing wildcard). "${value}" would be matched as an exact event type and would never fire`;
  }

  return rejectDottedName(value, `"${value}"`);
}

/**
 * Why this LIST cannot be stored, or null when it can.
 *
 * Empty is refused (it would match nothing, and the column default matches
 * everything — guessing which was meant is Convoy's bug re-created). `*` may
 * not sit alongside other patterns (the row would read as filtered and receive
 * everything). Duplicates are refused rather than de-duplicated.
 */
export function rejectEventTypes(value: unknown): string | null {
  if (!Array.isArray(value)) return 'event_types must be an array of strings';
  if (value.length === 0) {
    return 'event_types must not be empty: an empty filter matches NO events, so it is refused rather than stored or widened. Use ["*"] to receive every event type, list the types you want, or set enabled=false to stop deliveries without changing the filter';
  }
  if (value.length > MAX_EVENT_TYPES_PER_SUBSCRIPTION) {
    return `event_types has ${value.length} entries; the maximum is ${MAX_EVENT_TYPES_PER_SUBSCRIPTION}`;
  }

  const seen = new Set<string>();
  for (const [index, pattern] of value.entries()) {
    const rejection = rejectEventTypePattern(pattern);
    if (rejection) return `event_types[${index}] ${rejection}`;
    const key = pattern as string;
    if (seen.has(key)) return `event_types[${index}] repeats "${key}"`;
    seen.add(key);
  }

  if (seen.has(WILDCARD_ALL) && seen.size > 1) {
    return 'event_types contains "*" alongside other patterns. "*" already matches every event, so the subscription would read as filtered and receive everything - which is the exact failure this platform was built to avoid. Send ["*"] on its own, or drop it and list the types you want';
  }

  return null;
}

/**
 * The textarea's text as a list: one pattern per line, or comma-separated,
 * or both. Blank entries are dropped. Whitespace around a SEPARATOR is
 * removed (it is the separator's, not the pattern's); nothing else is touched.
 */
export function parseEventTypesInput(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The stored array, as the textarea shows it: one pattern per line. */
export function formatEventTypesInput(eventTypes: readonly string[]): string {
  return eventTypes.join('\n');
}

/**
 * The form's validator: `true` when the text parses to a storable list,
 * otherwise the server's own sentence for why not.
 */
export function validateEventTypesInput(text: string): true | string {
  return rejectEventTypes(parseEventTypesInput(text)) ?? true;
}
