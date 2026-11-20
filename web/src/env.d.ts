/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by vite.config.ts from `--mode`: `demo` runs on the demo backend, `prod` on VITE_API_BASE. */
  readonly VITE_MODE: 'demo' | 'prod';
  /** The real backend. Required in prod; ignored in demo. */
  readonly VITE_API_BASE?: string;
}
