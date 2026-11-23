import { HttpStampApi } from './http';
import type { StampApi } from './types';

export * from './types';

/**
 * True in the demo build (`npm run dev`, `npm run build:demo`): the page runs on the demo backend
 * (server/demo) and shows the Preview states bar. vite.config.ts sets VITE_MODE from --mode, and
 * branches on it are dropped from the prod bundle.
 */
export const isDemo = import.meta.env.VITE_MODE === 'demo';

export async function createApi(): Promise<StampApi> {
  if (import.meta.env.VITE_MODE === 'demo') {
    const { DemoStampApi } = await import('./demo');
    return new DemoStampApi();
  }
  return new HttpStampApi(apiBase());
}

/**
 * Where the API is: VITE_API_BASE in prod, or this origin in api mode, where the dev server passes
 * /v1 through to the local API (vite.config.ts).
 */
export function apiBase() {
  const base = import.meta.env.VITE_API_BASE ?? '';
  // vite.config.ts refuses a prod build without it; this guards anything that slips past.
  if (import.meta.env.VITE_MODE === 'prod' && !base) throw new Error('VITE_API_BASE is not set');
  return base.replace(/\/$/, '');
}
