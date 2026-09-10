import { Outlet } from 'react-router-dom';
import { AUTH_STYLES } from '../features/auth/auth-styles';
import { Wordmark } from '../features/auth/Wordmark';

/**
 * The shell every auth page sits in: one centred column on a flat canvas.
 *
 * ## Why there is nothing else on this page
 *
 * The previous version was a split screen — form on the left, an animated
 * delivery diagram on the right, over a dot grid and an accent glow, with a
 * feature checklist under it. That is the house style of every generated SaaS
 * login, and it read as one: heavily decorated and completely characterless.
 *
 * The three references this was rebuilt against — getconvoy.io, the direct
 * competitor; antigravity.google; flutter.dev — have exactly none of it
 * between them. What they do have in common is worth stating, because it is
 * the whole brief:
 *
 *   - ONE CENTRED COLUMN. Not one of the three splits the screen.
 *   - THE TYPE IS THE DESIGN. Convoy's hero is 40px at weight 500;
 *     Antigravity's is 80px at 450. Both are near-black on near-white.
 *   - FLAT. No glow, no dot grid, no floating card, no soft shadow. Convoy is
 *     #fafafa with hairline rules — which is, near enough exactly, this
 *     product's own `canvas` token.
 *   - COLOUR IS RARE AND SOLID. One accent, used flat and on purpose, never
 *     as a gradient wash.
 *
 * So: `canvas` everywhere, fields on `panel` (a hairline of separation, no
 * elevation), the accent only on the submit and the links, and the largest
 * thing on the screen is a sentence.
 *
 * The column is the same 25rem measure from the wordmark down to the footnote,
 * so nothing floats free of the thing below it.
 */
export function AuthLayout() {
  return (
    <div className="hb-auth flex min-h-screen flex-col bg-canvas px-5 py-10 sm:px-8">
      <style>{AUTH_STYLES}</style>

      <main className="mx-auto flex w-full max-w-[25rem] flex-1 flex-col justify-center py-10">
        {/*
          The mark sits directly above the headline rather than pinned to the
          top of the viewport: all three references group it with the words it
          belongs to, and a logo alone in a corner with 250px of nothing under
          it is the layout of a page that has not been composed.
        */}
        <Wordmark className="mb-9 justify-center" />
        <Outlet />
      </main>

      <footer className="shrink-0 text-center text-2xs leading-relaxed text-ink-subtle">
        Sessions are HTTP-only cookies. Nothing is stored in this browser.
      </footer>
    </div>
  );
}
