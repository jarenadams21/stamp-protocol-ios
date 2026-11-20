import { randomBytes } from 'node:crypto';
import { ApiError, type Artwork, type Typeface } from '../../src/api/types';
import type { Activity, BusinessInput, CardInput, PartnerAccount, Today } from '../../src/business/types';
import { readable } from '../../src/ui/contrast';
import { BUSINESSES, TAGS } from './data';
import { DEMO_CODE, maskedEmail } from './service';
import { newId, state, type Device, type Partner } from './store';

// The business site's backend (/v1/partner/*, docs/business-api.md), run on the demo's state. A
// business made here is a real place to the diner side: once its card is published it joins
// BUSINESSES, each linked stand joins TAGS, and a tap on that stand stamps its card.

const PAIRING_MS = 120_000;
const TYPEFACES: Typeface[] = ['standard', 'rounded', 'serif', 'monospaced'];
const ARTWORK: Artwork[] = ['rail', 'cloud', 'stone'];

/** Puts every published business and its stands where the diner routes look them up. */
export function registerPartners() {
  for (const partner of Object.values(state.partners)) {
    if (!partner.business || !partner.program) continue;
    BUSINESSES[partner.business.id] = { business: partner.business, program: partner.program };
    for (const stand of partner.stands) TAGS[stand.tagKey] = { businessId: partner.business.id, status: stand.status };
  }
}

function partnerOf(device: Device) {
  const partner = device.partnerId ? state.partners[device.partnerId] : undefined;
  if (!partner) throw new ApiError('signedOut', 'Not signed in');
  return partner;
}

function lastTap(tagKey: string) {
  const counter = state.tagCounters[tagKey];
  // Demo counters are timestamps (see scenarios.ts tapUrl), so the newest one is the last tap.
  return counter && counter > 1e12 ? new Date(counter).toISOString() : undefined;
}

function account(partner: Partner): PartnerAccount {
  const open = partner.pairingUntil && partner.pairingUntil > Date.now();
  return {
    maskedEmail: maskedEmail(partner.email),
    business: partner.business,
    program: partner.program,
    stands: partner.stands.map(({ standId, tagKey, label, status, linkedAt }) => ({
      standId, label, status, linkedAt, lastTapAt: lastTap(tagKey),
    })),
    pairing: open ? { expiresAt: new Date(partner.pairingUntil!).toISOString() } : undefined,
  };
}

/** The signed-in owner's account. Nothing (204) when this browser isn't signed in: not an error, just a visitor. */
export function me(device: Device) {
  const partner = device.partnerId ? state.partners[device.partnerId] : undefined;
  return partner ? account(partner) : undefined;
}

export function startEmail(device: Device, email: unknown) {
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 120) throw new ApiError('invalidEmail', 'Check the email');
  device.pendingEmail = address;
  // The demo sends nothing: the code is always 123456, as on the diner side.
  return { maskedEmail: maskedEmail(address) };
}

export function verifyEmail(device: Device, code: string) {
  if (!device.pendingEmail) throw new ApiError('expired', 'Start again');
  if (code.replace(/\D/g, '') !== DEMO_CODE) throw new ApiError('invalidCode', 'Wrong code');
  const email = device.pendingEmail;
  let partner = Object.values(state.partners).find((item) => item.email === email);
  if (!partner) {
    partner = { id: newId(), email, stands: [] };
    state.partners[partner.id] = partner;
  }
  device.partnerId = partner.id;
  device.pendingEmail = undefined;
  return account(partner);
}

export function signOut(device: Device) {
  device.partnerId = undefined;
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function slug(name: string) {
  const base = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'place';
  return `${base}-${randomBytes(2).toString('hex')}`;
}

export function saveBusiness(device: Device, body: Partial<BusinessInput>) {
  const partner = partnerOf(device);
  const name = text(body.name, 40);
  const location = text(body.location, 60);
  if (name.length < 2 || location.length < 2) throw new ApiError('invalidName', 'Add a name and where you are');
  partner.business = {
    id: partner.business?.id ?? slug(name),
    name,
    location,
    category: text(body.category, 30) || undefined,
    address: text(body.address, 100) || undefined,
  };
  registerPartners();
  return account(partner);
}

export function publishCard(device: Device, body: Partial<CardInput>) {
  const partner = partnerOf(device);
  if (!partner.business) throw new ApiError('notFound', 'Describe your place first');
  const punches = Number(body.requiredPunches);
  const reward = text(body.rewardDescription, 50);
  const theme = body.theme;
  const valid = Number.isInteger(punches) && punches >= 3 && punches <= 20 && reward.length >= 2
    && theme && readable(theme) && TYPEFACES.includes(theme.typeface) && ARTWORK.includes(theme.artwork);
  if (!valid) throw new ApiError('invalidCard', 'Check the card');
  const version = (partner.program?.version ?? 0) + 1;
  partner.program = {
    versionId: `${partner.business.id}-v${version}`,
    version,
    requiredPunches: punches,
    rewardDescription: reward,
    theme: {
      lightPaper: theme.lightPaper, lightInk: theme.lightInk, darkPaper: theme.darkPaper, darkInk: theme.darkInk,
      typeface: theme.typeface, artwork: theme.artwork, allowsMotion: true,
    },
  };
  registerPartners();
  return account(partner);
}

export function startPairing(device: Device) {
  const partner = partnerOf(device);
  // A stand can't stamp a card that doesn't exist yet.
  if (!partner.business || !partner.program) throw new ApiError('notFound', 'Publish your card first');
  partner.pairingUntil = Date.now() + PAIRING_MS;
  return account(partner);
}

export function cancelPairing(device: Device) {
  const partner = partnerOf(device);
  partner.pairingUntil = undefined;
  return account(partner);
}

/**
 * Demo only: the owner's phone touching a new stand from their kit while pairing is open. On the
 * real backend this is a tap on /v1/web/taps from a browser signed in to the business site, on a
 * stand allocated to that business (docs/tag-registration.md, flow C).
 */
export function linkDemoStand(device: Device) {
  const partner = partnerOf(device);
  if (!partner.business || !partner.pairingUntil || partner.pairingUntil < Date.now()) throw new ApiError('expired', 'Start linking again');
  const count = partner.stands.length;
  partner.stands.push({
    standId: newId(),
    tagKey: `${partner.business.id}-stand-${count + 1}`,
    label: count ? `Stand ${count + 1}` : 'Counter stand',
    status: 'active',
    linkedAt: new Date().toISOString(),
  });
  partner.pairingUntil = undefined;
  registerPartners();
  return account(partner);
}

export function turnOffStand(device: Device, standId: string) {
  const partner = partnerOf(device);
  const stand = partner.stands.find((item) => item.standId === standId);
  if (!stand) throw new ApiError('notFound', 'No such stand');
  stand.status = 'disabled';
  registerPartners();
  return account(partner);
}

/** Today's stamps and rewards at this business, from the diners' visits. Nothing says who. */
export function today(device: Device): Today {
  const partner = partnerOf(device);
  const id = partner.business?.id;
  const required = partner.program?.requiredPunches ?? 0;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();
  const activity: Activity[] = [];
  let stamps = 0;
  let newDiners = 0;
  let rewardsUsed = 0;
  if (id) {
    for (const customer of Object.values(state.customers)) {
      const visits = customer.visits.filter((visit) => visit.businessId === id).map((visit) => visit.at).sort();
      visits.forEach((at, index) => {
        if (at < since) return;
        stamps += 1;
        const punches = required ? (index % required) + 1 : index + 1;
        if (index === 0) newDiners += 1;
        activity.push({ kind: index === 0 ? 'first' : punches === required ? 'earned' : 'stamp', at, punches });
      });
      for (const reward of customer.rewards) {
        if (reward.businessId !== id || !reward.redeemedAt || reward.redeemedAt < since) continue;
        rewardsUsed += 1;
        activity.push({ kind: 'used', at: reward.redeemedAt });
      }
    }
  }
  activity.sort((a, b) => b.at.localeCompare(a.at));
  return { stamps, rewardsUsed, newDiners, activity: activity.slice(0, 12) };
}
