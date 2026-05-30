/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the ofit-api backend. Default: http://localhost:8080 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
