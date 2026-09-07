/**
 * Rendering an event payload without lying about which bytes it is.
 *
 * `events` carries the payload twice, and the difference is the whole reason
 * this file exists (schema.prisma, `model Event`; HANDOFF, "events.payload_raw
 * is now the authoritative payload"):
 *
 *   payload_raw  bytea  AUTHORITATIVE. The exact request body, byte for byte.
 *                       This is what `payload_hash` is over and what the data
 *                       plane signs and sends (ARCHITECTURE.md 28).
 *   payload      jsonb  NON-AUTHORITATIVE. A parsed copy for filtering and
 *                       search. PostgreSQL normalises jsonb: key order,
 *                       insignificant whitespace and duplicate keys are not
 *                       preserved.
 *
 * So the jsonb column is not what was delivered, and presenting it as the
 * payload is not a cosmetic error - it is the wrong answer to the exact
 * question an operator opens this screen to ask. Someone debugging a signature
 * failure would compare the consumer's computed HMAC against a body that was
 * never sent, conclude the platform is signing incorrectly, and go looking in
 * the wrong system. Both are returned, each labelled, with a notice that says
 * which is which.
 */

export type PayloadEncoding = 'utf-8' | 'base64';

/** Where the authoritative bytes are, if anywhere. */
export type PayloadSource = 'inline' | 'object_storage' | 'unavailable';

export const PAYLOAD_NOTICE = {
  inline:
    '`body` is the exact bytes received on the wire - what was hashed into `sha256` and what ' +
    'the data plane signs and delivers. `normalised_json` is a PostgreSQL jsonb copy kept for ' +
    'filtering and search only: jsonb does not preserve key order, insignificant whitespace or ' +
    'duplicate keys, so it is NOT what was delivered and an HMAC computed over it will not ' +
    'match the signature a consumer received.',
  object_storage:
    'This payload exceeded the inline threshold and was written to object storage, so ' +
    '`payload_raw` is NULL by design and `body` is null here. The control plane has no ' +
    'object-storage client - fetch `location` directly rather than trusting anything else on ' +
    'this response to stand in for it. `normalised_json`, if present, is a jsonb copy and is ' +
    'NOT what was delivered.',
  unavailable:
    'Neither the raw bytes nor an object-storage location is recorded for this event, so the ' +
    'delivered payload is not recoverable through this API - retention has removed it, or the ' +
    'row predates `payload_raw`. `normalised_json`, if present, is a jsonb copy and is NOT what ' +
    'was delivered.',
} as const;

export interface RenderedPayload {
  source: PayloadSource;
  /** The authoritative bytes, decoded. Null unless `source` is `inline`. */
  body: string | null;
  /** How `body` is encoded, or null when there is no body. */
  encoding: PayloadEncoding | null;
  /** `s3://bucket/key`, when the payload was offloaded. */
  location: string | null;
  notice: string;
}

/**
 * Decode the authoritative bytes for display.
 *
 * UTF-8 when the buffer round-trips through it unchanged, base64 otherwise -
 * checked by re-encoding rather than assumed, because `Buffer.toString('utf8')`
 * silently replaces invalid sequences with U+FFFD. A payload that is not valid
 * UTF-8 (a gzipped or binary body, a mis-encoded one) would otherwise be
 * rendered as a string of replacement characters that looks like data and
 * hashes to nothing, on the screen whose entire job is to show what was
 * actually sent. Base64 is ugly and correct; U+FFFD soup is neither.
 */
export function decodePayload(raw: Uint8Array): { body: string; encoding: PayloadEncoding } {
  const buffer = Buffer.from(raw);
  const text = buffer.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buffer)) return { body: text, encoding: 'utf-8' };
  return { body: buffer.toString('base64'), encoding: 'base64' };
}

/**
 * Which of the three payload situations this event is in, and the honest
 * response for it.
 *
 * The offloaded case is the one worth being careful about: returning an empty
 * body with a 200 would read, on a dashboard, as "this event had no payload".
 * It says so instead, and hands over the location.
 */
export function renderPayload(event: {
  payloadRaw: Uint8Array | null;
  payloadLocation: string | null;
}): RenderedPayload {
  if (event.payloadRaw !== null && event.payloadRaw !== undefined) {
    const { body, encoding } = decodePayload(event.payloadRaw);
    return {
      source: 'inline',
      body,
      encoding,
      location: event.payloadLocation ?? null,
      notice: PAYLOAD_NOTICE.inline,
    };
  }
  if (event.payloadLocation) {
    return {
      source: 'object_storage',
      body: null,
      encoding: null,
      location: event.payloadLocation,
      notice: PAYLOAD_NOTICE.object_storage,
    };
  }
  return {
    source: 'unavailable',
    body: null,
    encoding: null,
    location: null,
    notice: PAYLOAD_NOTICE.unavailable,
  };
}
