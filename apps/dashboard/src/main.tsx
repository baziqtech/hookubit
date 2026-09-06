import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
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

// Follow the OS theme on first paint. A per-user preference belongs in the
// account settings once that endpoint exists, not in localStorage guesswork.
if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.dataset.theme = 'dark';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
