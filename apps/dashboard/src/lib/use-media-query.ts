import { useEffect, useState } from 'react';

/**
 * Does this media query match right now?
 *
 * ## Why this exists rather than two CSS-hidden renderings
 *
 * `Table` needs a genuinely different DOM on a phone — cards, not rows —
 * because restyling table elements into blocks destroys the table semantics the
 * operator surface depends on. The obvious way to get two DOMs is to render
 * both and `display: none` the wrong one.
 *
 * That was tried and it is wrong for this product for two reasons. A table here
 * can hold two hundred rows, and rendering every one of them twice doubles the
 * DOM to show half of it. And the hidden copy is still FOUND — by
 * `getByText().first()`, by the browser's own find-in-page, by anything that
 * reads the document rather than the accessibility tree — so the first match
 * for a piece of text on the page is an element nobody can see.
 *
 * ## Why it starts false
 *
 * Server-rendered markup and the first client paint both get the DESKTOP
 * branch, which is the dominant case and the one every unit test renders. A
 * phone corrects itself in the same tick as the first effect, before paint in
 * practice, and a momentary table on a phone is a far cheaper wrong answer than
 * a momentary card list on a desk.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    // `matchMedia` is absent in the static-markup renderer this workspace tests
    // with (there is no jsdom — see HANDOFF.md), so this has to survive not
    // existing rather than assume a browser.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const list = window.matchMedia(query);
    setMatches(list.matches);

    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Below Tailwind's `md`. The breakpoint at which rows become cards. */
export const PHONE_QUERY = '(max-width: 767px)';
