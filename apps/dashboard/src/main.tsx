import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ApiConfigGate } from './components/ApiConfigErrorPanel';
import { DemoDataBanner } from './components/DemoDataBanner';
import './index.css';
import { ApiRequestError } from './lib/api';
import { apiConfigError } from './lib/api-base-url';
import { router } from './routes/router';

// Server state lives in TanStack Query; Zustand is reserved for state that is
// genuinely client-only (ARCHITECTURE.md 65).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      // Retrying a 4xx just makes the user wait for the same answer. 429 and
      // 5xx are worth one more go. A request DEADLINE is deliberately a 408,
      // so it lands on the left of this and is not retried — see
      // `API_REQUEST_TIMEOUT_MS` in ./lib/api.ts for why retrying a timeout
      // would hold the spinner for ~50 s to show the same sentence.
      retry: (failureCount, error) =>
        failureCount < 2 && (!(error instanceof ApiRequestError) || error.retryable),
    },
  },
});

// The theme is applied before first paint by the inline script in index.html,
// and owned from there by `src/lib/theme.ts`. See the note in that file.

const root = ReactDOM.createRoot(document.getElementById('root')!);

/*
 * THE CONFIG BRANCH, before anything is mounted.
 *
 * `apiConfigError` is set when `VITE_API_BASE_URL` is missing or unusable in a
 * production build, which is a deploy that cannot work: see
 * ./lib/api-base-url.ts. Rendering the app anyway is not an option — it would
 * request relative `/v1` paths from the Cloudflare hostname and be served the
 * SPA shell with a 200. So the app does not mount, exactly as before; the only
 * change is that the reason is now ON THE PAGE instead of only in the console,
 * where the operator who caused it was never going to see it.
 *
 * The panel needs none of the providers below — see its own docblock. The
 * app's modules are still imported statically, which is a deliberate trade:
 * splitting them behind a dynamic `import()` would isolate the panel from any
 * OTHER module-load failure too, at the cost of a runtime-injected
 * modulepreload — one extra round trip before first paint on every healthy
 * load, which is all of them. The configuration refusal is the only
 * module-load throw this app has by design, and it no longer throws.
 */
root.render(
  <ApiConfigGate configError={apiConfigError}>
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        {/* Above the router on purpose: the auth pages render outside the app
            shell, and a build serving mock data must say so there too. */}
        <DemoDataBanner />
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>
  </ApiConfigGate>,
);
