/**
 * One place that knows how to read a list response.
 *
 * The control API returns THREE different list envelopes (see `OffsetPage`,
 * `CountedOffsetPage` and `TotalPage` in `src/types/api.ts`). Every list screen
 * needs the same two facts out of them — the rows, and whether the server had
 * more it did not send — so the arithmetic lives here once instead of being
 * re-derived per page.
 *
 * The rule this file exists to enforce, from `ProjectListDto`:
 *
 *   "Never compare `count` against `limit` to detect the last page — read
 *   `has_more`."
 *
 * A caller that received exactly `limit` rows cannot tell a full page from a
 * complete result. That is not a cosmetic bug: "revoke every key that can
 * authenticate as us" quietly covering only the first page is the failure the
 * envelope was introduced to close.
 */
import type { CountedOffsetPage, OffsetPage, TotalPage } from '../types/api';
import { DEFAULT_PAGE_SIZE } from '../types/api';

/** The normalised list result every page component consumes. */
export interface Paged<T> {
  rows: T[];
  /** True when the server has rows beyond this page. Never inferred from length. */
  hasMore: boolean;
  /** Offset that returns the next page, or null on the last one. */
  nextOffset: number | null;
  /** Rows across the whole collection, when the envelope carries one. */
  total: number | null;
}

export const emptyPage = <T>(): Paged<T> => ({
  rows: [],
  hasMore: false,
  nextOffset: null,
  total: 0,
});

/**
 * `{ data, has_more, next_offset }` and `{ data, count, has_more, next_offset }`.
 *
 * `count` is deliberately ignored: it is the length of THIS page, not a total,
 * and treating it as one is the exact confusion `has_more` was added to
 * prevent. `has_more` is read as written — a truthiness test would turn a
 * missing field into "complete", which is the silent-truncation failure again.
 */
export function offsetPage<T>(page: OffsetPage<T> | CountedOffsetPage<T>): Paged<T> {
  const rows = page?.data ?? [];
  const hasMore = page?.has_more === true;
  return {
    rows,
    hasMore,
    // Trust the server's offset when it sent one; fall back to arithmetic only
    // if `has_more` is true and `next_offset` was omitted, which would be a bug
    // on the wire rather than a normal response.
    nextOffset: page?.next_offset ?? null,
    total: null,
  };
}

/**
 * `{ data, total, limit, offset }` — organizations and members.
 *
 * This envelope has no `has_more` and no `next_offset`, so both are derived
 * here and nowhere else. `offset + data.length < total` is the whole
 * definition; note it uses the ROWS RETURNED, not `limit`, so a short final
 * page reads as complete rather than promising one more empty page.
 */
export function totalPage<T>(page: TotalPage<T>): Paged<T> {
  const rows = page?.data ?? [];
  const total = typeof page?.total === 'number' ? page.total : rows.length;
  const offset = typeof page?.offset === 'number' ? page.offset : 0;
  const seen = offset + rows.length;
  const hasMore = seen < total;
  return { rows, hasMore, nextOffset: hasMore ? seen : null, total };
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
 * Human range for a pager, 1-based and inclusive: "51–100".
 * `total` is shown only when the envelope actually carried one — inventing a
 * total from a page that has no total is how "1–50 of 50" gets rendered over a
 * collection of four thousand.
 */
export function pageRange(offset: number, page: Paged<unknown>): string {
  if (page.rows.length === 0) return 'No results';
  const first = offset + 1;
  const last = offset + page.rows.length;
  const span = first === last ? `${first}` : `${first}–${last}`;
  if (page.total !== null) return `${span} of ${page.total}`;
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
