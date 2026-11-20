import type { Business, MerchantTheme, ProgramVersion } from '../api/types';

// The business site's contract with the backend: /v1/partner/*. The owner signs in with their
// email, describes the place, publishes a card and links stands. Mirrored by server/demo/partner.ts
// and written up in docs/business-api.md. Like the diner routes, the session is an HttpOnly cookie.

export interface Stand {
  standId: string;
  label: string;
  /** disabled: the owner turned it off (lost, stolen or replaced). Its taps stamp nothing. */
  status: 'active' | 'disabled';
  linkedAt: string;
  lastTapAt?: string;
}

export interface PartnerAccount {
  maskedEmail: string;
  /** Set once the owner has described the place. */
  business?: Business;
  /** The published card. Diners only see a card once it's published and a stand is linked. */
  program?: ProgramVersion;
  stands: Stand[];
  /** Open while the owner is linking a stand: their next tap on an unlinked stand links it. */
  pairing?: { expiresAt: string };
}

export interface BusinessInput {
  name: string;
  category: string;
  location: string;
  address?: string;
}

export interface CardInput {
  requiredPunches: number;
  rewardDescription: string;
  theme: MerchantTheme;
}

export type ActivityKind = 'first' | 'stamp' | 'earned' | 'used';

export interface Activity {
  kind: ActivityKind;
  at: string;
  /** Which stamp this was, for stamps. */
  punches?: number;
}

export interface Today {
  stamps: number;
  rewardsUsed: number;
  newDiners: number;
  /** The latest taps and rewards today, newest first. Never who: diners stay anonymous to the business. */
  activity: Activity[];
}

export interface PartnerApi {
  /** The signed-in owner's account, or null when this browser isn't signed in to one. */
  me(): Promise<PartnerAccount | null>;
  startEmail(email: string): Promise<{ maskedEmail: string }>;
  verifyEmail(code: string): Promise<PartnerAccount>;
  signOut(): Promise<void>;
  saveBusiness(input: BusinessInput): Promise<PartnerAccount>;
  publishCard(input: CardInput): Promise<PartnerAccount>;
  startPairing(): Promise<PartnerAccount>;
  cancelPairing(): Promise<PartnerAccount>;
  turnOffStand(standId: string): Promise<PartnerAccount>;
  today(): Promise<Today>;
}
