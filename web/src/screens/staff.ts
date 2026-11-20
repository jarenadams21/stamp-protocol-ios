import type { CardState, Redemption } from '../api';
import { announce, countdown, el, haptic, prefersReducedMotion } from '../ui/dom';
import { applyMerchantTheme } from '../ui/theme';
import { mount } from './shared';

// The screen a diner shows staff. A screenshot gives itself away: the clock ticks, the
// band moves in today's colour, and the window closes after 2 minutes.

const SHOW_FOR = 120_000;

// One colour per weekday, so staff learn "Tuesday is green" and a reused screenshot stands out.
// These are the one deliberate exception to the theme tokens: they must look the same at every place.
const DAY_COLOURS = [
  { name: 'Red', value: '#C8372D' },
  { name: 'Blue', value: '#2F5FB3' },
  { name: 'Green', value: '#2E7D4F' },
  { name: 'Purple', value: '#7044A8' },
  { name: 'Orange', value: '#D2691E' },
  { name: 'Teal', value: '#1F7A80' },
  { name: 'Pink', value: '#B83D7A' },
];

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

let wakeLock: { release(): Promise<void> } | undefined;

export function staffScreen(state: CardState, redemption: Redemption) {
  applyMerchantTheme(state.program.theme);
  const today = DAY_COLOURS[new Date().getDay()];
  const redeemedAt = Date.parse(redemption.redeemedAt);

  const time = el('p', { class: 'staff-clock' }, timeFormat.format(new Date()));
  const remaining = el('p', { class: 'staff-remaining' });
  const band = el('div', { class: 'staff-band', style: `--day:${today.value}`, 'aria-hidden': 'true' });
  const hint = el('p', { class: 'staff-hint' }, 'Show this screen to the staff.');

  mount(
    el(
      'main',
      { class: 'page page-staff', style: `--day:${today.value}` },
      band,
      el(
        'section',
        { class: 'staff-body' },
        el('p', { class: 'staff-place' }, state.business.name),
        el('p', { class: 'staff-status' }, el('span', { class: 'staff-check', 'aria-hidden': 'true' }), 'Reward used'),
        el('h1', { class: 'staff-reward' }, redemption.rewardDescription),
        el('dl', { class: 'staff-facts' },
          el('div', {}, el('dt', {}, 'Code'), el('dd', { class: 'staff-code' }, redemption.code)),
          el('div', {}, el('dt', {}, 'Colour'), el('dd', {}, today.name))),
        time,
        el('p', { class: 'staff-day' }, dayFormat.format(new Date())),
        remaining,
      ),
      hint,
    ),
  );
  haptic([20, 50, 20]);
  announce(`Reward used: ${redemption.rewardDescription}. Show this screen to the staff.`);

  // Keep the screen awake while staff look at it (Screen Wake Lock API, Safari 16.4+).
  navigator.wakeLock?.request('screen').then((lock) => (wakeLock = lock)).catch(() => undefined);

  const update = () => {
    if (!document.body.contains(time)) {
      clearInterval(timer);
      return;
    }
    time.textContent = timeFormat.format(new Date());
    const left = redeemedAt + SHOW_FOR - Date.now();
    if (left > 0) {
      remaining.textContent = `Shown for ${countdown(left)} more`;
    } else {
      clearInterval(timer);
      band.classList.add('is-stopped');
      time.classList.add('is-stopped');
      remaining.textContent = 'This screen has closed. The reward has been used.';
      // Once it's closed there's nothing to show the staff, so offer the way back instead.
      hint.replaceWith(el('a', { class: 'button button-secondary staff-back', href: `/c?open=${encodeURIComponent(state.business.id)}` }, `Back to your ${state.business.name} card`));
      void wakeLock?.release().catch(() => undefined);
    }
  };
  const timer = setInterval(update, 1000);
  update();

  if (prefersReducedMotion()) band.classList.add('is-still');
}
