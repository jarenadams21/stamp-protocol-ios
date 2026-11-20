import { ApiError } from '../api/types';
import type { BusinessInput, CardInput, PartnerAccount, PartnerApi, Today } from './types';

export type * from './types';

// The HTTP client for /v1/partner/* (contract in ./types.ts and docs/business-api.md).

export class HttpPartnerApi implements PartnerApi {
  constructor(private readonly base: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/v1/partner${path}`, {
        method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('offline', 'No connection');
    }
    if (response.status === 204) return undefined as T;
    if (response.ok) return (await response.json()) as T;
    const detail = (await response.json().catch(() => ({}))) as { code?: ApiError['code'] };
    throw new ApiError(detail.code ?? 'server', `HTTP ${response.status}`);
  }

  async me() {
    // 204 means this browser isn't signed in to a business.
    return (await this.request<PartnerAccount | undefined>('GET', '/me')) ?? null;
  }
  startEmail(email: string) {
    return this.request<{ maskedEmail: string }>('POST', '/email/start', { email });
  }
  verifyEmail(code: string) {
    return this.request<PartnerAccount>('POST', '/email/verify', { code });
  }
  async signOut() {
    await this.request<unknown>('POST', '/sign-out');
  }
  saveBusiness(input: BusinessInput) {
    return this.request<PartnerAccount>('PUT', '/business', input);
  }
  publishCard(input: CardInput) {
    return this.request<PartnerAccount>('PUT', '/card', input);
  }
  startPairing() {
    return this.request<PartnerAccount>('POST', '/stands/pairing');
  }
  cancelPairing() {
    return this.request<PartnerAccount>('DELETE', '/stands/pairing');
  }
  turnOffStand(standId: string) {
    return this.request<PartnerAccount>('POST', `/stands/${encodeURIComponent(standId)}/turn-off`);
  }
  today() {
    return this.request<Today>('GET', '/today');
  }
}

export function createPartnerApi(): PartnerApi {
  // The demo backend answers /v1/partner/* on the same origin as the page.
  if (import.meta.env.VITE_MODE === 'demo') return new HttpPartnerApi('');
  const base = import.meta.env.VITE_API_BASE;
  if (!base) throw new Error('VITE_API_BASE is not set');
  return new HttpPartnerApi(base.replace(/\/$/, ''));
}
