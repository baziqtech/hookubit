import type { ReactNode } from 'react';
import { API_BASE_URL_VAR } from '../lib/api-base-url';

export interface ApiConfigGateProps {
  /** `apiConfigError` from `../lib/api-base-url`. `null` means boot normally. */
  configError: string | null;
  /** The app. Constructed by the caller, rendered only on the healthy path. */
  children: ReactNode;
}

/**
 * The one decision `main.tsx` makes before the dashboard exists: app, or
 * explanation.
 *
 * A component rather than an `if` at the call site so both branches are
 * testable without a DOM — `renderToStaticMarkup` can assert that the error
 * path shows the panel AND that it does not render the app, which is the half
 * that matters. (`children` is a React element either way; creating it does not
 * run it, so nothing of the app mounts on the error path.)
 */
export function ApiConfigGate({ configError, children }: ApiConfigGateProps) {
  if (configError !== null) return <ApiConfigErrorPanel message={configError} />;
  return <>{children}</>;
}

export interface ApiConfigErrorPanelProps {
  /** `apiConfigError` from `../lib/api-base-url`. */
  message: string;
}

/**
 * What a misconfigured deploy shows INSTEAD of the dashboard.
 *
 * `resolveApiBaseUrl` refuses a production build with no `VITE_API_BASE_URL`,
 * and that refusal is correct and unconditional — the alternative is a
 * dashboard that requests `/v1/projects` from its own hostname, gets the SPA
 * shell with a 200, and fails screen by screen with nothing naming the cause.
 * But the refusal used to happen as a throw during module evaluation, so what
 * an operator actually got was a white page and a console line. The audience
 * for that message is someone who has just typed build variables into
 * Cloudflare; they are not holding devtools open, and a blank page reads as "my
 * deploy is broken", not as "I missed a variable".
 *
 * THREE CONSTRAINTS, all load-bearing:
 *
 *  1. NO PROVIDERS, NO ROUTER, NO DATA LAYER. This renders when the app's
 *     configuration is broken, so it must not need anything the app sets up.
 *     Its only import is the variable's name, from the same module that
 *     produced the message, so the two cannot drift.
 *
 *  2. BOTH COLOUR SCHEMES, with no `dark:` variants — the palette tokens
 *     (`bg-canvas`, `text-ink`, `border-line`) resolve through CSS variables
 *     that `index.css` redefines under `[data-theme="dark"]`, and the attribute
 *     is set before first paint by the inline script in `index.html`. That
 *     script is independent of React and of `src/lib/theme.ts`, so the theme is
 *     already correct here even though no provider has run. This is the same
 *     convention every other component uses; nothing is special-cased.
 *
 *  3. NOTHING PRIVATE. The hostname serving this page is public, so this panel
 *     is public. It prints the variable's NAME, the documented example value,
 *     and the validator's own sentence. It never echoes a configured value
 *     back, which is why `apiConfigError`'s producers quote only what the
 *     operator typed when the value is malformed — and why that path cannot
 *     reach a public deploy at all, since a malformed value fails in
 *     development too.
 */
export function ApiConfigErrorPanel({ message }: ApiConfigErrorPanelProps) {
  return (
    <div
      role="alert"
      className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10 font-sans text-ink"
    >
      <div className="w-full max-w-xl rounded-lg border border-line bg-panel p-6 shadow-sm">
        <p className="text-2xs font-semibold uppercase tracking-wider text-danger">
          Configuration error
        </p>
        <h1 className="mt-2 text-lg font-semibold text-ink">
          The dashboard is missing <code className="font-mono">{API_BASE_URL_VAR}</code>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{message}</p>

        <div className="mt-5 rounded-md border border-line bg-raised p-4">
          <p className="text-xs font-medium text-ink">Where to set it</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            Cloudflare dashboard → Workers &amp; Pages → this project → Settings → Build →{' '}
            <span className="text-ink">Variables and secrets</span>. Add it as plain text, then
            redeploy — Vite compiles the value into the bundle at build time, so changing it needs a
            new build.
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-code px-3 py-2 font-mono text-2xs leading-relaxed text-code-ink">
            {API_BASE_URL_VAR}=https://api.hookubit.com
          </pre>
          <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
            The control API&rsquo;s origin: scheme and host only — no <code>/v1</code>, no trailing
            slash.
          </p>
        </div>
      </div>
    </div>
  );
}
