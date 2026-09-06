import { usingMockApi } from '../lib/api';

/**
 * The build-is-fake warning.
 *
 * `resolveTransport()` in `src/lib/api.ts` falls back to the in-memory mock
 * unless `VITE_API_TRANSPORT=http`, and the container image does not set it.
 * Without this banner the resulting page is indistinguishable from a working,
 * signed-in product while every number on it is fabricated — a demo of that
 * build reads as a demo of the real thing.
 *
 * So: rendered once at the root, above the router, so it is present on the auth
 * pages as well as the shell; loud rather than tasteful; and with no dismiss
 * control, because the condition it reports does not go away by being
 * acknowledged. It disappears on its own the moment the real transport is
 * selected — the signal comes from `usingMockApi`, which is derived in exactly
 * one place.
 */
export function DemoDataBanner() {
  if (!usingMockApi) return null;

  return (
    <div
      role="alert"
      data-testid="demo-data-banner"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b-2 border-danger bg-danger px-4 py-2 text-center text-xs font-semibold text-white"
    >
      <span className="uppercase tracking-wider">
        Demo data — not connected to an API
      </span>
      <span className="font-normal opacity-90">
        Every value on this page is fabricated by the in-browser mock. Build with{' '}
        <code className="font-mono font-semibold">VITE_API_TRANSPORT=http</code> to talk to the
        control API.
      </span>
    </div>
  );
}
