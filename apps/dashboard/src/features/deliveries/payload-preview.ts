import { formatBytes } from '../../lib/format';
import {
  PAYLOAD_INLINE_MAX_BYTES,
  PAYLOAD_PREVIEW_MAX_CHARS,
  type DeliveryListItem,
} from '../../types/api';

/**
 * The three payload fields of a delivery LIST row, as four cases a cell can
 * render without lying about any of them.
 *
 * The fields are `payload_preview`, `payload_size` and `payload_truncated`, and
 * the trap is that the first has FOUR meanings, not two:
 *
 *   - a body, shown whole;
 *   - a body, shown to its first `PAYLOAD_PREVIEW_MAX_CHARS` characters;
 *   - `""` — an event published with an EMPTY body. It is a fact about the
 *     event, and a blank cell is the one rendering that loses it;
 *   - `null` — NO PREVIEW COULD BE PRODUCED. Not "empty". The payload is in
 *     object storage, or retention reclaimed the bytes, or they are not UTF-8.
 *
 * Rendering `payload_preview ?? ''` collapses the last two into the same blank
 * cell, which is why this returns a discriminated union instead of a string:
 * `empty` and `absent` cannot reach the same branch by accident.
 *
 * `truncated` exists ONLY on `body`. The server sets `payload_truncated` false
 * whenever the preview is null, and modelling it this way means a cell cannot
 * draw an ellipsis after nothing even if that ever stopped being true.
 */
export type PayloadPreviewState =
  | { kind: 'body'; text: string; truncated: boolean; size: number | null }
  | { kind: 'empty'; size: number | null }
  | { kind: 'absent'; reason: AbsentReason; size: number | null };

/**
 * Why there is no preview, as far as a list row can tell.
 *
 * The API names three causes and the row distinguishes what it can:
 *
 *   - `offloaded` — `payload_size` is at or above `PAYLOAD_INLINE_MAX_BYTES`, so
 *     `payload_raw` is NULL by design and the body is in object storage. The
 *     size is exact, recorded at ingest, so "too big to preview" is always
 *     sayable WITH its size.
 *   - `unreadable` — a body small enough to have been stored inline, with no
 *     preview: retention reclaimed the bytes, or they are not valid UTF-8 (a
 *     gzipped or binary body). THE LIST CANNOT TELL THESE TWO APART — nothing
 *     on the row separates them — so the copy names both rather than guessing,
 *     and the event page is where the answer is.
 *   - `unknown` — no size either, which per the DTO happens only when the event
 *     row itself could not be read.
 */
export type AbsentReason = 'offloaded' | 'unreadable' | 'unknown';

/** Just the three fields, so callers can pass a row or a literal. */
export type PayloadPreviewFields = Pick<
  DeliveryListItem,
  'payload_preview' | 'payload_size' | 'payload_truncated'
>;

export function payloadPreviewState(row: PayloadPreviewFields): PayloadPreviewState {
  const size = row.payload_size ?? null;

  // `== null` on purpose: a row from an older list response, or from a fixture
  // written before these fields existed, carries `undefined` rather than null,
  // and "the field is not there" is the same fact as "there is no preview" —
  // whereas `=== null` would fall through and render `undefined` as a body.
  if (row.payload_preview == null) {
    if (size === null) return { kind: 'absent', reason: 'unknown', size };
    return {
      kind: 'absent',
      reason: size >= PAYLOAD_INLINE_MAX_BYTES ? 'offloaded' : 'unreadable',
      size,
    };
  }

  if (row.payload_preview === '') return { kind: 'empty', size };

  return { kind: 'body', text: row.payload_preview, truncated: row.payload_truncated, size };
}

/**
 * The words for a state: what goes in the cell, and the long version.
 *
 * `label` is the stand-in for the bytes when there are none to show — null on
 * `body`, where the preview itself is the content. `note` is the one-line
 * qualification under it. `title` is the whole story on hover, because the cell
 * is one line wide and the thing most worth saying about a preview — that it is
 * not what the signature was computed over — does not fit in it.
 */
export interface PayloadPreviewCopy {
  label: string | null;
  note: string;
  title: string;
}

const NOT_THE_SIGNED_BYTES =
  'A preview, decoded as text — not the bytes the signature was computed over.';

export function describePayloadPreview(state: PayloadPreviewState): PayloadPreviewCopy {
  switch (state.kind) {
    case 'body':
      return state.truncated
        ? {
            label: null,
            note:
              state.size === null
                ? `first ${PAYLOAD_PREVIEW_MAX_CHARS} chars`
                : `first ${PAYLOAD_PREVIEW_MAX_CHARS} chars of ${formatBytes(state.size)}`,
            title:
              `Truncated: the first ${PAYLOAD_PREVIEW_MAX_CHARS} characters of the body. ` +
              'It is cut by character count, not at a structural boundary, so it is very often ' +
              `invalid JSON. ${NOT_THE_SIGNED_BYTES} Open the delivery for the whole payload.`,
          }
        : {
            label: null,
            note: state.size === null ? 'the whole body' : formatBytes(state.size),
            title: `The whole body, short enough to fit. ${NOT_THE_SIGNED_BYTES}`,
          };

    case 'empty':
      return {
        label: 'Empty body',
        note: 'published with no body',
        title:
          'This event was published with an empty body — zero bytes, which is a fact about the ' +
          'event and not a preview that could not be produced.',
      };

    case 'absent':
      return absentCopy(state.reason, state.size);
  }
}

function absentCopy(reason: AbsentReason, size: number | null): PayloadPreviewCopy {
  const bytes = size === null ? null : formatBytes(size);

  switch (reason) {
    case 'offloaded':
      return {
        label: 'No preview',
        note: `${bytes} · held in object storage`,
        title:
          `This body is ${bytes}, at or above the ${formatBytes(PAYLOAD_INLINE_MAX_BYTES)} ` +
          'inline limit, so it lives in object storage and the list does not fetch it — 200 rows ' +
          'would be 200 object reads. The size is exact, recorded at ingest. Open the event to ' +
          'read the body.',
      };

    case 'unreadable':
      return {
        label: 'No preview',
        note: `${bytes} · reclaimed, or not UTF-8`,
        title:
          `The body is ${bytes} and small enough to have been stored inline, but no preview ` +
          'could be produced: either retention has reclaimed the bytes, or they are not valid ' +
          'UTF-8 — a gzipped or binary body, which would decode to replacement characters that ' +
          'look like data. This list cannot tell those two apart; the event page can.',
      };

    case 'unknown':
      return {
        label: 'No preview',
        note: 'the event could not be read',
        title:
          'Neither a preview nor a size came back for this delivery, which per the API means the ' +
          'event row itself could not be read. The delivery is still on the ledger.',
      };
  }
}
