/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `http` talks to the real control API; anything else uses the in-memory mock. */
  readonly VITE_API_TRANSPORT?: 'http' | 'mock';
  /**
   * Base URL of the INGEST API (Go, :8080) — a different surface from the
   * control API this dashboard otherwise talks to. Used only to build the
   * copy-paste `curl` on the get-started page. Defaults to `http://localhost:8080`.
   */
  readonly VITE_INGEST_BASE_URL?: string;
  /**
   * Origin of the CONTROL API — scheme and host, no `/v1`, no trailing slash,
   * e.g. `https://api.hookubit.com`. Prepended to every request made through
   * `src/lib/api.ts`.
   *
   * Unset is correct in development (Vite proxies `/v1`) and a hard failure in
   * a production build: see `src/lib/api-base-url.ts`.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
