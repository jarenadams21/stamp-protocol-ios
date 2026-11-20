import { ApiError, type CardState, type RedeemIntent, type Reward, type StampApi } from '../api';
import { header, notice, openSheet } from '../ui/components';
import { announce, busy, countdown, el, svg } from '../ui/dom';
import { pageStyle } from '../ui/passport';
import { applyMerchantTheme } from '../ui/theme';
import { navigate } from '../router';
import { accountSlot, footer, loading, messagePage, mount } from './shared';
import { staffScreen } from './staff';

// Web redemption: a page can't run its own NFC scan on iPhone, so "Use now" opens a
// two-minute redeem window on the server. The diner's next tap on that business's stand
// arrives at /t as usual, and the server redeems instead of stamping (see docs/identity-and-api.md).

export function startRedeem(api: StampApi, state: CardState, reward: Reward) {
  openSheet(
    (close) => {
      const start = el('button', { class: 'button button-primary', type: 'button' }, 'Start');
      start.addEventListener('click', async () => {
        busy(start, 'Starting…');
        try {
          const intent = await api.startRedeem(reward.rewardId);
          close();
          navigate(`/r/${encodeURIComponent(intent.intentId)}`);
        } catch (error) {
          close();
          const used = error instanceof ApiError && error.code === 'notFound';
          notice(
            used ? 'This reward was already used' : 'Couldn’t start your reward',
            used ? 'Your card is up to date.' : 'Check your connection and try again.',
          );
        }
      });
      return el(
        'div',
        { class: 'sheet-body' },
        el('h2', { class: 'sheet-title' }, 'Use your reward now?'),
        el('p', { class: 'sheet-reward', style: pageStyle(state) }, reward.rewardDescription),
        el(
          'ol',
          { class: 'steps' },
          el('li', {}, 'Tap your phone on the stand.'),
          el('li', {}, 'Show the screen that opens to the staff.'),
        ),
        el('p', { class: 'sheet-text' }, `Do this at the counter at ${state.business.name}. You’ll have 2 minutes to tap.`),
        start,
        el('button', { class: 'button button-quiet', type: 'button', onclick: close }, 'Not now'),
      );
    },
    'Use your reward',
  );
}

const RING_RADIUS = 54;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const ringOffset = (fraction: number) => (RING_LENGTH * (1 - Math.max(0, fraction))).toFixed(2);

function ring(fraction: number) {
  const fill = svg('circle', {
    cx: 60, cy: 60, r: RING_RADIUS, class: 'ring-fill',
    'stroke-dasharray': RING_LENGTH.toFixed(2),
    'stroke-dashoffset': ringOffset(fraction),
  });
  const root = svg(
    'svg',
    { class: 'countdown-ring', viewBox: '0 0 120 120', 'aria-hidden': 'true' },
    svg('circle', { cx: 60, cy: 60, r: RING_RADIUS, class: 'ring-track' }),
    fill,
  );
  // Only the fill's offset changes as time runs down.
  return { root, set: (next: number) => fill.setAttribute('stroke-dashoffset', ringOffset(next)) };
}

export async function redeemScreen(api: StampApi, intentId: string) {
  let intent: RedeemIntent;
  let state: CardState;
  try {
    const found = await loading(
      api.redeemIntent(intentId).then(async (answer) => ({ ...answer, state: await api.card(answer.intent.businessId) })),
      'Opening your reward…',
    );
    intent = found.intent;
    state = found.state;
    if (found.redemption) {
      staffScreen(state, found.redemption);
      return;
    }
  } catch {
    messagePage({ api, drawing: 'page', headline: 'This reward screen has closed', message: 'Open your card to see your rewards.', action: { label: 'Open your cards', href: '/c' } });
    return;
  }

  applyMerchantTheme(state.program.theme);
  const total = 120_000;
  const expires = Date.parse(intent.expiresAt);
  // role="timer" lets a screen reader read the time on request; it's also spoken at 30 and 10 seconds.
  const timeText = el('p', { class: 'countdown-time', role: 'timer', 'aria-label': 'Time left to tap' }, countdown(expires - Date.now()));
  const dial = ring((expires - Date.now()) / total);
  const ringSlot = el('div', { class: 'countdown' }, dial.root, timeText);
  const reward = state.rewardsAvailable.find((r) => r.rewardId === intent.rewardId)?.rewardDescription;

  const simulate = import.meta.env.VITE_MODE === 'demo'
    ? el('button', {
        class: 'button button-secondary',
        type: 'button',
        onclick: async () => {
          const { demo } = await import('../api/demo');
          navigate((await demo.stamp(state.business.id)).next);
        },
      }, 'Preview: tap the stand')
    : null;

  let done = false;
  const cancel = el('button', { class: 'button button-quiet', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', async () => {
    done = true;
    await api.cancelRedeem(intentId).catch(() => undefined);
    navigate(`/c?open=${encodeURIComponent(state.business.id)}`, { replace: true });
  });

  mount(
    el(
      'main',
      { class: 'page page-redeem' },
      header({ account: accountSlot(api) }),
      el(
        'section',
        { class: 'hero' },
        el('p', { class: 'place' }, el('span', { class: 'place-name' }, state.business.name)),
        el('h1', { class: 'headline' }, 'Tap the stand'),
        el('p', { class: 'subline' }, 'Hold the top of your phone on the JOEYY stand to use your reward. Then show your screen to the staff.'),
      ),
      ringSlot,
      reward ? el('p', { class: 'redeem-reward' }, reward) : null,
      el('div', { class: 'redeem-actions' }, simulate, cancel),
      footer(),
    ),
  );
  announce('Tap the stand within 2 minutes to use your reward.');

  // The tap usually opens in a new tab. This tab watches the intent so either one can show the staff screen.
  const warned = new Set<number>();
  const tick = setInterval(() => {
    if (done || !document.body.contains(ringSlot)) {
      clearInterval(tick);
      return;
    }
    const left = expires - Date.now();
    timeText.textContent = countdown(left);
    dial.set(left / total);
    for (const mark of [30, 10]) {
      if (left <= mark * 1000 && left > 0 && !warned.has(mark)) {
        warned.add(mark);
        announce(`${mark} seconds left to tap the stand.`);
      }
    }
    if (left <= 0) {
      clearInterval(tick);
      done = true;
      messagePage({
        api,
        drawing: 'page',
        headline: 'Time ran out',
        message: 'Your reward wasn’t used. It’s still on your card whenever you’re ready.',
        action: { label: 'Back to your card', onClick: () => navigate(`/c?open=${encodeURIComponent(state.business.id)}`) },
      });
    }
  }, 250);

  const poll = async () => {
    if (done) return;
    try {
      const { redemption } = await api.redeemIntent(intentId);
      if (redemption && !done) {
        done = true;
        clearInterval(tick);
        staffScreen(await api.card(state.business.id), redemption);
        return;
      }
    } catch {
      /* Keep waiting; the countdown handles expiry. */
    }
    if (!done) setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void poll();
  });
}
