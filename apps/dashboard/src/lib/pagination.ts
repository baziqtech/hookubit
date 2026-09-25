/**
 * One place that knows how to read a list response.
 *
 * THE ENVELOPE IS NOW ONE SHAPE, NOT THREE. Every `*ListDto` in the generated
 * OpenAPI document is `{ data, has_more, next_offset }`. The dashboard used to
 * model three — organizations and members as `{ data, total, limit, offset }`
 * and projects and API keys with an extra `count` — and read both of the ones
 * that no longer exist. See HANDOFF.md.
 *
 * The rule this file exists to enforce is unchanged, and is the reason the
 * envelope exists at all:
 *
 *   "Never compare the row count against `limit` to detect the last page —
 *    read `has_more`."
 *
 * A caller that received exactly `limit` rows cannot tell a full page from a
 * complete result. That is not a cosmetic bug: "revoke every key that can
 * authenticate as us" quietly covering only the first page is the failure the
 * envelope was introduced to close.
 */
import type { OffsetPage } from '../types/api';
import { DEFAULT_PAGE_SIZE } from '../types/api';

/** The normalised list result every page component consumes. */
export interface Paged<T> {
  rows: T[];
  /** True when the server has rows beyond this page. Never inferred from length. */
  hasMore: boolean;
  /** Offset that returns the next page, or null on the last one. */
  nextOffset: number | null;
}

export const emptyPage = <T>(): Paged<T> => ({
  rows: [],
  hasMore: false,
  nextOffset: null,
});

/**
 * `{ data, has_more, next_offset }` — every list route.
 *
 * `has_more` is read as written: a truthiness test would turn a missing field
 * into "complete", which is the silent-truncation failure again.
 *
 * `next_offset` is `number | null` on all thirteen envelopes and the generated
 * type now says so, so the guard below is no longer repairing a type — it is
 * repairing a RESPONSE. This function is the boundary between the wire and the
 * pager, and a non-number arriving here (an older deployment, a proxy that
 * rewrote the body) would otherwise go into a URL as `[object Object]` and step
 * the pager into nothing. Null is the safe answer: the pager stops.
 */
export function offsetPage<T>(page: OffsetPage<T>): Paged<T> {
  const rows = page?.data ?? [];
  const next = page?.next_offset;
  return {
    rows,
    hasMore: page?.has_more === true,
    nextOffset: typeof next === 'number' ? next : null,
  };
}

/**
 * Page-size for a list request. Clamped locally to the same ceiling the API
 * validates against, because asking for more is a 400 rather than a silent
 * clamp — a 400 on a page the operator did not choose is a support ticket.
 */
export function pageParams(offset: number, limit: number = DEFAULT_PAGE_SIZE) {
  return { limit, offset: offset > 0 ? offset : undefined };
}

/**
 * Human range for a pager, 1-based and inclusive: "51-100".
 *
 * NO ENVELOPE CARRIES A TOTAL any more, so none is ever shown: inventing one
 * from a page is how "1-50 of 50" gets rendered over a collection of four
 * thousand. `has_more` is the only completeness signal there is, and the copy
 * says which of the two cases this is.
 */
export function pageRange(offset: number, page: Paged<unknown>): string {
  if (page.rows.length === 0) return 'No results';
  const first = offset + 1;
  const last = offset + page.rows.length;
  const span = first === last ? `${first}` : `${first}–${last}`;
  return page.hasMore ? `${span} of more` : `${span} of ${last}`;
}

/**
 * Boolean query parameters must be sent as the literal strings `true`/`false`.
 *
 * The control API compares the string rather than coercing it, because
 * `Boolean('false')` is `true` and `?include_deleted=false` was therefore
 * turning soft-deleted rows ON, with a 200. Its `BooleanQuery` decorator treats
 * `'true'` and `'1'` as true and ANYTHING ELSE PRESENT as false, so sending
 * `'0'`, `''` or `'no'` is safe but sending nothing at all leaves the parameter
 * `undefined` and lets the server's own default apply. This helper never emits
 * a bare flag name and never emits `1`/`0`.
 */
export function booleanParam(value: boolean | undefined): 'true' | 'false' | undefined {
  return value === undefined ? undefined : value ? 'true' : 'false';
}
