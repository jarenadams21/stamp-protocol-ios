import { randomBytes } from 'node:crypto';
import {
  ApiError,
  type CardState,
  type Identity,
  type Place,
  type PlaceSummary,
  type RedeemIntent,
  type Redemption,
  type SignInResult,
  type TapResult,
} from '../../src/api/types';
import { walletStatus, type PassCard } from '../apple-pass';
import { SAMPLE_EMAILS } from '../../src/demo/sample';
import { BUSINESSES, TAGS } from './data';
import { BadRequest } from './http';
import {
  customerOf,
  emptyCustomer,
  findPass,
  forgetIfOrphaned,
  newCustomerFor,
  newId,
  persist,
  state,
  type Customer,
  type Device,
  type StoredCard,
} from './store';

// The rules the real backend must apply, run against the demo's state: the tag's signature and
// counter, one open card per diner per business, full-card rollover, stacked rewards, the
// business's own repeat-stamp limit (if it set one), single-use redemption, and the sign-in merge.
// Each method answers one /v1/web route.

const REDEEM_WINDOW_MS = 120_000;
export const DEMO_CODE = '123456';

const masked = (phone: string) => `••• ••• ${phone.slice(-4)}`;

/**
 * Digits only, so "+1 (206) 472-6147" and "2064726147" are one account. The demo's numbers are
 * North American, so a leading country code 1 on an 11-digit number is dropped.
 */
const normalisedPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
};
const unused = (customer: Customer, businessId: string) =>
  customer.rewards.filter((reward) => reward.businessId === businessId && !reward.redeemedAt);

/** What a Wallet pass shows, to tell when the pass on the phone has fallen behind the card. */
export const snapshot = (customer: Customer, card: StoredCard) => `${card.punches}/${unused(customer, card.businessId).length}`;

/** "sample.diner@icloud.com" → "s•••@icloud.com" */
export const maskedEmail = (email: string) => email.replace(/^(.)[^@]*/, '$1•••');

/** The account has a way to sign in of its own: a number, an Apple ID or a Google account. */
const hasSignIn = (customer: Customer) => Boolean(customer.phone || customer.apple || customer.google);

export function identity(device: Device): Identity {
  const customer = customerOf(device);
  if (hasSignIn(customer)) {
    const method = device.signedInWith ?? (customer.phone ? 'phone' : customer.apple ? 'apple' : 'google');
    const email = method === 'phone' ? undefined : customer[method];
    return {
      kind: 'account',
      method,
      maskedPhone: customer.phone ? masked(customer.phone) : undefined,
      maskedEmail: email ? maskedEmail(email) : undefined,
      displayName: customer.displayName,
    };
  }
  return device.viaPass ? { kind: 'pass', displayName: customer.displayName } : { kind: 'anonymous' };
}

export function openCard(customer: Customer, businessId: string): StoredCard {
  const existing = customer.cards.find((card) => card.businessId === businessId);
  if (existing) return existing;
  const card: StoredCard = {
    cardId: newId(),
    businessId,
    punches: 0,
    requiredPunches: BUSINESSES[businessId].program.requiredPunches,
    status: 'active',
  };
  customer.cards.push(card);
  return card;
}

/** Gives the diner a reward at this business. The one place a reward is made. */
export function issueReward(customer: Customer, businessId: string, earnedAt = new Date()) {
  const reward = {
    rewardId: newId(),
    businessId,
    rewardDescription: BUSINESSES[businessId].program.rewardDescription,
    earnedAt: earnedAt.toISOString(),
  };
  customer.rewards.push(reward);
  return reward;
}

function cardState(customer: Customer, businessId: string): CardState {
  const entry = BUSINESSES[businessId];
  if (!entry) throw new ApiError('notFound', 'Unknown business');
  const card = openCard(customer, businessId);
  const pass = customer.passes.find((item) => item.businessId === businessId);
  return {
    business: entry.business,
    program: entry.program,
    card: { cardId: card.cardId, punches: card.punches, requiredPunches: card.requiredPunches, status: card.status },
    rewardsAvailable: unused(customer, businessId).map(({ businessId: _ignored, ...reward }) => reward),
    recentVisits: customer.visits
      .filter((visit) => visit.businessId === businessId)
      .map((visit) => visit.at)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 10),
    // A pass that updates itself is never shown as out of date: its push is already on the way.
    walletPass: pass
      ? { outOfDate: !pass.registrations?.length && pass.shown !== snapshot(customer, card), autoUpdates: Boolean(pass.registrations?.length) }
      : undefined,
  };
}

export function tap(device: Device, picc: string, cmac: string): TapResult {
  const customer = customerOf(device);
  // A real server decrypts picc and checks cmac (AES-CMAC). The demo accepts "<tagKey>.<counter>".
  const [tagKey, counterText] = picc.split('.');
  const tag = TAGS[tagKey];
  if (!tag || !cmac) return { outcome: 'invalidTag' };

  const counter = counterText ? Number(counterText) : Date.now();
  if (!Number.isFinite(counter) || counter <= (state.tagCounters[tagKey] ?? -1)) {
    const known = customer.cards.some((card) => card.businessId === tag.businessId);
    return { outcome: 'replayed', state: known ? cardState(customer, tag.businessId) : undefined };
  }
  state.tagCounters[tagKey] = counter;
  persist();

  const { business } = BUSINESSES[tag.businessId];
  if (tag.status === 'allocated') return { outcome: 'tagNotActive', business };
  if (tag.status === 'disabled') return { outcome: 'tagDisabled', business };
  const who = identity(device);

  // An open redeem window turns this tap into a redemption instead of a stamp.
  const now = Date.now();
  const intent = Object.values(state.intents).find((item) =>
    item.customerId === customer.id && item.businessId === tag.businessId && !item.usedAt && Date.parse(item.expiresAt) > now);
  const reward = intent && customer.rewards.find((item) => item.rewardId === intent.rewardId && !item.redeemedAt);
  if (intent && reward) {
    reward.redeemedAt = new Date(now).toISOString();
    const redemption: Redemption = {
      rewardId: reward.rewardId,
      rewardDescription: reward.rewardDescription,
      redeemedAt: reward.redeemedAt,
      code: reward.rewardId.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase(),
      intentId: intent.intentId,
    };
    intent.usedAt = reward.redeemedAt;
    intent.redemption = redemption;
    return { outcome: 'redeemed', state: cardState(customer, tag.businessId), redemption, identity: who };
  }

  // No built-in limit on repeat taps: each new tap stamps, unless the business set a minimum gap.
  let card = openCard(customer, tag.businessId);
  const minutes = BUSINESSES[tag.businessId].program.minMinutesBetweenStamps;
  const gap = minutes ? minutes * 60_000 : 0;
  if (gap && card.lastPunchAt && now - card.lastPunchAt < gap) {
    return {
      outcome: 'cooldown',
      state: cardState(customer, tag.businessId),
      nextStampAt: new Date(card.lastPunchAt + gap).toISOString(),
      identity: who,
    };
  }

  // backend-spec §4: a stamp on a completed card starts a new card with that stamp as its first.
  let startedNewCard = false;
  if (card.status === 'completed') {
    customer.cards = customer.cards.filter((item) => item !== card);
    card = openCard(customer, tag.businessId);
    startedNewCard = true;
  }
  card.punches += 1;
  card.lastPunchAt = now;
  customer.visits.push({ businessId: tag.businessId, at: new Date(now).toISOString() });

  if (card.punches >= card.requiredPunches) {
    card.punches = card.requiredPunches;
    card.status = 'completed';
    const { businessId: _ignored, ...publicReward } = issueReward(customer, tag.businessId, new Date(now));
    return { outcome: 'completed', state: cardState(customer, tag.businessId), reward: publicReward, identity: who };
  }
  return { outcome: 'stamped', state: cardState(customer, tag.businessId), startedNewCard, identity: who };
}

export function myCards(device: Device) {
  const customer = customerOf(device);
  // The diner's own order first; cards it doesn't list follow, most recent visit first.
  const lastVisit = (businessId: string) => customer.visits
    .reduce((latest, visit) => (visit.businessId === businessId && visit.at > latest ? visit.at : latest), '');
  const rank = (businessId: string) => {
    const index = customer.order?.indexOf(businessId) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const cards = [...customer.cards].sort((a, b) =>
    rank(a.businessId) - rank(b.businessId) || lastVisit(b.businessId).localeCompare(lastVisit(a.businessId)));
  return { identity: identity(device), cards: cards.map((card) => cardState(customer, card.businessId)) };
}

export function card(device: Device, businessId: string) {
  const customer = customerOf(device);
  if (!customer.cards.some((item) => item.businessId === businessId)) throw new ApiError('notFound', 'No card yet');
  return cardState(customer, businessId);
}

export function reorderCards(device: Device, businessIds: unknown) {
  if (!Array.isArray(businessIds)) throw new BadRequest('businessIds must be a list');
  customerOf(device).order = businessIds.filter((businessId): businessId is string =>
    typeof businessId === 'string' && Boolean(BUSINESSES[businessId]));
}

export function startRedeem(device: Device, rewardId: string): RedeemIntent {
  const customer = customerOf(device);
  const reward = customer.rewards.find((item) => item.rewardId === rewardId && !item.redeemedAt);
  if (!reward) throw new ApiError('notFound', 'Reward already used');
  // One open window per business: starting again replaces the last one.
  for (const [intentId, item] of Object.entries(state.intents)) {
    if (item.customerId === customer.id && item.businessId === reward.businessId && !item.usedAt) delete state.intents[intentId];
  }
  const intent = {
    intentId: newId(),
    rewardId,
    businessId: reward.businessId,
    expiresAt: new Date(Date.now() + REDEEM_WINDOW_MS).toISOString(),
  };
  state.intents[intent.intentId] = { ...intent, customerId: customer.id };
  return intent;
}

/** Anyone with the intent ID can read it: the redeem screen and the tap tab both watch it. */
export function redeemIntent(intentId: string) {
  const stored = state.intents[intentId];
  if (!stored) throw new ApiError('notFound', 'Unknown intent');
  const { usedAt: _used, redemption, customerId: _customer, ...intent } = stored;
  return { intent, redemption };
}

export function cancelRedeem(device: Device, intentId: string) {
  if (state.intents[intentId]?.customerId === device.customerId) delete state.intents[intentId];
}

// ---------- Sign-in ----------

export function startPhone(device: Device, phone: string) {
  const digits = normalisedPhone(String(phone ?? ''));
  if (digits.length < 10 || digits.length > 15) throw new ApiError('invalidPhone', 'Invalid phone');
  device.pendingPhone = digits;
  return { maskedPhone: masked(digits) };
}

export function verifyPhone(device: Device, code: string): SignInResult {
  const phone = device.pendingPhone;
  if (!phone) throw new ApiError('expired', 'Start again');
  // The demo has no text messages: the code is always 123456.
  if (String(code ?? '').trim() !== DEMO_CODE) throw new ApiError('invalidCode', 'Wrong code');
  device.pendingPhone = undefined;
  return signInWith(device, 'phone', phone);
}

/**
 * Apple or Google. The real backend gets the account's stable ID and email from the provider's
 * ID token; the demo can't run OAuth, so it always signs in as the sample Apple ID or Google
 * account that the page's stand-in consent sheet shows.
 */
export function providerSignIn(device: Device, provider: string): SignInResult {
  if (provider !== 'apple' && provider !== 'google') throw new ApiError('notFound', 'Unknown provider');
  return signInWith(device, provider, SAMPLE_EMAILS[provider]);
}

/** One sign-in rule for a number, an Apple ID or a Google account. */
function signInWith(device: Device, method: 'phone' | 'apple' | 'google', value: string): SignInResult {
  const current = customerOf(device);
  const account = Object.values(state.customers).find((customer) => customer[method] === value);
  device.signedInWith = method;
  if (!account && !hasSignIn(current)) {
    // New to JOEYY: this browser's cards simply become the account.
    current[method] = value;
    device.viaPass = undefined;
    return { identity: identity(device), moved: [], restoredCards: 0, restoredRewards: 0 };
  }
  return signInTo(device, account ?? { ...emptyCustomer(), [method]: value });
}

export function restoreFromPass(device: Device, token: string): SignInResult {
  const found = findPass((pass) => pass.token === token);
  if (!found) throw new ApiError('notFound', 'This link has expired');
  device.signedInWith = undefined;
  return { ...signInTo(device, found.customer), businessId: found.pass.businessId };
}

export function signOut(device: Device) {
  newCustomerFor(device);
  device.pendingPhone = undefined;
}

/** PUT /v1/web/me/profile. A name needs somewhere lasting to live, so not for anonymous browsers. */
export function saveProfile(device: Device, displayName: unknown) {
  if (identity(device).kind === 'anonymous') throw new ApiError('notFound', 'Sign in to add a name');
  const name = String(displayName ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  // Letters, marks, spaces and a little punctuation: no control characters, links or emoji walls.
  if ([...name].length > 40 || /[^\p{L}\p{M}\p{N} '’.\-]/u.test(name)) {
    throw new ApiError('invalidName', 'Use up to 40 letters');
  }
  customerOf(device).displayName = name || undefined;
  return identity(device);
}

/**
 * DELETE /v1/web/me. Removes the account and all it holds, and signs out every browser on it.
 * Open redemptions die with it, and its Wallet passes stop updating (their tokens no longer match).
 */
export function deleteAccount(device: Device) {
  if (identity(device).kind === 'anonymous') throw new ApiError('notFound', 'No account to delete');
  const customer = customerOf(device);
  for (const [intentId, intent] of Object.entries(state.intents)) {
    if (intent.customerId === customer.id) delete state.intents[intentId];
  }
  customer.passes = [];
  customer.phone = customer.apple = customer.google = undefined;
  for (const other of Object.values(state.devices)) {
    if (other.customerId === customer.id) {
      newCustomerFor(other);
      other.pendingPhone = undefined;
    }
  }
  delete state.customers[customer.id];
}

/**
 * Points this device at the account, first merging what this browser collected anonymously, the
 * way the real server must: each stamp counts once, a card that fills earns its reward (extra
 * stamps start the next card), every reward and Wallet pass is kept.
 */
function signInTo(device: Device, account: Customer): SignInResult {
  state.customers[account.id] = account;
  const restoredCards = account.cards.length;
  const restoredRewards = account.rewards.filter((reward) => !reward.redeemedAt).length;
  const moved: SignInResult['moved'] = [];
  const current = customerOf(device);
  const anonymous = current.id !== account.id && !hasSignIn(current) && !device.viaPass;

  if (anonymous) {
    for (const local of current.cards) {
      if (!local.punches) continue;
      const existing = account.cards.find((card) => card.businessId === local.businessId);
      if (!existing) {
        account.cards.push(structuredClone(local));
        moved.push({ businessId: local.businessId, stamps: local.punches });
        continue;
      }
      // A full card's stamps already paid for its reward, which moves over with the rest below.
      // Adding them again would issue that reward twice, so they aren't reported as moved either.
      if (local.status === 'completed') continue;
      moved.push({ businessId: local.businessId, stamps: local.punches });
      let punches = (existing.status === 'completed' ? 0 : existing.punches) + local.punches;
      if (punches >= existing.requiredPunches) {
        issueReward(account, local.businessId);
        punches -= existing.requiredPunches;
        existing.status = punches === 0 ? 'completed' : 'active';
        existing.punches = punches === 0 ? existing.requiredPunches : punches;
      } else {
        existing.punches = punches;
        existing.status = 'active';
      }
      existing.lastPunchAt = Math.max(existing.lastPunchAt ?? 0, local.lastPunchAt ?? 0);
    }
    account.rewards.push(...current.rewards.filter((reward) => !account.rewards.some((r) => r.rewardId === reward.rewardId)));
    account.visits.push(...current.visits);
    // The account's order wins; this browser's only counts if the account never set one.
    account.order ??= current.order;
    // A Wallet pass added on this browser now opens the account.
    account.passes.push(...current.passes);
    current.passes = [];
    for (const intent of Object.values(state.intents)) if (intent.customerId === current.id) intent.customerId = account.id;
  }

  device.customerId = account.id;
  device.viaPass = !hasSignIn(account);
  if (current.id !== account.id) forgetIfOrphaned(current);
  return { identity: identity(device), moved, restoredCards, restoredRewards };
}

// ---------- Places and Wallet ----------

/** Places diners can find: those with a working stand (a business still setting up isn't listed). */
export const places = (): PlaceSummary[] => Object.values(BUSINESSES)
  .filter(({ business }) => Object.values(TAGS).some((tag) => tag.businessId === business.id && tag.status === 'active'))
  .map(({ business, program }) => ({ business, program }));

/**
 * The shared backend's place search (backend/src/routes/places.ts in stamp-protocol-ios), with the
 * same rules: trimmed, any case, the exact ID first, then names starting with the query, then names
 * containing it, A to Z, at most 20, live places only. Answers in the backend's shape.
 */
export function searchPlaces(raw: string): { places: Place[] } {
  const query = raw.trim();
  if (!query || [...query].length > 40) throw new BadRequest(query ? 'Use a shorter search.' : 'Type a place’s name to search.');
  const needle = query.toLowerCase();
  const rank = ({ business }: PlaceSummary) => {
    const name = business.name.toLowerCase();
    if (business.id.toLowerCase() === needle) return 0;
    if (name.startsWith(needle)) return 1;
    return name.includes(needle) ? 2 : 3;
  };
  const found = places()
    .filter((place) => rank(place) < 3)
    .sort((a, b) => rank(a) - rank(b) || a.business.name.localeCompare(b.business.name))
    .slice(0, 20);
  return {
    places: found.map(({ business, program }) => ({
      id: business.id,
      clientId: business.id,
      name: business.name,
      location: business.location,
      logoURL: null,
      program: { ...program, theme: { ...program.theme, coverURL: program.theme.coverURL ?? null } },
    })),
  };
}

/** Returns where to download this card's pass. Each business's card keeps one pass serial for good. */
export function walletPass(device: Device, cardId: string, platform: string) {
  // Google Wallet needs a Google Cloud issuer account, which the demo doesn't have.
  if (platform !== 'apple' || !walletStatus().configured) return { url: '' };
  const customer = customerOf(device);
  const card = customer.cards.find((item) => item.cardId === cardId);
  if (!card) throw new ApiError('notFound', 'No such card');
  let pass = customer.passes.find((item) => item.businessId === card.businessId);
  if (!pass) {
    pass = { businessId: card.businessId, serial: newId(), token: `pass-${newId()}` };
    customer.passes.push(pass);
  }
  return { url: `/api/wallet/apple/${pass.serial}.pkpass` };
}

/** The pass for a serial, built from the card as it is now. `origin` is where its links point. */
export function passCard(serial: string, origin: string): PassCard | undefined {
  const found = findPass((pass) => pass.serial === serial);
  if (!found) return undefined;
  const { customer, pass } = found;
  const { business, program } = BUSINESSES[pass.businessId];
  const card = openCard(customer, pass.businessId);
  pass.shown = snapshot(customer, card);
  pass.authToken ??= randomBytes(24).toString('hex');
  persist();
  return {
    businessId: business.id,
    name: business.name,
    location: business.location,
    reward: program.rewardDescription,
    punches: card.punches,
    required: card.requiredPunches,
    rewardsReady: unused(customer, pass.businessId).length,
    paper: program.theme.lightPaper,
    ink: program.theme.lightInk,
    serial: pass.serial,
    link: `${origin}/w/${pass.token}`,
    // iOS rejects a pass whose web service isn't HTTPS ("Safari cannot download this file"),
    // unless the phone has Settings → Developer → Allow HTTP Services on. So over plain http the
    // pass leaves it out (Update Wallet card refreshes it instead), unless WALLET_HTTP_SERVICES=1.
    webService: origin.startsWith('https://') || process.env.WALLET_HTTP_SERVICES === '1'
      ? { url: `${origin}/passkit`, authenticationToken: pass.authToken }
      : undefined,
    // The visit dates for the stamps on this card, oldest first.
    dates: card.punches
      ? customer.visits
        .filter((visit) => visit.businessId === pass.businessId)
        .map((visit) => visit.at)
        .sort()
        .slice(-card.punches)
      : [],
  };
}
