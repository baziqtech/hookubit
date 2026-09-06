import { Outlet } from 'react-router-dom';

/**
 * Auth pages sit outside the shell — there is no organization or project
 * context to render yet, and showing empty switchers would be a lie.
 */
export function AuthLayout() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[22rem]">
        <div className="mb-6 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded bg-ink text-xs font-bold text-canvas"
          >
            W
          </span>
          <span className="text-sm font-semibold tracking-tight">Webhooks</span>
        </div>
        <Outlet />
      </div>
      <p className="mt-8 text-2xs text-ink-subtle">
        Sessions are HTTP-only cookies. Nothing is stored in this browser.
      </p>
    </div>
  );
}
