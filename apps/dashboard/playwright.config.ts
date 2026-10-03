import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end proof against the REAL stack, not the mock.
 *
 * Prerequisites (this config does not start them, on purpose - they are the
 * developer's running environment, and starting a second control API or data
 * plane against the same database is exactly the concurrent-run trap the Go
 * test suite guards against):
 *
 *   - control API on :3000 with ALLOW_OPEN_REGISTRATION=true and SMTP_URL
 *     pointing at Mailpit (smtp://localhost:1025, API on :8025)
 *   - the data plane (`webhookd all`) with EGRESS_ALLOW_PRIVATE_NETWORKS=true,
 *     so a receiver on 127.0.0.1 is a legal endpoint
 *   - PostgreSQL, Redis, MinIO as in docs/LOCAL_SETUP.md
 *
 * What it DOES start: the Vite dev server with the HTTP transport (the mock is
 * the default and would prove nothing), and the local webhook receiver the
 * delivery tests point an endpoint at.
 */
// Overridable so a run does not have to take down the dev server someone is
// using: `E2E_PORT=5273 E2E_RECEIVER_PORT=9897 pnpm test:e2e`.
const DASHBOARD_PORT = Number(process.env.E2E_PORT ?? 5173);
export const RECEIVER_PORT = Number(process.env.E2E_RECEIVER_PORT ?? 9797);

export default defineConfig({
  testDir: './e2e',
  // The flows build on each other (register -> project -> key -> endpoint ->
  // publish -> delivery). One worker, in file order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `VITE_API_TRANSPORT=http pnpm exec vite --port ${DASHBOARD_PORT} --strictPort`,
      url: `http://localhost:${DASHBOARD_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node e2e/support/receiver-server.mjs ${RECEIVER_PORT}`,
      url: `http://127.0.0.1:${RECEIVER_PORT}/__health`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
  ],
});
