import {
  PAYLOAD_NOTICE,
  PAYLOAD_PREVIEW_MAX_CHARS,
  PAYLOAD_PREVIEW_READ_BYTES,
  decodePayload,
  previewPayload,
  renderPayload,
} from './event-payload';

/**
 * The raw-versus-jsonb distinction, at the level where it is decided.
 *
 * This is the rule the whole events module is built around: `payload_raw` is
 * what was signed and delivered, `payload` (jsonb) is a normalised copy for
 * querying. A response that presents the second as the payload sends whoever is
 * debugging a signature failure into the wrong system.
 */
describe('decodePayload', () => {
  it('returns valid UTF-8 verbatim, byte for byte', () => {
    const body = '{"order_id":"41f9",   "amount":1250}';
    const decoded = decodePayload(Buffer.from(body, 'utf8'));

    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.body).toBe(body);
    // The bytes survive the round trip, which is the only property that matters:
    // a consumer recomputing the HMAC over this string must get what we signed.
    expect(Buffer.from(decoded.body, 'utf8')).toEqual(Buffer.from(body, 'utf8'));
  });

  it('preserves the exact whitespace and key order that jsonb would destroy', () => {
    const body = '{ "b": 2,\n  "a": 1 }';
    expect(decodePayload(Buffer.from(body, 'utf8')).body).toBe(body);
    // What jsonb would have given back instead - different bytes, same meaning,
    // and a signature over it verifies against nothing.
    expect(JSON.stringify(JSON.parse(body))).not.toBe(body);
  });

  it('falls back to base64 rather than rendering U+FFFD soup', () => {
    // 0xff 0xfe is not a valid UTF-8 sequence. `toString('utf8')` would have
    // silently replaced it, producing a string that looks like data, is not the
    // payload, and hashes to nothing.
    const raw = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x7f]);
    const decoded = decodePayload(raw);

    expect(decoded.encoding).toBe('base64');
    expect(Buffer.from(decoded.body, 'base64')).toEqual(Buffer.from(raw));
    expect(decoded.body).not.toContain('�');
  });

  it('round-trips every byte value through one of the two encodings', () => {
    for (let byte = 0; byte < 256; byte += 1) {
      const raw = Uint8Array.from([byte, 0x41, byte]);
      const decoded = decodePayload(raw);
      const back =
        decoded.encoding === 'utf-8'
          ? Buffer.from(decoded.body, 'utf8')
          : Buffer.from(decoded.body, 'base64');
      expect(back).toEqual(Buffer.from(raw));
    }
  });
});

describe('renderPayload', () => {
  it('reports inline bytes as authoritative', () => {
    const rendered = renderPayload({
      payloadRaw: Buffer.from('{"a":1}', 'utf8'),
      payloadLocation: null,
    });

    expect(rendered.source).toBe('inline');
    expect(rendered.body).toBe('{"a":1}');
    expect(rendered.notice).toBe(PAYLOAD_NOTICE.inline);
  });

  it('says so, and hands over the location, when the payload was offloaded', () => {
    const rendered = renderPayload({
      payloadRaw: null,
      payloadLocation: 's3://payloads/proj_a1/evt.json',
    });

    // The failure this pins: returning `body: null` with no explanation reads,
    // on a dashboard, as "this event had no payload".
    expect(rendered.source).toBe('object_storage');
    expect(rendered.body).toBeNull();
    expect(rendered.location).toBe('s3://payloads/proj_a1/evt.json');
    expect(rendered.notice).toBe(PAYLOAD_NOTICE.object_storage);
  });

  it('admits when the payload is simply not recoverable', () => {
    const rendered = renderPayload({ payloadRaw: null, payloadLocation: null });

    expect(rendered.source).toBe('unavailable');
    expect(rendered.body).toBeNull();
    expect(rendered.location).toBeNull();
    expect(rendered.notice).toBe(PAYLOAD_NOTICE.unavailable);
  });

  it('every notice states that the jsonb copy is not what was delivered', () => {
    for (const notice of Object.values(PAYLOAD_NOTICE)) {
      expect(notice).toContain('NOT what was delivered');
    }
  });
});

/**
 * The bounded preview a delivery LIST row carries.
 *
 * Everything here is about the two ways a preview can lie: by being longer than
 * it claims (the bound is the reason the response has a size at all, so a client
 * must never be the one enforcing it), and by rendering bytes as text that they
 * are not - a half-cut code point, or a binary body decoded as UTF-8.
 */
describe('previewPayload', () => {
  /** An inline payload, the way the database hands one back. */
  const inline = (body: string | Uint8Array, readBytes = PAYLOAD_PREVIEW_READ_BYTES) => {
    const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    return {
      // `substring(payload_raw from 1 for N)`: a BYTE slice.
      head: raw.subarray(0, readBytes),
      // `octet_length(payload_raw)`: the whole column.
      inlineBytes: raw.byteLength,
      payloadSize: raw.byteLength,
      payloadLocation: null,
    };
  };

  it('returns a short body whole, and does not claim it was cut', () => {
    const body = '{"order_id":"41f9","amount":1250,"currency":"GHS"}';

    const preview = previewPayload(inline(body));

    expect(preview.preview).toBe(body);
    expect(preview.size).toBe(50);
    expect(preview.truncated).toBe(false);
  });

  it('caps a long body at the character bound and says it did', () => {
    const body = `{"note":"${'a'.repeat(2_000)}"}`;

    const preview = previewPayload(inline(body));

    expect(preview.preview).toHaveLength(PAYLOAD_PREVIEW_MAX_CHARS);
    expect(preview.preview).toBe(body.slice(0, PAYLOAD_PREVIEW_MAX_CHARS));
    // The SIZE is the whole body, not the preview. A client showing "160 bytes"
    // for a 2 KB payload would be the wrong answer to "is this the big one?".
    expect(preview.size).toBe(2_011);
    expect(preview.truncated).toBe(true);
  });

  it('flags a body that fits the read slice but not the character bound', () => {
    // 300 bytes: nothing was cut in SQL, so the ONLY thing that can set the flag
    // is the character cap. A `truncated` derived from the byte slice alone
    // would say false here and a reader would trust a preview that stops
    // mid-word.
    const body = 'x'.repeat(300);

    const preview = previewPayload(inline(body));

    expect(preview.preview).toHaveLength(PAYLOAD_PREVIEW_MAX_CHARS);
    expect(preview.truncated).toBe(true);
  });

  it('reads the bound in CHARACTERS, so a multi-byte body is not short-changed', () => {
    // 200 three-byte characters = 600 bytes, inside the 640-byte read. A preview
    // bound applied to bytes would have returned ~53 characters of Arabic.
    const body = 'م'.repeat(200);

    const preview = previewPayload(inline(body));

    expect(Array.from(preview.preview ?? '')).toHaveLength(PAYLOAD_PREVIEW_MAX_CHARS);
    expect(preview.preview).toBe('م'.repeat(PAYLOAD_PREVIEW_MAX_CHARS));
  });

  describe('a code point straddling the byte slice', () => {
    it('drops the half-cut character instead of rendering U+FFFD', () => {
      // Read 4 bytes of 'a€€': 'a' + the whole first euro + ONE byte of the
      // second. `Buffer.toString('utf8')` would append a replacement character.
      const preview = previewPayload(inline('a€€', 5));

      expect(preview.preview).toBe('a€');
      expect(preview.preview).not.toContain('�');
      expect(preview.truncated).toBe(true);
    });

    it('does the same for a 4-byte code point cut anywhere in its tail', () => {
      // U+1F600 is f0 9f 98 80. Cutting after 1, 2 or 3 of those bytes must all
      // give the same answer: the character is not there yet.
      for (const readBytes of [1, 2, 3]) {
        const preview = previewPayload(inline('\u{1f600}', readBytes));
        expect(preview.preview).toBe('');
        expect(preview.preview).not.toContain('�');
        expect(preview.truncated).toBe(true);
      }
    });

    it('never puts a lone surrogate on the wire when the CAP lands mid-pair', () => {
      // 200 emoji: each is one code point but TWO UTF-16 units, so a cap applied
      // with `String.prototype.slice` would cut a surrogate pair in half and
      // JSON.stringify would emit an unpaired \ud83d.
      const preview = previewPayload(inline('\u{1f600}'.repeat(200)));
      const text = preview.preview ?? '';

      expect(Array.from(text)).toHaveLength(PAYLOAD_PREVIEW_MAX_CHARS);
      expect(text).not.toMatch(/[\ud800-\udfff]/u);
      expect(JSON.parse(JSON.stringify(text))).toBe(text);
    });

    it('does NOT tidy a partial sequence that is the end of a COMPLETE body', () => {
      // The same trailing bytes, but nothing was cut: this body really is not
      // valid UTF-8, and trimming it would turn a broken payload into a
      // plausible-looking preview.
      const raw = Buffer.concat([Buffer.from('ok', 'utf8'), Buffer.from([0xe2, 0x82])]);

      expect(previewPayload(inline(raw)).preview).toBeNull();
    });
  });

  it('is null for a body that is not valid UTF-8, not base64 and not U+FFFD', () => {
    const preview = previewPayload(inline(Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x7f])));

    expect(preview.preview).toBeNull();
    // The size is still the truth: "there is a 5-byte body and we cannot show
    // it" is a different statement from "there is no body".
    expect(preview.size).toBe(5);
    expect(preview.truncated).toBe(false);
  });

  it('is null for an OFFLOADED payload, and still reports its size', () => {
    // payload_raw IS NULL by design past PAYLOAD_INLINE_MAX_BYTES. The size was
    // recorded at ingest, so it costs nothing - and nothing here goes to S3.
    const preview = previewPayload({
      head: null,
      inlineBytes: null,
      payloadSize: 4_194_304,
      payloadLocation: 's3://payloads/proj_a1/evt_a_big.json',
    });

    expect(preview.preview).toBeNull();
    expect(preview.size).toBe(4_194_304);
    // FALSE, not true: there is no preview for the body to be longer than, and a
    // client rendering an ellipsis after nothing would be inventing content.
    expect(preview.truncated).toBe(false);
  });

  it('is null for a reclaimed payload, which is not the same as an empty one', () => {
    const reclaimed = previewPayload({
      head: null,
      inlineBytes: null,
      payloadSize: 812,
      payloadLocation: null,
    });
    expect(reclaimed.preview).toBeNull();
    expect(reclaimed.size).toBe(812);

    // An empty body gives the empty string. A client can tell the two apart,
    // which is the only reason null is reserved for "unavailable".
    const empty = previewPayload(inline(''));
    expect(empty.preview).toBe('');
    expect(empty.size).toBe(0);
    expect(empty.truncated).toBe(false);
  });

  it('reads enough bytes to always fill the character bound', () => {
    // 4 bytes is the longest UTF-8 encoding of one code point, so anything less
    // than 4x the character bound could come up short on a non-ASCII body.
    expect(PAYLOAD_PREVIEW_READ_BYTES).toBe(PAYLOAD_PREVIEW_MAX_CHARS * 4);
  });
});
