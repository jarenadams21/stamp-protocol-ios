import { HttpStampApi } from './http';
import type { SignInProvider, SignInResult } from './types';

// The demo backend (server/demo) answers the same routes as the real one. Two things differ:
// Apple and Google sign-in, which need real OAuth the demo can't do, and the Preview states
// controls under /api/demo.

export class DemoStampApi extends HttpStampApi {
  constructor() {
    super('');
  }

  /** The page shows its own stand-in for the consent screen first (see previewConsent). */
  override signInWithProvider(provider: SignInProvider) {
    return this.request<SignInResult>('POST', `/api/demo/auth/${provider}`);
  }
}

export interface DemoInfo {
  walletConfigured: boolean;
  offline: boolean;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Demo server: HTTP ${response.status}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const demo = {
  info: () => call<DemoInfo>('GET', '/api/demo/info'),
  settings: (changes: Partial<Omit<DemoInfo, 'walletConfigured'>>) => call<void>('POST', '/api/demo/settings', changes),
  /** Sets up a Preview state on the server; returns the page to open. */
  scenario: (name: string) => call<{ next: string }>('POST', `/api/demo/scenarios/${encodeURIComponent(name)}`),
  /** A tap on this business's stand. */
  stamp: (businessId: string) => call<{ next: string }>('POST', '/api/demo/stamp', { businessId }),
};
