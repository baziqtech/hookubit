/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `http` talks to the real control API; anything else uses the in-memory mock. */
  readonly VITE_API_TRANSPORT?: 'http' | 'mock';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
