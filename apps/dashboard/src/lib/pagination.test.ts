import { describe, expect, it } from 'vitest';
import { booleanParam, offsetPage, pageRange } from './pagination';
import type { OffsetPage } from '../types/api';

/**
 * The property under test is one thing: A FULL PAGE MUST NOT LOOK LIKE A
 * COMPLETE RESULT.
 *
 * That is the whole reason the list routes stopped returning bare arrays. A
 * caller receiving exactly `limit` rows cannot tell the two apart, and the
 * consequence is not cosmetic — "revoke every key that can authenticate as us"
 * quietly covering only the first page is the failure the envelope closes.
 */
describe('offsetPage — every list route, because there is now ONE envelope', () => {
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

  /**
   * `next_offset` is typed `number | null` on every envelope now, so this is no
   * longer a type repair — it is the runtime guard at the wire boundary. An
   * older deployment or a proxy that rewrote the body could still put a
   * non-number here, and read without a check it would go into a URL as
   * `[object Object]` and step the pager into nothing.
   */
  it('refuses a next_offset that is not a number', () => {
    const page = offsetPage({
      data: [{ id: 'a' }],
      has_more: true,
      next_offset: {},
    } as unknown as OffsetPage<{ id: string }>);

    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBeNull();
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

describe('pageRange', () => {
  it('never invents a total — NO envelope carries one any more', () => {
    const page = offsetPage({
      data: [{ id: 'a' }, { id: 'b' }],
      has_more: true,
      next_offset: 2,
    });
    // "1–2 of 2" over a collection of thousands would be a lie.
    expect(pageRange(0, page)).toBe('1–2 of more');
  });

  it('states a complete result as complete rather than as a total it was not given', () => {
    const page = offsetPage({ data: [{ id: 'a' }], has_more: false, next_offset: null });
    expect(pageRange(4, page)).toBe('5 of 5');
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
