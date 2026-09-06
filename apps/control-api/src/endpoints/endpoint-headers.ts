/**
 * Validation for `endpoints.custom_headers`.
 *
 * These headers are tenant-controlled and are MERGED INTO THE OUTBOUND REQUEST,
 * which makes this map an injection surface into a request the platform signs.
 *
 * The finding that produced the reserved list: `signing.Verify` collects every
 * `v1=` component out of the header and accepts the delivery if ANY of them
 * matches - correct, because that is exactly what makes an overlapping rotation
 * window work. But a tenant able to add a second `Webhook-Signature` header
 * would then be handing the consumer a signature the platform did not compute,
 * next to one it did, and the consumer's verifier would accept either. The
 * customer's own consumers trust that header; whoever can write it can forge a
 * webhook into them.
 *
 * `Authorization` is the same class of problem one layer out (it overrides the
 * credential the endpoint is configured with), and `Host`, `Content-Length` and
 * `Transfer-Encoding` are the classic request-smuggling triple: a
 * caller-supplied framing header disagreeing with the body the client actually
 * writes is how one request becomes two.
 *
 * Reserved keys are refused HERE, at save time, rather than filtered at delivery
 * time. A filter is invisible - a customer sets a header, sees it silently
 * dropped, and files a bug - and it puts the check in the hot path of every
 * delivery in the data plane, where forgetting it is a silent vulnerability
 * rather than a failing test.
 */

export const MAX_CUSTOM_HEADERS = 20;
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_LENGTH = 1024;
/** Total serialised size, so twenty maximum-length values cannot bloat a request. */
export const MAX_CUSTOM_HEADERS_BYTES = 8192;

/** Exact names a tenant may never set. Compared case-insensitively. */
export const RESERVED_HEADER_NAMES: readonly string[] = [
  'authorization',
  'host',
  'content-length',
  'transfer-encoding',
];

/**
 * The whole `Webhook-*` namespace, not just `Webhook-Signature`. `Webhook-Id`,
 * `Webhook-Delivery-Id` and `Webhook-Timestamp` are the platform's contract with
 * the consumer (docs/API.md), and a tenant that can restate any of them can make
 * a delivery claim to be a different event or a different attempt.
 */
export const RESERVED_HEADER_PREFIX = 'webhook-';

/** RFC 9110 field-name: one or more token characters. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** RFC 9110 field-value: visible ASCII plus space and tab. No CR, no LF, no NUL. */
// eslint-disable-next-line no-control-regex
const HEADER_VALUE = /^[\t\u0020-\u007E\u0080-\u00FF]*$/;

export interface CustomHeaderRejection {
  header: string;
  reason: string;
}

export function isReservedHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower.startsWith(RESERVED_HEADER_PREFIX) || RESERVED_HEADER_NAMES.includes(lower);
}

/**
 * Returns the first reason `headers` is unacceptable, or null.
 *
 * `null`/`undefined` is valid and means "no custom headers"; an empty object is
 * normalised to null by `normaliseCustomHeaders`.
 */
export function rejectCustomHeaders(headers: unknown): CustomHeaderRejection | null {
  if (headers === undefined || headers === null) return null;
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    return { header: '', reason: 'custom_headers must be an object of string values' };
  }

  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return { header: '', reason: `at most ${MAX_CUSTOM_HEADERS} custom headers are allowed` };
  }

  const seen = new Set<string>();
  let bytes = 0;

  for (const [name, value] of entries) {
    const lower = name.toLowerCase();

    if (name.length === 0 || name.length > MAX_HEADER_NAME_LENGTH) {
      return {
        header: name,
        reason: `header name must be 1-${MAX_HEADER_NAME_LENGTH} characters`,
      };
    }
    if (!HEADER_NAME.test(name)) {
      return { header: name, reason: 'header name contains characters that are not allowed' };
    }
    if (isReservedHeader(name)) {
      return {
        header: name,
        reason:
          'this header is reserved by the platform and cannot be overridden. ' +
          'Webhook-* carries the signature and delivery identity; Authorization, Host, ' +
          'Content-Length and Transfer-Encoding frame or authenticate the request itself.',
      };
    }
    // HTTP header names are case-insensitive, so `X-Trace` and `x-trace` are one
    // header with two values. Refusing the pair keeps what is stored and what is
    // sent the same thing.
    if (seen.has(lower)) {
      return { header: name, reason: 'duplicate header name (names are case-insensitive)' };
    }
    seen.add(lower);

    if (typeof value !== 'string') {
      return { header: name, reason: 'header value must be a string' };
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      return {
        header: name,
        reason: `header value must be at most ${MAX_HEADER_VALUE_LENGTH} characters`,
      };
    }
    if (!HEADER_VALUE.test(value)) {
      return {
        header: name,
        reason: 'header value contains control characters (a CR or LF here is header injection)',
      };
    }

    bytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 4;
  }

  if (bytes > MAX_CUSTOM_HEADERS_BYTES) {
    return { header: '', reason: `custom headers must total at most ${MAX_CUSTOM_HEADERS_BYTES} bytes` };
  }
  return null;
}

/** Empty maps are stored as NULL, so "unset" has one representation. */
export function normaliseCustomHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!headers) return null;
  const entries = Object.entries(headers);
  return entries.length === 0 ? null : Object.fromEntries(entries);
}
