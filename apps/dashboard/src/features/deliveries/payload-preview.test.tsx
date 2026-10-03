import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PAYLOAD_INLINE_MAX_BYTES, PAYLOAD_PREVIEW_MAX_CHARS } from '../../types/api';
import { PayloadPreviewCell } from './DeliveriesPage';
import {
  describePayloadPreview,
  payloadPreviewState,
  type PayloadPreviewFields,
} from './payload-preview';

const BODY = '{"order_id":"ord_9","amount":1250,"currency":"GHS"}';

const row = (fields: Partial<PayloadPreviewFields> = {}): PayloadPreviewFields => ({
  payload_preview: BODY,
  payload_size: BODY.length,
  payload_truncated: false,
  ...fields,
});

const render = (fields: Partial<PayloadPreviewFields> = {}) =>
  renderToStaticMarkup(<PayloadPreviewCell row={row(fields)} />);

describe('payloadPreviewState', () => {
  it('reads a short body as the whole body', () => {
    expect(payloadPreviewState(row())).toEqual({
      kind: 'body',
      text: BODY,
      truncated: false,
      size: BODY.length,
    });
  });

  it('carries the server`s truncation rather than measuring the string itself', () => {
    // The preview is already bounded server-side; the flag is the only thing
    // that knows whether anything was cut, because a body of exactly 160
    // characters and one of 160 KiB arrive here the same length.
    const state = payloadPreviewState(
      row({ payload_preview: 'x'.repeat(PAYLOAD_PREVIEW_MAX_CHARS), payload_truncated: true, payload_size: 2_400 }),
    );
    expect(state).toMatchObject({ kind: 'body', truncated: true, size: 2_400 });
  });

  it('keeps an EMPTY body and a MISSING preview apart', () => {
    expect(payloadPreviewState(row({ payload_preview: '', payload_size: 0 }))).toEqual({
      kind: 'empty',
      size: 0,
    });
    expect(
      payloadPreviewState(row({ payload_preview: null, payload_size: 412 })),
    ).toEqual({ kind: 'absent', reason: 'unreadable', size: 412 });
  });

  it('calls a null preview OFFLOADED from the size alone, at the inline limit', () => {
    // The one reason a list row can actually identify: at or above the inline
    // threshold `payload_raw` is NULL by design, and the size is still exact.
    expect(
      payloadPreviewState(row({ payload_preview: null, payload_size: PAYLOAD_INLINE_MAX_BYTES })),
    ).toMatchObject({ reason: 'offloaded' });
    expect(
      payloadPreviewState(
        row({ payload_preview: null, payload_size: PAYLOAD_INLINE_MAX_BYTES - 1 }),
      ),
    ).toMatchObject({ reason: 'unreadable' });
  });

  it('is "unknown" only when the size is missing too', () => {
    expect(payloadPreviewState(row({ payload_preview: null, payload_size: null }))).toEqual({
      kind: 'absent',
      reason: 'unknown',
      size: null,
    });
  });

  it('never carries truncation onto a missing preview, whatever the flag says', () => {
    const state = payloadPreviewState(
      row({ payload_preview: null, payload_size: 800, payload_truncated: true }),
    );
    expect(state).not.toHaveProperty('truncated');
    // And nothing in the words suggests something was cut off.
    const copy = describePayloadPreview(state);
    expect(copy.note).not.toContain('first');
    expect(copy.note).not.toContain('…');
    expect(copy.title).not.toContain('Truncated');
  });

  it('treats an absent field as no preview rather than rendering `undefined`', () => {
    // A row from a response that predates these fields, or a fixture without
    // them: `undefined` must not fall through to the body branch.
    expect(
      payloadPreviewState({ payload_preview: undefined, payload_size: undefined } as never),
    ).toMatchObject({ kind: 'absent', reason: 'unknown' });
  });
});

describe('the payload cell on the deliveries list', () => {
  it('shows a short body inline, as mono text, with its size', () => {
    const html = render();

    expect(html).toContain('ord_9');
    expect(html).toContain('font-mono');
    expect(html).toContain('51 B');
    // Nothing was cut, so nothing claims it was.
    expect(html).not.toContain('first 160');
  });

  it('says a truncated preview is truncated, and how big the body really is', () => {
    const html = render({
      payload_preview: `{"batch":[${'"leg",'.repeat(30)}`.slice(0, PAYLOAD_PREVIEW_MAX_CHARS),
      payload_truncated: true,
      payload_size: 2_400,
    });

    expect(html).toContain('first 160 chars of 2.3 KB');
    expect(html).toContain('Truncated');
    // The preview is still shown — truncated is not "unavailable".
    expect(html).toContain('batch');
  });

  it('states "too big to preview" WITH its size when the payload was offloaded', () => {
    const html = render({ payload_preview: null, payload_size: 96_000, payload_truncated: false });

    expect(html).toContain('No preview');
    expect(html).toContain('94 KB');
    expect(html).toContain('object storage');
    // No bytes came back, so nothing is dressed up as bytes.
    expect(html).not.toContain('font-mono');
    expect(html).not.toContain('first 160');
  });

  it('names both remaining causes when the row cannot tell them apart', () => {
    const html = render({ payload_preview: null, payload_size: 412, payload_truncated: false });

    expect(html).toContain('412 B');
    expect(html).toContain('reclaimed, or not UTF-8');
    // Not claimed as offloaded: 412 B was small enough to store inline.
    expect(html).not.toContain('object storage');
  });

  /*
   * THE BUG THIS CELL EXISTS TO PREVENT. `payload_preview ?? ''` renders an
   * empty body and an unavailable one as the same blank cell, and an operator
   * reads a blank cell as "this event was published with nothing in it".
   */
  it('renders an empty body differently from a preview that could not be produced', () => {
    const empty = render({ payload_preview: '', payload_size: 0 });
    const absent = render({ payload_preview: null, payload_size: 96_000 });

    expect(empty).toContain('Empty body');
    expect(empty).toContain('published with no body');
    expect(empty).not.toContain('No preview');

    expect(absent).toContain('No preview');
    expect(absent).not.toContain('Empty body');
    expect(empty).not.toEqual(absent);
  });

  it('says on hover what the preview is not, rather than implying it is signable', () => {
    expect(render()).toContain('not the bytes the signature was computed over');
  });
});
