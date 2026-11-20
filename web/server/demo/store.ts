import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Business, ProgramVersion, RedeemIntent, Redemption, Reward } from '../../src/api/types';

// The demo backend's data, shaped like the real server's tables: customers own cards, devices
// (browsers, identified by an HttpOnly cookie) point at a customer, and Wallet passes belong to a
// customer. Kept in .demo/state.json (git-ignored) so a restart or a second phone sees the same thing.

export interface StoredCard {
  cardId: string;
  businessId: string;
  punches: number;
  requiredPunches: number;
  status: 'active' | 'completed';
  lastPunchAt?: number;
}

interface StoredReward extends Reward {
  businessId: string;
}

/** A Wallet pass for one business's card. `serial` names the pass; `token` is its sign-in link. */
export interface StoredPass {
  businessId: string;
  serial: string;
  token: string;
  /** What the pass showed when it was last downloaded ("punches/rewards"), to spot a stale pass. */
  shown?: string;
  /** The secret Wallet sends back when it registers the pass or downloads an update. */
  authToken?: string;
  /** Devices that asked to hear about changes to this pass, with their push tokens. */
  registrations?: { deviceId: string; pushToken: string }[];
  /** What the last push announced ("punches/rewards"), so each change is pushed once. */
  announced?: string;
  /** When the pass last changed, in ms: Wallet's "passes updated since" and Last-Modified. */
  updatedAt?: number;
}

/** Anonymous until it has a sign-in (number, Apple or Google). A device signed in from a pass link has kind "pass". */
export interface Customer {
  id: string;
  phone?: string;
  /** The Apple ID and Google account emails that sign in to this account. */
  apple?: string;
  google?: string;
  cards: StoredCard[];
  rewards: StoredReward[];
  visits: { businessId: string; at: string }[];
  /** The diner's own order for Your cards, by business ID. */
  order?: string[];
  /** What the diner asked to be called. Never leaves the diner's own routes. */
  displayName?: string;
  passes: StoredPass[];
}

export interface Device {
  id: string;
  customerId: string;
  /** Signed in from a Wallet pass link, to an account with no sign-in of its own yet. */
  viaPass?: boolean;
  /** How this device signed in to its account. */
  signedInWith?: 'phone' | 'apple' | 'google';
  pendingPhone?: string;
  /** Preview switches for this device. */
  offline?: boolean;
  /** The business owner signed in on this browser (the business site), and the email awaiting its code. */
  partnerId?: string;
  pendingEmail?: string;
}

/** A business owner's account on the business site, with what they've set up so far. */
export interface Partner {
  id: string;
  email: string;
  business?: Business;
  program?: ProgramVersion;
  stands: { standId: string; tagKey: string; label: string; status: 'active' | 'disabled'; linkedAt: string }[];
  pairingUntil?: number;
}

interface StoredIntent extends RedeemIntent {
  customerId: string;
  usedAt?: string;
  redemption?: Redemption;
}

interface State {
  customers: Record<string, Customer>;
  devices: Record<string, Device>;
  intents: Record<string, StoredIntent>;
  /** The highest counter seen from each stand; a tap must beat it (replay protection). */
  tagCounters: Record<string, number>;
  partners: Record<string, Partner>;
}

export const newId = () => randomUUID();

export const emptyCustomer = (): Customer => ({ id: newId(), cards: [], rewards: [], visits: [], passes: [] });

const DIR = join(process.cwd(), '.demo');
const FILE = join(DIR, 'state.json');

function load(): State {
  const empty: State = { customers: {}, devices: {}, intents: {}, tagCounters: {}, partners: {} };
  try {
    if (!existsSync(FILE)) return empty;
    const loaded: State = { ...empty, ...(JSON.parse(readFileSync(FILE, 'utf8')) as Partial<State>) };
    // A file saved by an older demo may lack lists added since; the code expects them all.
    for (const customer of Object.values(loaded.customers)) {
      customer.cards ??= [];
      customer.rewards ??= [];
      customer.visits ??= [];
      customer.passes ??= [];
    }
    return loaded;
  } catch {
    return empty;
  }
}

export const state = load();

// More than one dev server can run on this folder (a second port, a restart mid-edit). They share
// .demo/state.json, so each request starts from the newest copy on disk and each change is saved
// at once. Otherwise one server's old copy overwrites cards and passes another just made.
const modified = () => {
  try {
    return statSync(FILE).mtimeMs;
  } catch {
    return 0;
  }
};

let seen = modified();

/** Picks up changes another server saved since this one last read or wrote the file. */
export function syncFromDisk() {
  const onDisk = modified();
  if (onDisk <= seen) return;
  const fresh = load();
  state.customers = fresh.customers;
  state.devices = fresh.devices;
  state.intents = fresh.intents;
  state.tagCounters = fresh.tagCounters;
  state.partners = fresh.partners;
  seen = onDisk;
}

let queued = false;

/** Saves the state once the current request's changes are made (one write per request). */
export function persist() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify(state));
      seen = modified();
    } catch {
      /* Read-only folder: the demo keeps working from memory. */
    }
  });
}

/** The device for a cookie value, creating it (and an anonymous customer) when it's new or stale. */
export function deviceFor(deviceId: string | undefined): Device {
  let device = deviceId ? state.devices[deviceId] : undefined;
  if (!device) {
    const customer = emptyCustomer();
    state.customers[customer.id] = customer;
    device = { id: newId(), customerId: customer.id };
    state.devices[device.id] = device;
    persist();
  }
  // A scenario may have replaced the customer this device pointed at.
  if (!state.customers[device.customerId]) {
    const customer = emptyCustomer();
    state.customers[customer.id] = customer;
    device.customerId = customer.id;
    device.viaPass = undefined;
    persist();
  }
  return device;
}

export const customerOf = (device: Device) => state.customers[device.customerId];

/** Points this device at a new, empty customer: nothing saved, not signed in. */
export function newCustomerFor(device: Device) {
  const previous = customerOf(device);
  const customer = emptyCustomer();
  state.customers[customer.id] = customer;
  device.customerId = customer.id;
  device.viaPass = undefined;
  device.signedInWith = undefined;
  forgetIfOrphaned(previous);
}

/**
 * Drops a customer nobody can reach any more: no device points at it and it has no sign-in or pass.
 * Undefined when a scenario already replaced it.
 */
export function forgetIfOrphaned(customer: Customer | undefined) {
  if (!customer) return;
  const reachable = customer.phone || customer.apple || customer.google || customer.passes.length
    || Object.values(state.devices).some((device) => device.customerId === customer.id);
  if (!reachable) delete state.customers[customer.id];
}

export function findPass(match: (pass: StoredPass) => boolean) {
  for (const customer of Object.values(state.customers)) {
    const pass = customer.passes.find(match);
    if (pass) return { customer, pass };
  }
  return undefined;
}
