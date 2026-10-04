import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { DemoDataBanner } from './components/DemoDataBanner';
import './index.css';
import { ApiRequestError } from './lib/api';
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
 * NOTHING STANDS BETWEEN THIS AND THE APP.
 *
 * There used to be an `ApiConfigGate` here that refused to mount when a
 * base-URL build variable was missing from a production build. The dashboard and
 * the control API now share one origin — nginx serves this bundle and proxies
 * `/v1` to the API on the same hostname — so there is no base URL to configure,
 * nothing to validate, and no deploy-time misconfiguration for a panel to
 * report. See the note at the top of `./lib/api.ts`.
 *
 * `VITE_API_TRANSPORT` is the one build variable left that can ruin a deploy,
 * and it CANNOT be checked here: unset means the in-memory mock, which is the
 * correct and useful default for `pnpm dev`. `DemoDataBanner` below is the
 * whole defence — a permanent banner on every page, including the auth pages
 * outside the app shell, saying the data is not real.
 */
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Above the router on purpose: the auth pages render outside the app
          shell, and a build serving mock data must say so there too. */}
      <DemoDataBanner />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
