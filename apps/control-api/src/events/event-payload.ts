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

// ---------------------------------------------------------------------------
// The list-column preview
// ---------------------------------------------------------------------------

/**
 * How many CHARACTERS of a payload a list row carries.
 *
 * A bound, not a preference. `deliveries` is the hottest read path in the
 * product and `MAX_PAGE_SIZE` is 200, so "the body" on a list row is a 200 MB
 * response at `PAYLOAD_MAX_BYTES` (1 MiB, config.go:265): the preview has to be
 * cut server-side before the bytes leave PostgreSQL, and no client-side
 * truncation is trusted to stand in for that.
 *
 * 160 was picked against the column it feeds, not as a round number:
 *
 *  - It is enough to show the leading keys of a JSON body -
 *    `{"order_id":"41f9","amount":1250,"currency":"GHS"}` is 49 - which is the
 *    question the column answers ("which order was that?"), and roughly two
 *    lines of a table cell at a readable font size.
 *  - 200 rows x 160 characters is ~32 KB of preview in a full page. The same
 *    page carrying whole bodies is up to 200 MiB.
 *
 * Nothing downstream may raise it: it is the reason the response has a size at
 * all.
 */
export const PAYLOAD_PREVIEW_MAX_CHARS = 160;

/**
 * How many BYTES to read per row to be able to produce that many characters.
 *
 * UTF-8 encodes a code point in at most 4 bytes, so 4x the character bound is
 * the smallest slice that can never come up short of `PAYLOAD_PREVIEW_MAX_CHARS`
 * characters on a payload that has them. Anything smaller would silently
 * shorten previews of non-ASCII bodies - Arabic, Twi with its ɔ/ɛ, an emoji in
 * a customer name - which is the failure mode nobody notices in review because
 * the fixtures are ASCII.
 *
 * This is the number handed to `substring(payload_raw from 1 for N)`, so it is
 * also the ceiling on what the database reads out of a `bytea` that may be a
 * megabyte: 640 bytes per row, not 1 MiB per row.
 */
export const PAYLOAD_PREVIEW_READ_BYTES = PAYLOAD_PREVIEW_MAX_CHARS * 4;

/** The three preview fields of a delivery list row. */
export interface PayloadPreview {
  /** First `PAYLOAD_PREVIEW_MAX_CHARS` characters, decoded. Null when absent. */
  preview: string | null;
  /** Bytes of the WHOLE body, `events.payload_size`. Known even when offloaded. */
  size: number | null;
  /** Whether the body continues past `preview`. Always false when it is null. */
  truncated: boolean;
}

/**
 * The head of a payload, as the database can cheaply produce it.
 *
 * `head` is the first `PAYLOAD_PREVIEW_READ_BYTES` bytes of `payload_raw` and
 * `inlineBytes` is `octet_length(payload_raw)` - the FULL inline length, which
 * is what says whether the head is the whole body or the start of it. Both are
 * null when `payload_raw` is: offloaded to object storage, or reclaimed.
 */
export interface PayloadHead {
  head: Uint8Array | null;
  inlineBytes: number | null;
  payloadSize: number | null;
  payloadLocation: string | null;
}

/** No head at all: the honest answer when `payload_raw` is NULL. */
const NO_PREVIEW = (size: number | null): PayloadPreview => ({
  preview: null,
  size,
  truncated: false,
});

/**
 * Drop a trailing UTF-8 sequence that the byte slice cut in half.
 *
 * `substring(payload_raw from 1 for 640)` counts BYTES, so a payload whose 640th
 * byte lands inside a multi-byte code point hands us the first one or two bytes
 * of it. Decoding that with `Buffer.toString('utf8')` appends U+FFFD, and a
 * preview that ends in a replacement character is a defect a reader will blame
 * on the payload rather than on us.
 *
 * Only the TRAILING sequence is dropped, and only when the head is known to be
 * a prefix of something longer (see `previewPayload`): the same partial sequence
 * at the end of a COMPLETE body is not a slicing artefact, it is a body that is
 * not valid UTF-8, and that has to be reported as such rather than tidied away.
 */
function dropPartialTrailingSequence(buffer: Buffer): Buffer {
  let end = buffer.length;
  let continuations = 0;

  // At most 3 continuation bytes can belong to one code point; a 4th means the
  // bytes are not UTF-8 at all, which the round-trip check below will catch.
  while (end > 0 && continuations < 4) {
    const byte = buffer[end - 1];
    if ((byte & 0b1100_0000) === 0b1000_0000) {
      end -= 1;
      continuations += 1;
      continue;
    }

    const needed =
      byte < 0x80
        ? 1
        : (byte & 0b1110_0000) === 0b1100_0000
          ? 2
          : (byte & 0b1111_0000) === 0b1110_0000
            ? 3
            : (byte & 0b1111_1000) === 0b1111_0000
              ? 4
              : 0;

    // 0 is an invalid lead byte and `needed <= continuations` is more
    // continuations than the lead can own: both are non-UTF-8, not a cut, so
    // hand the buffer back unchanged and let the round-trip check reject it.
    if (needed === 0 || needed <= continuations) return buffer;
    if (needed === continuations + 1) return buffer; // complete
    return buffer.subarray(0, end - 1); // incomplete: drop lead + continuations
  }
  return buffer;
}

/**
 * A payload head as the three fields a delivery list row carries.
 *
 * What this deliberately does NOT do is reach for object storage. A payload at
 * or above `PAYLOAD_INLINE_MAX_BYTES` (64 KiB) has `payload_raw` NULL and
 * `payload_location` set, and fetching 200 objects from S3 to render one column
 * would make a list request depend on a service the control plane has no client
 * for (see `PAYLOAD_NOTICE.object_storage`). `preview` is null there and `size`
 * is still the truth, because the size was recorded at ingest.
 *
 * Non-UTF-8 bytes are null too, not base64. `renderPayload` returns base64 for
 * the detail screen, where a reader asked for the exact bytes of one event and
 * a blob is the correct answer; 200 rows of base64 in a table column is noise
 * that hides the rows next to it, and the detail route already serves it.
 */
export function previewPayload(row: PayloadHead): PayloadPreview {
  const size = row.payloadSize ?? null;
  if (row.head === null || row.head === undefined || row.inlineBytes === null) {
    return NO_PREVIEW(size);
  }

  const head = Buffer.from(row.head);
  const cutMidBody = row.inlineBytes > head.byteLength;
  const candidate = cutMidBody ? dropPartialTrailingSequence(head) : head;

  // Re-encode rather than trust `toString`, exactly as `decodePayload` does:
  // `Buffer.toString('utf8')` replaces invalid sequences with U+FFFD silently,
  // so a gzipped or binary body would render as replacement soup that looks
  // like data.
  const text = candidate.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(candidate)) return NO_PREVIEW(size);

  // Sliced by CODE POINT, not by `String.prototype.slice`: JS string indices are
  // UTF-16 code units, so cutting at 160 of those can split a surrogate pair and
  // put a lone surrogate on the wire - which `JSON.stringify` emits as an
  // unpaired \ud83d and which is not valid JSON text.
  const points = Array.from(text);
  const overLength = points.length > PAYLOAD_PREVIEW_MAX_CHARS;
  return {
    preview: overLength ? points.slice(0, PAYLOAD_PREVIEW_MAX_CHARS).join('') : text,
    size,
    truncated: cutMidBody || overLength,
  };
}
