import type { MerchantTheme, ProgramVersion } from '../api/types';

// The business site's contract with the shared API (services/api): sign-in under /v1/auth with
// role "partner", then /v1/partner/* with a bearer token. Stands and activity follow
// docs/web-connect.md. Mirrored by server/demo/partner.ts for demo mode. No import.meta here: the
// demo server imports this file too.

/** Every error the API sends: `{ error, message }`. `message` is written for people. */
export interface ApiErrorBody {
  error: string;
  message: string;
}

/** A failed partner call. `status` 0 with code `offline` means the request never got an answer. */
export class PartnerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** POST /v1/auth/email/verify and /v1/auth/refresh. */
export interface Session {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
}

/** GET and PUT /v1/partner/business. */
export interface PartnerBusiness {
  id: string;
  clientId: string;
  name: string;
  location: string;
  logoKey: string | null;
  logoURL: string | null;
  /** IANA name. PUT resets it to UTC when left out, so every save sends it. */
  timeZone: string;
  currentProgramVersionId: string | null;
}

/** PUT /v1/partner/business. Name 1–40 characters, location at most 120. */
export interface BusinessInput {
  name: string;
  location: string;
  timeZone: string;
}

/** The theme as the API returns it (backend-spec §3.1): the cover travels as a key plus a short-lived URL. */
export interface ApiTheme extends Omit<MerchantTheme, 'coverURL'> {
  coverKey: string | null;
  coverURL: string | null;
}

/** GET /v1/partner/program and POST /v1/partner/program/versions. */
export interface ApiProgram extends Omit<ProgramVersion, 'theme' | 'minMinutesBetweenStamps'> {
  theme: ApiTheme;
  publishedAt: string;
}

/**
 * POST /v1/partner/program/versions. `requiredPunches` 3–12, reward 1–60 characters, both
 * paper/ink pairs at least 4.5:1. `theme.coverKey` keeps the live cover; leaving it out drops it.
 */
export interface ProgramInput {
  requiredPunches: number;
  rewardDescription: string;
  theme: Omit<MerchantTheme, 'coverURL'> & { coverKey: string | null };
}

export interface Stand {
  standId: string;
  label: string;
  /** disabled: the owner turned it off (lost, stolen or replaced). Its taps stamp nothing. */
  status: 'active' | 'disabled';
  linkedAt: string;
  lastTapAt: string | null;
}

/** GET /v1/partner/stands and every stand change. `pairing` is open while the owner links a stand. */
export interface Stands {
  stands: Stand[];
  pairing: { expiresAt: string } | null;
}

/** GET /v1/partner/dashboard?from&to (backend-spec §8.4). Range counts use from <= t < to. */
export interface Dashboard {
  enrolledCardholders: number;
  punches: number;
  rewardsEarned: number;
  rewardsRedeemed: number;
  rewardsWaiting: number;
  customersWithStackedRewards: number;
}

/** GET /v1/partner/activity?from&to: newest first, at most 50. Never says who. */
export interface Activity {
  kind: 'first' | 'stamp' | 'earned' | 'used';
  at: string;
  /** Which stamp this was on the diner's card; null for a reward used. */
  punches: number | null;
}
