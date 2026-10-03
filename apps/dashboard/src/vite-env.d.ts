/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * `http` talks to the real control API, at relative `/v1/...` paths on this
   * page's own origin; anything else — unset included — uses the in-memory
   * mock. There is no base-URL variable: the dashboard and the API are served
   * from one origin, so a relative path is correct by construction.
   */
  readonly VITE_API_TRANSPORT?: 'http' | 'mock';
  /**
   * Base URL of the INGEST API (Go, :8080) — a different surface from the
   * control API this dashboard otherwise talks to. Used only to build the
   * copy-paste `curl` on the get-started page. Defaults to `http://localhost:8080`.
   */
  readonly VITE_INGEST_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
