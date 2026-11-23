import { apiBase } from '../api';
import type { ProgramVersion } from '../api/types';
import {
  PartnerError,
  type Activity,
  type ApiErrorBody,
  type ApiProgram,
  type BusinessInput,
  type Dashboard,
  type PartnerBusiness,
  type ProgramInput,
  type Session,
  type Stands,
} from './types';

export * from './types';

// The business site's client for the shared API (contract in ./types.ts). The access token lives in
// memory only; the refresh token is kept in localStorage so a reload stays signed in. A 401 refreshes
// once and retries. Refresh tokens rotate and a reused one ends the session, so refreshes are shared
// within the page and serialized across tabs.

const REFRESH_KEY = 'joeyy-partner-refresh';

function storedRefresh() {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function storeRefresh(token: string | null) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* Storage off: the session lasts as long as this page. */
  }
}

/** The live card as the diner page draws it, plus the cover key a publish must carry forward. */
export interface LiveProgram extends ProgramVersion {
  coverKey: string | null;
  publishedAt: string;
}

function liveProgram(program: ApiProgram): LiveProgram {
  const { coverKey, coverURL, ...theme } = program.theme;
  return { ...program, theme: { ...theme, coverURL: coverURL ?? undefined }, coverKey };
}

const signedOut = () => new PartnerError(401, 'unauthorized', 'Sign in again.');

export class PartnerApi {
  private accessToken: string | null = null;
  private memoryRefresh: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly base: string) {}

  private get refreshToken() {
    return storedRefresh() ?? this.memoryRefresh;
  }

  private keep(session: Session) {
    this.accessToken = session.accessToken;
    this.memoryRefresh = session.refreshToken;
    storeRefresh(session.refreshToken);
  }

  private forget() {
    this.accessToken = null;
    this.memoryRefresh = null;
    storeRefresh(null);
  }

  private async send<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new PartnerError(0, 'offline', 'No connection.');
    }
    if (response.status === 204) return undefined as T;
    const json = (await response.json().catch(() => undefined)) as unknown;
    if (response.ok) return json as T;
    const detail = (json ?? {}) as Partial<ApiErrorBody>;
    throw new PartnerError(response.status, detail.error ?? 'server', detail.message ?? 'Something went wrong. Try again.');
  }

  /** Swaps the refresh token for a new pair. Throws `unauthorized` (and forgets it) when it's no good. */
  private refresh() {
    const run = async () => {
      const token = this.refreshToken;
      if (!token) throw signedOut();
      try {
        this.keep(await this.send<Session>('POST', '/v1/auth/refresh', { refreshToken: token }));
      } catch (error) {
        if (error instanceof PartnerError && error.status === 401) this.forget();
        throw error;
      }
    };
    // Another tab may be mid-refresh with the same token; the lock makes this one read its result.
    const locked = async () => {
      if (navigator.locks) await navigator.locks.request(REFRESH_KEY, run);
      else await run();
    };
    this.refreshing ??= locked().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** A call with the bearer token, refreshing first after a reload and once more on a 401. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.accessToken) await this.refresh();
    try {
      return await this.send<T>(method, path, body, this.accessToken!);
    } catch (error) {
      if (!(error instanceof PartnerError) || error.status !== 401) throw error;
      await this.refresh();
      return this.send<T>(method, path, body, this.accessToken!);
    }
  }

  private partner<T>(method: string, path: string, body?: unknown) {
    return this.request<T>(method, `/v1/partner${path}`, body);
  }

  /** True when this browser holds a session (it may still turn out to have ended). */
  hasSession() {
    return Boolean(this.accessToken || this.refreshToken);
  }

  async startEmail(email: string) {
    await this.send<unknown>('POST', '/v1/auth/email/start', { email });
  }

  async verifyEmail(email: string, code: string) {
    this.keep(await this.send<Session>('POST', '/v1/auth/email/verify', { role: 'partner', email, code }));
  }

  async signOut() {
    const token = this.refreshToken;
    this.forget();
    if (token) await this.send<void>('POST', '/v1/auth/sign-out', { refreshToken: token });
  }

  /** The owner's business, or null before they've described it. */
  async business() {
    try {
      return await this.partner<PartnerBusiness>('GET', '/business');
    } catch (error) {
      if (error instanceof PartnerError && error.code === 'businessNotFound') return null;
      throw error;
    }
  }

  saveBusiness(input: BusinessInput) {
    return this.partner<PartnerBusiness>('PUT', '/business', input);
  }

  /** The live card, or null before one is published. */
  async program() {
    try {
      return liveProgram(await this.partner<ApiProgram>('GET', '/program'));
    } catch (error) {
      if (error instanceof PartnerError && (error.code === 'programNotFound' || error.code === 'businessNotFound')) return null;
      throw error;
    }
  }

  /** Publishes a new version; null when it matches the live card (409 unchangedProgram). */
  async publish(input: ProgramInput) {
    try {
      return liveProgram(await this.partner<ApiProgram>('POST', '/program/versions', input));
    } catch (error) {
      if (error instanceof PartnerError && error.code === 'unchangedProgram') return null;
      throw error;
    }
  }

  stands() {
    return this.partner<Stands>('GET', '/stands');
  }
  startPairing() {
    return this.partner<Stands>('POST', '/stands/pairing');
  }
  cancelPairing() {
    return this.partner<Stands>('DELETE', '/stands/pairing');
  }
  turnOffStand(standId: string) {
    return this.partner<Stands>('POST', `/stands/${encodeURIComponent(standId)}/turn-off`);
  }

  dashboard(from: Date, to: Date) {
    return this.partner<Dashboard>('GET', `/dashboard?${range(from, to)}`);
  }
  async activity(from: Date, to: Date) {
    return (await this.partner<{ activity: Activity[] }>('GET', `/activity?${range(from, to)}`)).activity;
  }
}

const range = (from: Date, to: Date) => new URLSearchParams({ from: from.toISOString(), to: to.toISOString() }).toString();

/** Same address as the diner side: this origin in demo and api mode, VITE_API_BASE in prod. */
export const createPartnerApi = (): PartnerApi => new PartnerApi(apiBase());
