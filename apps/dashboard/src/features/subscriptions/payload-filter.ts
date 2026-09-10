/**
 * The `payload_filter` textarea, as a value the API will accept the SHAPE of.
 *
 * The full predicate grammar lives in control-api
 * `src/webhook-subscriptions/payload-filter.ts` and is deliberately NOT
 * mirrored here: it is sixty lines of operator rules that are still changing,
 * and a stale client-side copy would refuse filters the server takes. What is
 * checked is what the server refuses BEFORE it reads the grammar — the text
 * must be JSON, the JSON must be an object, the object must not be empty, and
 * the serialised size must fit — because those are the mistakes a person makes
 * in a textarea and each has one unambiguous sentence.
 *
 * Everything past that — an unknown operator, a `$`-prefixed path, a
 * five-deep nest — comes back from the server as a 400 naming
 * `payload_filter`, and the form puts it under this field.
 *
 * NOTE THE STATE OF PLAY: the data plane does not evaluate payload filters
 * yet. A stored filter is inert, and the form says so above the textarea.
 */
import { MAX_PAYLOAD_FILTER_BYTES } from '../../types/api';

export type ParsedPayloadFilter =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 length of the serialised form, which is what the server measures. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Blank text is "no filter" — sent as `null`, which is how the field is cleared. */
export function parsePayloadFilterInput(text: string): ParsedPayloadFilter {
  if (text.trim().length === 0) return { ok: true, value: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'This is not valid JSON.' };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'payload_filter must be a JSON object, or blank for no filter' };
  }
  if (Object.keys(parsed).length === 0) {
    // The widening direction: a predicate that constrains nothing matches
    // every payload while the row reads as filtered.
    return {
      ok: false,
      reason:
        'An empty object would match every payload. Leave the field blank if you do not want to filter on the body',
    };
  }

  const bytes = byteLength(JSON.stringify(parsed));
  if (bytes > MAX_PAYLOAD_FILTER_BYTES) {
    return {
      ok: false,
      reason: `payload_filter is ${bytes} bytes; the maximum is ${MAX_PAYLOAD_FILTER_BYTES}`,
    };
  }

  return { ok: true, value: parsed };
}

/** The stored predicate as the textarea shows it — pretty-printed, or empty for null. */
export function formatPayloadFilterInput(filter: Record<string, unknown> | null): string {
  return filter === null ? '' : JSON.stringify(filter, null, 2);
}

export function validatePayloadFilterInput(text: string): true | string {
  const parsed = parsePayloadFilterInput(text);
  return parsed.ok ? true : parsed.reason;
}
