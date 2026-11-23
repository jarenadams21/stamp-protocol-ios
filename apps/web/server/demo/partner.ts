import { randomBytes } from 'node:crypto';
import type { Artwork, Typeface } from '../../src/api/types';
import {
  PartnerError,
  type Activity,
  type ApiProgram,
  type Dashboard,
  type PartnerBusiness,
  type Session,
  type Stands,
} from '../../src/business/types';
import { readable } from '../../src/ui/contrast';
import { BUSINESSES, TAGS } from './data';
import { Answer } from './http';
import { DEMO_CODE } from './service';
import { newId, state, type Partner } from './store';

// The shared API's sign-in (/v1/auth/email/*, refresh, sign-out) and partner routes (/v1/partner/*,
// /v1/dev/stands/touch), answered on the demo's state with the same bodies, codes and limits as
// services/api and docs/web-connect.md. A business made here is a real place to the diner side:
// once its card is published it joins BUSINESSES, each linked stand joins TAGS, and a tap on that
// stand stamps its card.

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 60 * 86_400_000;
const CODE_MS = 10 * 60_000;
const PAIRING_MS = 120_000;
const TYPEFACES: Typeface[] = ['standard', 'rounded', 'serif', 'monospaced'];
const ARTWORK: Artwork[] = ['rail', 'cloud', 'stone'];

const invalid = (code: string, message: string) => new PartnerError(400, code, message);
const unauthorized = () => new PartnerError(401, 'unauthorized', 'Sign in again.');
const businessNotFound = () => new PartnerError(404, 'businessNotFound', 'Set up your business first.');
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Puts every published business and its stands where the diner routes look them up. */
export function registerPartners() {
  for (const partner of Object.values(state.partners)) {
    if (!partner.business || !partner.program) continue;
    const { id, name, location } = partner.business;
    const { coverKey: _noUploadsInDemo, coverURL: _none, ...theme } = partner.program.theme;
    BUSINESSES[id] = { business: { id, name, location }, program: { ...partner.program, theme } };
    for (const stand of partner.stands) TAGS[stand.tagKey] = { businessId: id, status: stand.status };
  }
}

// ---------- Sign-in (/v1/auth) ----------

function parseEmail(value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+\.[^\s@<>()"',;:\\]{2,}$/.test(email)) {
    throw invalid('invalidEmail', 'Enter a valid email address.');
  }
  return email;
}

function issueSession(partnerId: string): Session {
  const now = Date.now();
  for (const [token, entry] of Object.entries(state.partnerTokens)) if (entry.expiresAt < now) delete state.partnerTokens[token];
  const token = () => randomBytes(32).toString('base64url');
  const accessToken = token();
  const refreshToken = token();
  state.partnerTokens[accessToken] = { partnerId, kind: 'access', expiresAt: now + ACCESS_MS };
  state.partnerTokens[refreshToken] = { partnerId, kind: 'refresh', expiresAt: now + REFRESH_MS };
  return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_MS / 1000, refreshToken };
}

export function startEmail(body: Record<string, unknown>) {
  const email = parseEmail(body.email);
  // The demo sends nothing: the code is always 123456, as on the diner side.
  state.partnerCodes[email] = Date.now() + CODE_MS;
  return new Answer(202, { expiresIn: CODE_MS / 1000, resendAfter: 30 });
}

export function verifyEmail(body: Record<string, unknown>) {
  if (body.role !== 'customer' && body.role !== 'partner') throw invalid('invalidRole', 'role must be "customer" or "partner".');
  // Diners sign in through /v1/web/* in the demo; this stands in for owners only.
  if (body.role === 'customer') throw new PartnerError(503, 'signInUnavailable', 'This sign-in option isn’t available yet.');
  const email = parseEmail(body.email);
  const pending = state.partnerCodes[email];
  if (!pending || pending < Date.now() || body.code !== DEMO_CODE) {
    throw invalid('invalidCode', 'That code is wrong or has expired. Ask for a new one.');
  }
  delete state.partnerCodes[email];
  let partner = Object.values(state.partners).find((item) => item.email === email);
  if (!partner) {
    partner = { id: newId(), email, stands: [] };
    state.partners[partner.id] = partner;
  }
  return issueSession(partner.id);
}

export function refresh(body: Record<string, unknown>) {
  const token = typeof body.refreshToken === 'string' ? body.refreshToken : '';
  const entry = state.partnerTokens[token];
  if (!entry || entry.kind !== 'refresh' || entry.expiresAt < Date.now()) throw unauthorized();
  // Refresh tokens rotate: this one is spent.
  delete state.partnerTokens[token];
  return issueSession(entry.partnerId);
}

export function signOut(body: Record<string, unknown>) {
  if (typeof body.refreshToken === 'string' && state.partnerTokens[body.refreshToken]?.kind === 'refresh') {
    delete state.partnerTokens[body.refreshToken];
  }
}

/** The owner a bearer token belongs to. Every partner route starts here. */
export function partnerFor(authorization: string | undefined): Partner {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1] ?? '';
  const entry = state.partnerTokens[token];
  const partner = entry?.kind === 'access' && entry.expiresAt > Date.now() ? state.partners[entry.partnerId] : undefined;
  if (!partner) throw unauthorized();
  return partner;
}

// ---------- Business ----------

const characters = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
const timeZones = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

function slug(name: string) {
  const base = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'place';
  return `${base}-${randomBytes(2).toString('hex')}`;
}

function business(partner: Partner) {
  if (!partner.business) throw businessNotFound();
  return partner.business;
}

export const getBusiness = (partner: Partner) => business(partner);

export function saveBusiness(partner: Partner, body: Record<string, unknown>) {
  if (typeof body.name !== 'string' || !body.name.trim()) throw invalid('missingName', 'Enter your business name.');
  const name = body.name.trim();
  if (characters(name) > 40) throw invalid('nameTooLong', 'Use 40 characters or fewer for the business name.');
  if (body.location !== undefined && typeof body.location !== 'string') throw invalid('invalidLocation', 'Location must be text.');
  const location = (body.location ?? '').trim();
  if (characters(location) > 120) throw invalid('locationTooLong', 'Use 120 characters or fewer for the location.');
  const timeZone = body.timeZone ?? 'UTC';
  if (typeof timeZone !== 'string' || !timeZones.has(timeZone)) {
    throw invalid('invalidTimeZone', 'Use an IANA time zone, such as America/Los_Angeles.');
  }
  // The demo has no image uploads, so no key can be one of this business's.
  if (body.logoKey !== undefined && body.logoKey !== null) throw invalid('unknownImage', 'Upload the image again, then save.');
  const created = !partner.business;
  const id = partner.business?.id ?? slug(name);
  const saved: PartnerBusiness = {
    id, clientId: id, name, location, logoKey: null, logoURL: null, timeZone,
    currentProgramVersionId: partner.program?.versionId ?? null,
  };
  partner.business = saved;
  registerPartners();
  return new Answer(created ? 201 : 200, saved);
}

// ---------- Program ----------

export function getProgram(partner: Partner) {
  business(partner);
  if (!partner.program) throw new PartnerError(404, 'programNotFound', 'Publish your card first.');
  return partner.program;
}

function parseTheme(value: unknown): ApiProgram['theme'] {
  const fail = () => invalid('invalidTheme', 'Card colors must provide at least 4.5:1 text contrast in light and dark mode.');
  if (!isObject(value)) throw fail();
  const hex = (field: unknown) => (typeof field === 'string' && /^#[0-9a-fA-F]{6}$/.test(field) ? field.toUpperCase() : '');
  const colours = { lightPaper: hex(value.lightPaper), lightInk: hex(value.lightInk), darkPaper: hex(value.darkPaper), darkInk: hex(value.darkInk) };
  if (!readable(colours)) throw fail();
  if (!TYPEFACES.includes(value.typeface as Typeface)) throw invalid('invalidTheme', `typeface must be one of ${TYPEFACES.join(', ')}.`);
  if (!ARTWORK.includes(value.artwork as Artwork)) throw invalid('invalidTheme', `artwork must be one of ${ARTWORK.join(', ')}.`);
  if (typeof value.allowsMotion !== 'boolean') throw invalid('invalidTheme', 'allowsMotion must be true or false.');
  if (value.coverURL !== undefined && value.coverURL !== null) {
    throw invalid('invalidTheme', 'coverURL is set by the server. Upload a cover image instead.');
  }
  if (value.coverKey !== undefined && value.coverKey !== null) throw invalid('unknownImage', 'Upload the image again, then save.');
  return { ...colours, typeface: value.typeface as Typeface, artwork: value.artwork as Artwork, allowsMotion: value.allowsMotion, coverKey: null, coverURL: null };
}

export function publish(partner: Partner, body: Record<string, unknown>) {
  const punches = body.requiredPunches;
  if (typeof punches !== 'number' || !Number.isInteger(punches) || punches < 3 || punches > 12) {
    throw invalid('invalidPunches', 'Choose between 3 and 12 punches.');
  }
  const reward = typeof body.rewardDescription === 'string' ? body.rewardDescription.trim() : '';
  if (!reward) throw invalid('missingReward', 'Describe the reward customers earn.');
  if (characters(reward) > 60) throw invalid('rewardTooLong', 'Use 60 characters or fewer for the reward.');
  const theme = parseTheme(body.theme);
  const owned = business(partner);
  const live = partner.program;
  const keys = ['lightPaper', 'lightInk', 'darkPaper', 'darkInk', 'typeface', 'artwork', 'allowsMotion', 'coverKey'] as const;
  if (live && live.requiredPunches === punches && live.rewardDescription === reward && keys.every((key) => live.theme[key] === theme[key])) {
    throw new PartnerError(409, 'unchangedProgram', 'This matches the published card. Make a change before publishing.');
  }
  const version = (live?.version ?? 0) + 1;
  partner.program = {
    versionId: `${owned.id}-v${version}`, version, requiredPunches: punches, rewardDescription: reward, theme,
    publishedAt: new Date().toISOString(),
  };
  owned.currentProgramVersionId = partner.program.versionId;
  registerPartners();
  return new Answer(201, partner.program);
}

// ---------- Stands (docs/web-connect.md) ----------

function lastTap(tagKey: string) {
  const counter = state.tagCounters[tagKey];
  // Demo counters are timestamps (see scenarios.ts tapUrl), so the newest one is the last tap.
  return counter && counter > 1e12 ? new Date(counter).toISOString() : null;
}

export function stands(partner: Partner): Stands {
  business(partner);
  const open = partner.pairingUntil && partner.pairingUntil > Date.now();
  return {
    stands: partner.stands.map(({ tagKey, ...stand }) => ({ ...stand, lastTapAt: lastTap(tagKey) })),
    pairing: open ? { expiresAt: new Date(partner.pairingUntil!).toISOString() } : null,
  };
}

export function startPairing(partner: Partner) {
  business(partner);
  // A stand can't stamp a card that doesn't exist yet.
  if (!partner.program) throw new PartnerError(409, 'noLiveProgram', 'Publish your card first.');
  partner.pairingUntil = Date.now() + PAIRING_MS;
  return stands(partner);
}

export function cancelPairing(partner: Partner) {
  partner.pairingUntil = undefined;
  return stands(partner);
}

export function turnOffStand(partner: Partner, standId: string) {
  const stand = partner.stands.find((item) => item.standId === standId);
  if (!stand) throw new PartnerError(404, 'standNotFound', 'No such stand.');
  stand.status = 'disabled';
  registerPartners();
  return stands(partner);
}

/**
 * POST /v1/dev/stands/touch: the owner's phone touching a new stand from their kit while pairing is
 * open. On the real API a stand allocated at packing is activated by its first tap in the window.
 */
export function touchStand(partner: Partner) {
  const owned = business(partner);
  if (!partner.pairingUntil || partner.pairingUntil < Date.now()) {
    throw new PartnerError(409, 'pairingClosed', 'Open pairing first.');
  }
  const count = partner.stands.length;
  const tagUid = `${owned.id}-stand-${count + 1}`;
  partner.stands.push({
    standId: newId(), tagKey: tagUid, label: count ? `Stand ${count + 1}` : 'Counter stand', status: 'active',
    linkedAt: new Date().toISOString(),
  });
  partner.pairingUntil = undefined;
  registerPartners();
  return { tagUid };
}

// ---------- Dashboard and activity ----------

function parseInstant(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid('invalidRange', `${name} must be an ISO 8601 instant, such as 2026-11-09T08:00:00Z.`);
  }
  return new Date(value).toISOString();
}

/** The half-open range from <= t < to as ISO strings (they sort like the instants they name). */
function range(query: URLSearchParams) {
  const from = query.has('from') ? parseInstant(query.get('from'), 'from') : '';
  const to = parseInstant(query.get('to') ?? undefined, 'to');
  if (from > to) throw invalid('invalidRange', 'from must not be after to.');
  return (at: string | undefined) => Boolean(at && at >= from && at < to);
}

export function dashboard(partner: Partner, query: URLSearchParams): Dashboard {
  const { id } = business(partner);
  const inRange = range(query);
  const figures: Dashboard = { enrolledCardholders: 0, punches: 0, rewardsEarned: 0, rewardsRedeemed: 0, rewardsWaiting: 0, customersWithStackedRewards: 0 };
  for (const customer of Object.values(state.customers)) {
    if (customer.cards.some((card) => card.businessId === id)) figures.enrolledCardholders += 1;
    figures.punches += customer.visits.filter((visit) => visit.businessId === id && inRange(new Date(visit.at).toISOString())).length;
    const rewards = customer.rewards.filter((reward) => reward.businessId === id);
    figures.rewardsEarned += rewards.filter((reward) => inRange(reward.earnedAt)).length;
    figures.rewardsRedeemed += rewards.filter((reward) => inRange(reward.redeemedAt)).length;
    const waiting = rewards.filter((reward) => !reward.redeemedAt).length;
    figures.rewardsWaiting += waiting;
    if (waiting > 1) figures.customersWithStackedRewards += 1;
  }
  return figures;
}

/** Stamps and rewards used at this business, newest first, at most 50. Nothing says who. */
export function activity(partner: Partner, query: URLSearchParams) {
  const { id } = business(partner);
  const inRange = range(query);
  const required = partner.program?.requiredPunches ?? 0;
  const items: Activity[] = [];
  for (const customer of Object.values(state.customers)) {
    const visits = customer.visits.filter((visit) => visit.businessId === id).map((visit) => new Date(visit.at).toISOString()).sort();
    visits.forEach((at, index) => {
      if (!inRange(at)) return;
      const punches = required ? (index % required) + 1 : index + 1;
      items.push({ kind: index === 0 ? 'first' : punches === required ? 'earned' : 'stamp', at, punches });
    });
    for (const reward of customer.rewards) {
      if (reward.businessId === id && inRange(reward.redeemedAt)) items.push({ kind: 'used', at: reward.redeemedAt!, punches: null });
    }
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { activity: items.slice(0, 50) };
}
