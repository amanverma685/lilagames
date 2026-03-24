/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NAKAMA_HOST: string;
  readonly VITE_NAKAMA_PORT: string;
  readonly VITE_NAKAMA_SERVER_KEY: string;
  readonly VITE_NAKAMA_USE_SSL: string;
  /** Set to `local` to use local-server (no Docker / Nakama). */
  readonly VITE_BACKEND: string;
  readonly VITE_LOCAL_WS_URL: string;
  readonly VITE_LOCAL_HTTP_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
