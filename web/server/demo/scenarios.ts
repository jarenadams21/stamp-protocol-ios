import { SAMPLE_EMAILS } from '../../src/demo/sample';
import { BUSINESSES, counterTag } from './data';
import { issueReward } from './service';
import { customerOf, emptyCustomer, forgetIfOrphaned, newCustomerFor, newId, state, type Customer, type Device } from './store';

// The Preview states panel: each scenario sets up this device's data on the demo server and says
// which page to open next. They only exist in the demo; production has no such routes.

const SAMPLE_PHONE = '6045550123';
const DAY = 86_400_000;

/** A tap URL for a stand, the way a phone would open it, with a counter newer than any before. */
function tapUrl(tagKey: string) {
  const counter = Math.max(Date.now(), (state.tagCounters[tagKey] ?? 0) + 1);
  return `/t?picc=${tagKey}.${counter}&cmac=demo`;
}

/** Puts a card at a number of stamps, with a believable visit history behind it. */
function setCard(customer: Customer, businessId: string, punches: number, options: { recent?: boolean } = {}) {
  const required = BUSINESSES[businessId].program.requiredPunches;
  customer.cards = customer.cards.filter((card) => card.businessId !== businessId);
  customer.cards.push({
    cardId: newId(),
    businessId,
    punches,
    requiredPunches: required,
    status: punches >= required ? 'completed' : 'active',
    lastPunchAt: options.recent ? Date.now() : Date.now() - DAY,
  });
  // One visit every few days, the latest today or yesterday.
  customer.visits = customer.visits.filter((visit) => visit.businessId !== businessId);
  for (let index = 0; index < punches; index += 1) {
    const daysAgo = (punches - 1 - index) * 3 + (options.recent ? 0 : 1);
    const at = new Date(Date.now() - daysAgo * DAY);
    at.setHours(8 + ((index * 5) % 9), (index * 17) % 60, 0, 0);
    // A recent card's last stamp is just now, matching lastPunchAt.
    if (options.recent && index === punches - 1) at.setTime(Date.now());
    customer.visits.push({ businessId, at: at.toISOString() });
  }
}

function clearRewards(customer: Customer, businessId: string) {
  customer.rewards = customer.rewards.filter((reward) => reward.businessId !== businessId || reward.redeemedAt);
}

function addReward(customer: Customer, businessId: string, daysAgo = 3) {
  issueReward(customer, businessId, new Date(Date.now() - daysAgo * DAY));
}

/** A regular's account on the server: five cards and a reward. Replaces any older sample account. */
function sampleAccount(extra: Partial<Customer>): Customer {
  for (const customer of Object.values(state.customers)) {
    const clashes = (extra.phone && customer.phone === extra.phone)
      || (extra.apple && customer.apple === extra.apple)
      || (extra.google && customer.google === extra.google)
      || extra.passes?.some((pass) => customer.passes.some((item) => item.token === pass.token));
    if (clashes) delete state.customers[customer.id];
  }
  const account: Customer = { ...emptyCustomer(), ...extra };
  for (const [businessId, punches] of [['littlefog', 2], ['ferrous', 4], ['tallow', 6], ['bluestem', 1], ['norema', 7]] as const) {
    setCard(account, businessId, punches);
  }
  addReward(account, 'ferrous', 2);
  state.customers[account.id] = account;
  return account;
}

/** A fresh phone, with the sample account (its number, Apple ID and Google account) on the server. */
function newPhone(device: Device) {
  sampleAccount({ phone: SAMPLE_PHONE, apple: SAMPLE_EMAILS.apple, google: SAMPLE_EMAILS.google });
  newCustomerFor(device);
  return tapUrl('norema-counter');
}

/** A sample pass link: a fixed token so the scenario can open it. */
const samplePass = (businessId: string) => ({ businessId, serial: newId(), token: `demo-pass-${businessId}` });

type Scenario = (device: Device, customer: Customer) => string;

export const SCENARIOS: Record<string, Scenario> = {
  // Your cards
  'full-wallet': (_device, customer) => {
    const progress = [['littlefog', 2], ['ferrous', 4], ['tallow', 6], ['pholune', 3], ['marrow', 5], ['sunday', 8], ['bluestem', 1], ['norema', 7]] as const;
    for (const [businessId, punches] of progress) setCard(customer, businessId, punches);
    customer.rewards = customer.rewards.filter((reward) => reward.redeemedAt);
    addReward(customer, 'norema', 6);
    addReward(customer, 'ferrous', 2);
    return '/c';
  },

  // Accounts and sign-in
  // One sample account with all three sign-ins; the label says which to press.
  'new-phone-apple': (device) => newPhone(device),
  'new-phone-google': (device) => newPhone(device),
  'new-phone-code': (device) => newPhone(device),
  'pass-link': (device) => {
    sampleAccount({ passes: [samplePass('norema')] });
    newCustomerFor(device);
    return '/w/demo-pass-norema';
  },
  'signed-in': (device) => {
    const account = sampleAccount({ phone: SAMPLE_PHONE, apple: SAMPLE_EMAILS.apple, google: SAMPLE_EMAILS.google });
    const previous = customerOf(device);
    device.customerId = account.id;
    device.viaPass = undefined;
    device.signedInWith = 'phone';
    forgetIfOrphaned(previous);
    return tapUrl('norema-counter');
  },

  // Stamps
  'first-tap': (_device, customer) => {
    customer.cards = customer.cards.filter((card) => card.businessId !== 'norema');
    return tapUrl('norema-counter');
  },
  'halfway': (_device, customer) => (setCard(customer, 'norema', 5), tapUrl('norema-counter')),
  'last-stamp': (_device, customer) => (setCard(customer, 'norema', 9), tapUrl('norema-counter')),
  'full-card': (_device, customer) => {
    setCard(customer, 'norema', 10);
    addReward(customer, 'norema', 1);
    return tapUrl('norema-counter');
  },
  // Sunday Ramen allows one stamp every 30 minutes (data.ts); most places set no limit.
  'tapped-twice': (_device, customer) => (setCard(customer, 'sunday', 3, { recent: true }), tapUrl('sunday-counter')),

  // Rewards
  'use-reward': (_device, customer) => {
    setCard(customer, 'norema', 4);
    clearRewards(customer, 'norema');
    addReward(customer, 'norema');
    return '/c/norema';
  },
  'two-rewards': (_device, customer) => {
    setCard(customer, 'ferrous', 2);
    clearRewards(customer, 'ferrous');
    addReward(customer, 'ferrous', 9);
    addReward(customer, 'ferrous', 2);
    return '/c/ferrous';
  },
  'wallet-one-stamp': (_device, customer) => {
    setCard(customer, 'norema', 1);
    clearRewards(customer, 'norema');
    return '/c/norema';
  },
  'fills-in-wallet': (_device, customer) => {
    setCard(customer, 'norema', 9);
    clearRewards(customer, 'norema');
    // As if this card's pass was added at 9 stamps and the phone hasn't updated it since.
    const pass = customer.passes.find((item) => item.businessId === 'norema');
    if (pass) pass.shown = '9/0';
    else customer.passes.push({ ...samplePass('norema'), token: `pass-${newId()}`, shown: '9/0' });
    return tapUrl('norema-counter');
  },
  'use-reward-from-pass': (device) => {
    // The pass already shows the ready reward (4 stamps, 1 reward), so it's up to date.
    sampleAccount({ passes: [{ ...samplePass('ferrous'), shown: '4/1' }] });
    newCustomerFor(device);
    return '/w/demo-pass-ferrous?use=reward';
  },

  // Card styles
  'style-ferrous': (_device, customer) => (setCard(customer, 'ferrous', 3), tapUrl('ferrous-bar')),
  'style-littlefog': (_device, customer) => (setCard(customer, 'littlefog', 1), tapUrl('littlefog-till')),
  'style-tallow': (_device, customer) => (setCard(customer, 'tallow', 6), tapUrl('tallow-counter')),
  'style-pholune': (_device, customer) => {
    customer.cards = customer.cards.filter((card) => card.businessId !== 'pholune');
    return tapUrl('pholune-counter');
  },

  // Problems
  'old-link': (_device, customer) => {
    setCard(customer, 'norema', 2);
    const url = tapUrl('norema-counter');
    // The stand has since been tapped with a newer counter, so this link is a replay.
    state.tagCounters['norema-counter'] = Date.now() + 1e9;
    return url;
  },
  'unreadable': () => '/t?picc=unknown.1&cmac=demo',
  'not-set-up': () => tapUrl('norema-new'),
  'retired': () => tapUrl('norema-stolen'),

  // Settings
  'start-over': (device) => {
    newCustomerFor(device);
    device.offline = undefined;
    return '/';
  },
};

/**
 * Taps the stand of the card on screen once, so a demo can step a card (and its Wallet pass) along
 * one visit at a time. A business with a repeat-stamp limit answers "Already stamped", as it would.
 */
export function addStamp(businessId: string) {
  const tagKey = counterTag(businessId);
  return tagKey ? tapUrl(tagKey) : undefined;
}
