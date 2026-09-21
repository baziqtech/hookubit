import { Outlet } from 'react-router-dom';
import { AUTH_STYLES } from '../features/auth/auth-styles';
import { ThemeToggle } from '../components';
import { Wordmark } from '../features/auth/Wordmark';
import { BrandPanel } from '../features/auth/BrandPanel';

/**
 * The shell every auth page sits in.
 *
 * ## The third answer, and why the second one was replaced
 *
 * The FIRST version was a split screen with an animated delivery diagram, a
 * dot grid, an accent glow and a feature checklist. It was the house style of
 * every generated SaaS login and read as one.
 *
 * The SECOND was one centred column on a flat canvas, rebuilt against
 * getconvoy.io, antigravity.google and flutter.dev — none of which splits the
 * screen. It was honest, and it said nothing. Removing generic decoration does
 * not leave a brand behind if there was never one underneath it.
 *
 * This is the third, and it is what the design file asks for: a split again,
 * but the panel's content is the PRODUCT'S OWN RECORD — three rows of the
 * delivery table at the size it is actually read, showing one event reaching
 * three endpoints with one of them on its third attempt. Somebody who has
 * never seen this product learns what it does from that table rather than
 * from an adjective. That is a different kind of thing from a diagram of boxes
 * and arrows, and it is the difference the second version was reaching for.
 *
 * Everything the second version established survives it: flat surfaces, no
 * glow and no floating card, the accent only on the submit and the links, and
 * the largest thing on the screen is a sentence.
 *
 * ## Below `lg` it is the centred column again
 *
 * On a phone the panel would push the form below the fold, and somebody on a
 * phone is signing in, not evaluating.
 */
export function AuthLayout() {
  return (
    <div className="hb-auth flex min-h-screen bg-canvas">
      <style>{AUTH_STYLES}</style>

      <BrandPanel className="w-[26rem] shrink-0 xl:w-[32rem]" />

      <div className="flex min-w-0 flex-1 flex-col px-5 py-10 sm:px-8">
        <main className="mx-auto flex w-full max-w-[25rem] flex-1 flex-col justify-center py-10">
          {/*
            The mark sits directly above the headline rather than pinned to the
            top of the viewport: a logo alone in a corner with 250px of nothing
            under it is the layout of a page that has not been composed. It is
            hidden at `lg`, where the brand panel already carries it.
          */}
          <Wordmark className="mb-9 justify-center lg:hidden" />
          <Outlet />
        </main>

        <footer className="flex shrink-0 flex-col items-center gap-4">
          <ThemeToggle />
          {/*
            This used to read "Nothing is stored in this browser", which the
            theme preference directly above it would have made false. The claim
            worth making is the one about credentials, and it is still true: the
            session is an HTTP-only cookie no script can read.
          */}
          <p className="text-center text-2xs leading-relaxed text-ink-subtle">
            Sessions are HTTP-only cookies — no token is readable by this page.
          </p>
        </footer>
      </div>
    </div>
  );
}
