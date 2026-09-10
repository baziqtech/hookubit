import { Outlet } from 'react-router-dom';
import { AUTH_STYLES } from '../features/auth/auth-styles';
import { DeliveryShowcase } from '../features/auth/DeliveryShowcase';
import { Wordmark } from '../features/auth/Wordmark';

/**
 * The shell every auth page sits in.
 *
 * Auth pages sit outside the app shell — there is no organization or project
 * context to render yet, and showing empty switchers would be a lie. What
 * replaces that context is the product's own story: a split screen, the form
 * on the left and the delivery ledger on the right.
 *
 * The form column is FIRST in the DOM and the showcase is `hidden` below
 * `lg`, so a phone gets the form and nothing between it and the keyboard —
 * and a screen reader or a text browser never has to walk past a decoration to
 * reach the thing it came for.
 *
 * The two halves use the same tokens as the rest of the product: the form side
 * is `panel` (so the fields, which are `canvas`, read as inset in both
 * themes) and the showcase side is `canvas` with a grid and an accent glow.
 * Nothing here is a second palette, and there is no `dark:` variant anywhere —
 * the theme is one token swap, as it is everywhere else.
 */
export function AuthLayout() {
  return (
    <div className="hb-auth min-h-screen bg-panel lg:grid lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <style>{AUTH_STYLES}</style>

      {/*
        One column, one left edge: the wordmark, the form and the footnote all
        sit inside the same 25rem measure, so nothing floats free of the thing
        below it. The column is centred in its half at every width.
      */}
      <div className="flex min-h-screen flex-col px-5 py-8 sm:px-8">
        <div className="mx-auto flex w-full max-w-[25rem] flex-1 flex-col">
          <header className="shrink-0">
            <Wordmark />
            {/* The showcase is gone at this width; one line keeps the promise. */}
            <p className="mt-3 text-xs leading-relaxed text-ink-muted lg:hidden">
              Reliable webhook delivery, with a record of every attempt.
            </p>
          </header>

          <main className="flex flex-1 items-center py-12">
            <div className="w-full">
              <Outlet />
            </div>
          </main>

          <footer className="shrink-0 text-2xs leading-relaxed text-ink-subtle">
            Sessions are HTTP-only cookies. Nothing is stored in this browser.
          </footer>
        </div>
      </div>

      <aside className="hidden lg:block">
        <DeliveryShowcase />
      </aside>
    </div>
  );
}
