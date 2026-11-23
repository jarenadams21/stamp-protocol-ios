/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by vite.config.ts from `--mode`: `demo` runs on the demo backend, `api` on the local API through the dev server, `prod` on VITE_API_BASE. */
  readonly VITE_MODE: 'demo' | 'api' | 'prod';
  /** The real backend. Required in prod; ignored in demo. */
  readonly VITE_API_BASE?: string;
  /**
   * Which of Apple and Google the sign-in sheet offers, comma-separated ("apple,google"). Unset:
   * both in demo, none elsewhere, since the API has no /v1/web/auth/{provider} routes yet.
   */
  readonly VITE_SIGN_IN_PROVIDERS?: string;
}
