import { PAYLOAD_NOTICE, decodePayload, renderPayload } from './event-payload';

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
