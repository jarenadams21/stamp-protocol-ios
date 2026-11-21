// Mirrors docs/backend-spec.md §3.1 in stamp-protocol-ios. Field names match the
// card configuration contract so the web card renders exactly what the business published.

export type Typeface = 'standard' | 'rounded' | 'serif' | 'monospaced';
export type Artwork = 'rail' | 'cloud' | 'stone';

export interface MerchantTheme {
  lightPaper: string;
  lightInk: string;
  darkPaper: string;
  darkInk: string;
  typeface: Typeface;
  artwork: Artwork;
  coverURL?: string;
  allowsMotion: boolean;
}

export interface Business {
  id: string;
  name: string;
  /** Neighbourhood and city, e.g. "Capitol Hill, Seattle". */
  location: string;
  /** Optional profile details the business fills in on the partner app. */
  category?: string;
  address?: string;
  /** Today's opening hours in the business's time zone, e.g. { opens: '07:00', closes: '18:00' }. */
  hoursToday?: { opens: string; closes: string };
  website?: string;
}

export interface ProgramVersion {
  versionId: string;
  version: number;
  requiredPunches: number;
  rewardDescription: string;
  theme: MerchantTheme;
  /**
   * The business's own limit on repeat stamps: a tap this soon after the diner's last stamp here
   * gets outcome "cooldown". Absent means no limit; JOEYY doesn't set one (team decision, Nov 11).
   */
  minMinutesBetweenStamps?: number;
}

export interface Card {
  cardId: string;
  punches: number;
  requiredPunches: number;
  status: 'active' | 'completed';
}

export interface Reward {
  rewardId: string;
  rewardDescription: string;
  earnedAt: string;
  redeemedAt?: string;
}

/** Everything the page needs to draw one business's card for this diner. */
export interface CardState {
  business: Business;
  program: ProgramVersion;
  card: Card;
  rewardsAvailable: Reward[];
  /** This diner's most recent stamps at this business, newest first (up to 10). */
  recentVisits?: string[];
  /**
   * This diner added this card to their Wallet. A pass registered for updates changes by itself
   * after every stamp and redemption (Wallet's web service plus a push), so outOfDate stays false.
   * It's true only for a pass that never registered (no HTTPS, or HTTP services not allowed on
   * the phone), and the page then offers Update Wallet card.
   */
  walletPass?: {
    outOfDate: boolean;
    /** Wallet registered this pass for updates, so it changes by itself after a stamp or redemption. */
    autoUpdates?: boolean;
  };
}

/** A participating business for the Discover tab (GET /v1/places). */
export interface PlaceSummary {
  business: Business;
  program: ProgramVersion;
}

/**
 * A place as the shared backend's Places API returns it (`GET /v1/places?query=`, backend-spec
 * §8.2): the business's own fields with its live card under `program`. Open to anyone, no sign-in.
 * The client turns it into a PlaceSummary, so screens only ever see one shape.
 */
export interface Place {
  id: string;
  clientId: string;
  name: string;
  location: string;
  logoURL: string | null;
  program: Omit<ProgramVersion, 'theme'> & { theme: Omit<MerchantTheme, 'coverURL'> & { coverURL: string | null } };
}

export type SignInProvider = 'apple' | 'google';

export interface Identity {
  /**
   * anonymous: this browser only. account: signed in to an account, with Apple, Google or a
   * verified mobile number. pass: signed in from the link on the diner's Wallet pass, no account
   * sign-in yet. Never sent by the page: the server reads its session cookie.
   */
  kind: 'anonymous' | 'account' | 'pass';
  /** How this browser signed in to the account. */
  method?: 'phone' | SignInProvider;
  /** The account's mobile number, masked ("••• ••• 0123"), if it has one. */
  maskedPhone?: string;
  /** The Apple or Google email this browser signed in with, masked ("s•••@icloud.com"). */
  maskedEmail?: string;
  /**
   * What the diner asked to be called, for greetings and their passport. Only the diner sees it:
   * it never goes to a restaurant, the partner app or staff screens. Accounts and pass sign-ins only.
   */
  displayName?: string;
}

/**
 * Result of any sign-in. The server merges this browser's anonymous cards into the account:
 * each stamp counts once, cards that fill earn their reward, and every reward is kept.
 */
export interface SignInResult {
  identity: Identity;
  /** Stamps moved from this browser's anonymous cards onto the account, per business. */
  moved: { businessId: string; stamps: number }[];
  /** Cards and unused rewards the account already had, now showing here. */
  restoredCards: number;
  restoredRewards: number;
  /** For a Wallet pass link: the business whose pass it was. */
  businessId?: string;
}

export interface Redemption {
  rewardId: string;
  rewardDescription: string;
  redeemedAt: string;
  /** Short code staff can match in the partner app. */
  code: string;
  /** The redeem window this tap used; /r/:intentId shows the staff screen again after a reload. */
  intentId: string;
}

/**
 * Result of POST /v1/web/taps. The server verifies the tag's SUN signature and counter,
 * resolves the diner from the anonymous cookie (creating one on first tap), then applies
 * the card lifecycle from backend-spec §4.
 */
export type TapResult =
  | { outcome: 'stamped'; state: CardState; startedNewCard: boolean; identity: Identity }
  | { outcome: 'completed'; state: CardState; reward: Reward; identity: Identity }
  | { outcome: 'cooldown'; state: CardState; nextStampAt: string; identity: Identity }
  | { outcome: 'redeemed'; state: CardState; redemption: Redemption; identity: Identity }
  | { outcome: 'replayed'; state?: CardState }
  | { outcome: 'invalidTag' }
  | { outcome: 'tagNotActive'; business?: Business }
  | { outcome: 'tagDisabled'; business?: Business };

export interface RedeemIntent {
  intentId: string;
  rewardId: string;
  businessId: string;
  expiresAt: string;
}

export type WalletPlatform = 'apple' | 'google';

export class ApiError extends Error {
  constructor(
    readonly code:
      | 'offline' | 'server' | 'invalidPhone' | 'invalidCode' | 'invalidName' | 'expired' | 'notFound'
      // The business site (src/business/api.ts).
      | 'invalidEmail' | 'invalidCard' | 'signedOut',
    message: string,
  ) {
    super(message);
  }
}

export interface StampApi {
  tap(picc: string, cmac: string): Promise<TapResult>;
  myCards(): Promise<{ identity: Identity; cards: CardState[] }>;
  card(businessId: string): Promise<CardState>;
  startRedeem(rewardId: string): Promise<RedeemIntent>;
  redeemIntent(intentId: string): Promise<{ intent: RedeemIntent; redemption?: Redemption }>;
  cancelRedeem(intentId: string): Promise<void>;
  startPhone(phone: string): Promise<{ maskedPhone: string }>;
  /** Signs in to the account with that number, or creates one, merging this browser's cards. */
  verifyPhone(code: string): Promise<SignInResult>;
  /**
   * Signs in with Apple or Google: the page goes to `/v1/web/auth/{provider}/start` and comes back
   * to /signed-in, where providerSignInResult() reads the merge. In production this never resolves
   * (the page has left); the demo resolves it straight away after its stand-in consent sheet.
   */
  signInWithProvider(provider: SignInProvider): Promise<SignInResult>;
  /** Back from Apple or Google: the sign-in's result, readable once. */
  providerSignInResult(): Promise<SignInResult>;
  /** Signs in from the secret link on the diner's Wallet pass. */
  restoreFromPass(token: string): Promise<SignInResult>;
  /** Signs this browser out. The account keeps everything. */
  signOut(): Promise<void>;
  walletPass(cardId: string, platform: WalletPlatform): Promise<{ url: string }>;
  places(): Promise<PlaceSummary[]>;
  /** Places whose name contains `query` (any case; names starting with it first), or whose ID is exactly it. At most 20. */
  searchPlaces(query: string): Promise<PlaceSummary[]>;
  /** Saves the diner's own order for their cards (Your cards). */
  reorderCards(businessIds: string[]): Promise<void>;
  /** Sets what the diner is called (1–40 characters; empty clears it). Signed-in diners only. */
  saveProfile(profile: { displayName: string }): Promise<Identity>;
  /**
   * Deletes the diner's account and everything on it (cards, stamps, rewards, sign-ins, Wallet
   * passes), signs out every browser on it, and leaves this one with a fresh, empty card list.
   */
  deleteAccount(): Promise<void>;
}
