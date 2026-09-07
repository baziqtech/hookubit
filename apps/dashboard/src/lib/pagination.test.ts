import { describe, expect, it } from 'vitest';
import { booleanParam, offsetPage, pageRange, totalPage } from './pagination';
import type { CountedOffsetPage, OffsetPage, TotalPage } from '../types/api';

/**
 * The property under test is one thing: A FULL PAGE MUST NOT LOOK LIKE A
 * COMPLETE RESULT.
 *
 * That is the whole reason the list routes stopped returning bare arrays. A
 * caller receiving exactly `limit` rows cannot tell the two apart, and the
 * consequence is not cosmetic — "revoke every key that can authenticate as us"
 * quietly covering only the first page is the failure the envelope closes.
 */
describe('offsetPage — endpoints, endpoint secrets, projects, API keys', () => {
  it('reports a FULL page as incomplete, not as the whole result', () => {
    const wire: OffsetPage<{ id: string }> = {
      data: Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}` })),
      has_more: true,
      next_offset: 50,
    };

    const page = offsetPage(wire);

    expect(page.rows).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(50);
  });

  it('reports a complete result as complete even when it exactly fills the page', () => {
    // Same row count as above. ONLY `has_more` distinguishes them, which is
    // why nothing may infer completeness from the length.
    const wire: OffsetPage<{ id: string }> = {
      data: Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}` })),
      has_more: false,
      next_offset: null,
    };

    const page = offsetPage(wire);

    expect(page.rows).toHaveLength(50);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('ignores `count`, which is this page’s length and never a total', () => {
    const wire: CountedOffsetPage<{ id: string }> = {
      data: [{ id: 'a' }, { id: 'b' }],
      count: 2,
      has_more: true,
      next_offset: 2,
    };

    const page = offsetPage(wire);

    // `count === data.length` must not be read as "that is everything".
    expect(page.hasMore).toBe(true);
    expect(page.total).toBeNull();
  });

  it('treats a missing has_more as NOT complete-by-default', () => {
    // A malformed envelope must not silently claim completeness. `has_more`
    // is compared to `true`, so anything else is false — but `nextOffset`
    // stays null, so the pager cannot advance into nothing.
    const page = offsetPage({ data: [{ id: 'a' }] } as unknown as OffsetPage<{ id: string }>);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });
});

describe('totalPage — organizations and members', () => {
  it('derives has_more from offset + rows < total, because the envelope has neither', () => {
    const wire: TotalPage<{ id: string }> = {
      data: [{ id: 'a' }, { id: 'b' }],
      total: 7,
      limit: 2,
      offset: 0,
    };

    const page = totalPage(wire);

    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(2);
    expect(page.total).toBe(7);
  });

  it('reports the last page as complete, using rows returned rather than limit', () => {
    // A short final page: offset 6 + 1 row === total. Using `limit` here would
    // promise one more page that does not exist.
    const page = totalPage({ data: [{ id: 'g' }], total: 7, limit: 2, offset: 6 });

    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('reports a full page that exactly reaches the total as complete', () => {
    const page = totalPage({
      data: [{ id: 'f' }, { id: 'g' }],
      total: 7,
      limit: 2,
      offset: 5,
    });

    expect(page.hasMore).toBe(false);
  });
});

describe('pageRange', () => {
  it('never invents a total for an envelope that does not carry one', () => {
    const page = offsetPage({
      data: [{ id: 'a' }, { id: 'b' }],
      has_more: true,
      next_offset: 2,
    });
    // "1–2 of 2" over a collection of thousands would be a lie.
    expect(pageRange(0, page)).toBe('1–2 of more');
  });

  it('uses the real total when the envelope carries one', () => {
    const page = totalPage({ data: [{ id: 'a' }], total: 9, limit: 1, offset: 4 });
    expect(pageRange(4, page)).toBe('5 of 9');
  });

  it('says so when there is nothing', () => {
    expect(pageRange(0, offsetPage({ data: [], has_more: false, next_offset: null }))).toBe(
      'No results',
    );
  });
});

describe('booleanParam', () => {
  /**
   * `?flag=false` was being parsed as true, because `Boolean('false')` is
   * `true`. The API now compares the string, so the dashboard must send the
   * literal words — never `1`/`0`, never a bare flag.
   */
  it('sends the literal strings the BooleanQuery decorator matches', () => {
    expect(booleanParam(true)).toBe('true');
    expect(booleanParam(false)).toBe('false');
  });

  it('omits the parameter entirely when unset, so the server default applies', () => {
    expect(booleanParam(undefined)).toBeUndefined();
  });
});
