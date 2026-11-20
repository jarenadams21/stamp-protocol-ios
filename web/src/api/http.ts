import {
  ApiError,
  type CardState,
  type PlaceSummary,
  type Identity,
  type RedeemIntent,
  type SignInResult,
  type SignInProvider,
  type Redemption,
  type StampApi,
  type TapResult,
  type WalletPlatform,
} from './types';

// Talks to the shared backend. The diner is identified by the server's HttpOnly
// anonymous cookie, so every request sends credentials and never a customer ID.
export class HttpStampApi implements StampApi {
  constructor(private readonly base: string) {}

  protected async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('offline', 'No connection');
    }
    // 204 No Content (sign out, cancel, reorder) has no body to read.
    if (response.status === 204) return undefined as T;
    if (response.ok) return (await response.json()) as T;
    const detail = (await response.json().catch(() => ({}))) as { code?: ApiError['code'] };
    throw new ApiError(detail.code ?? 'server', `HTTP ${response.status}`);
  }

  tap(picc: string, cmac: string) {
    return this.request<TapResult>('POST', '/v1/web/taps', { picc, cmac });
  }
  myCards() {
    return this.request<{ identity: Identity; cards: CardState[] }>('GET', '/v1/web/me/cards');
  }
  card(businessId: string) {
    return this.request<CardState>('GET', `/v1/web/me/cards/${encodeURIComponent(businessId)}`);
  }
  startRedeem(rewardId: string) {
    return this.request<RedeemIntent>('POST', '/v1/web/redeem-intents', { rewardId });
  }
  redeemIntent(intentId: string) {
    return this.request<{ intent: RedeemIntent; redemption?: Redemption }>(
      'GET',
      `/v1/web/redeem-intents/${encodeURIComponent(intentId)}`,
    );
  }
  async cancelRedeem(intentId: string) {
    await this.request<unknown>('DELETE', `/v1/web/redeem-intents/${encodeURIComponent(intentId)}`);
  }
  startPhone(phone: string) {
    return this.request<{ maskedPhone: string }>('POST', '/v1/web/phone/start', { phone });
  }
  verifyPhone(code: string) {
    return this.request<SignInResult>('POST', '/v1/web/phone/verify', { code });
  }

  /**
   * OAuth / OpenID Connect with Apple or Google, run by the backend. The page hands over to
   * `/start`, which goes to the provider; the provider returns to the backend's `/callback`, which
   * signs this browser in, merges its cards, and sends the diner back to `/signed-in?next=…`.
   */
  signInWithProvider(provider: SignInProvider) {
    // Only card pages are worth coming back to: a tap link can't be opened twice.
    const next = /^\/c(\/[^/]+)?$/.test(window.location.pathname) ? window.location.pathname : '/c';
    window.location.assign(`${this.base}/v1/web/auth/${provider}/start?return_to=${encodeURIComponent(next)}`);
    return new Promise<SignInResult>(() => undefined);
  }
  providerSignInResult() {
    return this.request<SignInResult>('GET', '/v1/web/auth/result');
  }

  restoreFromPass(token: string) {
    return this.request<SignInResult>('POST', `/v1/web/pass-links/${encodeURIComponent(token)}`);
  }

  async signOut() {
    await this.request<unknown>('POST', '/v1/web/sign-out');
  }
  walletPass(cardId: string, platform: WalletPlatform) {
    return this.request<{ url: string }>(
      'POST',
      `/v1/web/cards/${encodeURIComponent(cardId)}/wallet`,
      { platform },
    );
  }
  places() {
    return this.request<PlaceSummary[]>('GET', '/v1/places');
  }
  async reorderCards(businessIds: string[]) {
    await this.request<unknown>('PUT', '/v1/web/me/cards/order', { businessIds });
  }
  saveProfile(profile: { displayName: string }) {
    return this.request<Identity>('PUT', '/v1/web/me/profile', profile);
  }
  async deleteAccount() {
    await this.request<unknown>('DELETE', '/v1/web/me');
  }
}
