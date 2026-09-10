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
      // 5xx are worth one more go.
      retry: (failureCount, error) =>
        failureCount < 2 && (!(error instanceof ApiRequestError) || error.retryable),
    },
  },
});

// The theme is applied before first paint by the inline script in index.html,
// and owned from there by `src/lib/theme.ts`. See the note in that file.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Above the router on purpose: the auth pages render outside the app
          shell, and a build serving mock data must say so there too. */}
      <DemoDataBanner />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
