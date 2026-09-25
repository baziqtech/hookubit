/**
 * `custom_headers` as a textarea, and back.
 *
 * The wire shape is `Record<string, string> | null`. The editable shape is one
 * `Name: value` per line, because that is how a header is written everywhere
 * else an operator has seen one, and because a key/value row builder for a map
 * that is usually empty and occasionally holds two entries costs more than it
 * returns.
 *
 * The rules mirrored here are the SERVER's, from
 * `apps/control-api/src/endpoints/endpoint-headers.ts`. The server is the
 * authority — these headers are merged into a request the platform signs, so
 * the check that matters runs where the write happens. Mirroring it buys the
 * operator the reason at the moment they type it rather than after a round
 * trip, in the same words, so the two never appear to disagree.
 */
import {
  MAX_CUSTOM_HEADERS,
  RESERVED_HEADER_NAMES,
  RESERVED_HEADER_PREFIX,
} from '../../types/api';

export const MAX_HEADER_VALUE_LENGTH = 1024;

/** RFC 9110 field-name: one or more token characters. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** RFC 9110 field-value: visible ASCII plus space and tab. No CR, no LF, no NUL. */
const HEADER_VALUE = /^[\t\u0020-\u007E\u0080-\u00FF]*$/;

export type HeaderParse =
  | { ok: true; headers: Record<string, string> | null }
  | { ok: false; reason: string };

export function isReservedHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower.startsWith(RESERVED_HEADER_PREFIX) || RESERVED_HEADER_NAMES.includes(lower);
}

/** `{ 'x-a': '1' }` → `"x-a: 1"`. Round-trips through `parseCustomHeaders`. */
export function formatCustomHeaders(
  headers: Record<string, string> | null | undefined,
): string {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

/**
 * Empty text is `null`, not `{}`. "Unset" has one representation on the wire —
 * the server normalises an empty map to NULL — so the form must not send the
 * other one and produce a PATCH that changes nothing while looking like a save.
 */
export function parseCustomHeaders(text: string): HeaderParse {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return { ok: true, headers: null };
  if (lines.length > MAX_CUSTOM_HEADERS) {
    return { ok: false, reason: `At most ${MAX_CUSTOM_HEADERS} custom headers are allowed.` };
  }

  const headers: Record<string, string> = {};
  const seen = new Set<string>();

  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      return { ok: false, reason: `Write one header per line, as "Name: value" — got "${line}".` };
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (!HEADER_NAME.test(name)) {
      return { ok: false, reason: `"${name}" contains characters a header name cannot hold.` };
    }
    if (isReservedHeader(name)) {
      return {
        ok: false,
        reason:
          `"${name}" is reserved by the platform. Webhook-* carries the signature and the ` +
          'delivery identity — a second one would let a consumer verify a webhook the platform ' +
          'did not sign — and Authorization, Host, Content-Length and Transfer-Encoding ' +
          'authenticate or frame the request itself.',
      };
    }
    // Header names are case-insensitive, so `X-Trace` and `x-trace` are one
    // header with two values. Refusing the pair keeps what is stored and what
    // is sent the same thing.
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      return {
        ok: false,
        reason: `"${name}" is listed twice (header names are case-insensitive).`,
      };
    }
    seen.add(lower);

    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      return {
        ok: false,
        reason: `The value for "${name}" is longer than ${MAX_HEADER_VALUE_LENGTH} characters.`,
      };
    }
    if (!HEADER_VALUE.test(value)) {
      return {
        ok: false,
        reason: `The value for "${name}" contains control characters (a CR or LF here is header injection).`,
      };
    }
    headers[name] = value;
  }

  return { ok: true, headers };
}
