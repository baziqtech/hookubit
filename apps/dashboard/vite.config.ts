import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Talk to the control plane in development without CORS.
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    // Playwright specs live under e2e/ and run against the real stack via
    // `pnpm test:e2e`; vitest must not try to collect them.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
