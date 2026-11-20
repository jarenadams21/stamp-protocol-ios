import { demo, type DemoInfo } from '../api/demo';
import { notice, openSheet, toast } from '../ui/components';
import { el } from '../ui/dom';
import { navigate } from '../router';

// Preview controls for the team, shown only on the demo backend. Each item sets up this phone's
// data on the demo server (server/demo/scenarios.ts) and opens the page a diner would see.

const groups: { title: string; items: [label: string, scenario: string][] }[] = [
  { title: 'Your cards', items: [['Full wallet: eight places, two rewards', 'full-wallet']] },
  {
    title: 'Accounts and sign-in',
    items: [
      ['New phone, sign in with Apple', 'new-phone-apple'],
      ['New phone, sign in with Google', 'new-phone-google'],
      ['New phone, text code', 'new-phone-code'],
      ['Open my card from the Wallet pass', 'pass-link'],
      ['Already signed in on this phone', 'signed-in'],
    ],
  },
  {
    title: 'Stamps',
    items: [
      ['First tap, new card', 'first-tap'],
      ['Stamp halfway through', 'halfway'],
      ['Last stamp fills the card', 'last-stamp'],
      ['Stamp on a full card', 'full-card'],
      ['Tapped again too soon (Sunday Ramen sets 30 minutes)', 'tapped-twice'],
    ],
  },
  {
    title: 'Rewards',
    items: [
      ['Use a reward', 'use-reward'],
      ['Two rewards stacked', 'two-rewards'],
      ['Wallet demo: start a card at one stamp', 'wallet-one-stamp'],
      ['Card fills while it’s in Wallet', 'fills-in-wallet'],
      ['Use my reward, from the Wallet pass', 'use-reward-from-pass'],
    ],
  },
  {
    title: 'Card styles',
    items: [
      ['Ferrous Coffee, clipped stock', 'style-ferrous'],
      ['Little Fog Tea, rounded type', 'style-littlefog'],
      ['Tallow & Rye, square stock', 'style-tallow'],
      ['Pho Lune, first visit', 'style-pholune'],
    ],
  },
  {
    title: 'Problems',
    items: [
      ['Old link opened again', 'old-link'],
      ['Stand can’t be read', 'unreadable'],
      ['Stand not set up', 'not-set-up'],
      ['Stand retired', 'retired'],
    ],
  },
];

const unreachable = () => toast('Couldn’t reach the demo server. Is npm run dev still running?');

async function run(scenario: string) {
  try {
    const { next } = await demo.scenario(scenario);
    navigate(next);
  } catch {
    unreachable();
  }
}

/** The card on screen: /c/:businessId, or the opened card in Your cards (/c?open=…). */
function currentBusiness() {
  const match = /^\/c\/([^/]+)/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : new URLSearchParams(window.location.search).get('open') ?? undefined;
}

/** One tap on the stand of the card on screen. */
async function addStamp() {
  const businessId = currentBusiness();
  if (!businessId) {
    notice('Open a card first', 'Add a stamp works on a card’s page, or on an opened card in Your cards.');
    return;
  }
  try {
    navigate((await demo.stamp(businessId)).next);
  } catch {
    unreachable();
  }
}

function settings(info: DemoInfo | null, close: () => void) {
  const toggle = (key: 'offline', label: string) => {
    const input = el('input', { type: 'checkbox', checked: Boolean(info?.[key]) });
    input.addEventListener('change', async () => {
      await demo.settings({ [key]: input.checked }).catch(unreachable);
      location.reload();
    });
    return el('label', { class: 'demo-toggle' }, input, label);
  };
  return el(
    'section',
    { class: 'demo-group' },
    el('h3', {}, 'Settings'),
    toggle('offline', 'No connection'),
    el('p', { class: 'sheet-text' }, info?.walletConfigured
      ? 'Apple Wallet signing is set up: Add to Apple Wallet gives a real pass.'
      : 'Apple Wallet signing isn’t set up yet. web/.wallet/README.md has the steps.'),
    el('button', {
      type: 'button',
      class: 'demo-item is-reset',
      onclick: () => {
        close();
        void run('start-over');
      },
    }, 'Start over on this phone'),
  );
}

export function mountDemoPanel() {
  const open = async () => {
    const info = await demo.info().catch(() => null);
    openSheet((close) => el(
      'div',
      { class: 'sheet-body demo' },
      el('h2', { class: 'sheet-title' }, 'Preview states'),
      el('p', { class: 'sheet-text' }, 'This page is running on the demo server’s sample data. Pick a moment to see what a diner sees.'),
      ...groups.map((group) =>
        el(
          'section',
          { class: 'demo-group' },
          el('h3', {}, group.title),
          el('div', { class: 'demo-items' }, ...group.items.map(([label, scenario]) =>
            el('button', { type: 'button', class: 'demo-item', onclick: () => { close(); void run(scenario); } }, label))),
        ),
      ),
      settings(info, close),
    ), 'Preview states');
  };

  // A plain bar at the top of the page, not a floating button: iOS Safari's floating toolbar
  // can shift where taps land on fixed elements near the bottom of the screen.
  document.body.prepend(
    el(
      'div',
      { class: 'demo-bar' },
      el('span', {}, 'Sample data'),
      el('button', { class: 'demo-bar-button', type: 'button', onclick: () => void addStamp() }, 'Add a stamp'),
      el('button', { class: 'demo-bar-button', type: 'button', onclick: () => void open() }, 'Preview states'),
    ),
  );
}
