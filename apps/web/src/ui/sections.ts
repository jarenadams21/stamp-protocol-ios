import type { CardState } from '../api';
import { el, svg } from './dom';
import { icon, panelTitle } from './icons';
import { pageStyle } from './passport';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

let introPlayed = false;

/**
 * The JOEYY mark: an orange tile with one punched hole. The header's mark plays its intro once
 * per visit (the tile lands, the hole punches through, its rim draws round), not on every page.
 */
export function logoMark(size = 26, intro = false) {
  const playIntro = intro && !introPlayed;
  if (playIntro) introPlayed = true;
  return svg(
    'svg',
    { class: `logo-mark${playIntro ? ' is-intro' : ''}`, width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': 'true' },
    svg('rect', { width: 32, height: 32, rx: 8, class: 'logo-tile' }),
    svg('circle', { cx: 16, cy: 16, r: 6.5, class: 'logo-hole' }),
    svg('circle', { cx: 16, cy: 16, r: 6.5, class: 'logo-ring', pathLength: 1 }),
  );
}

/** "Verified tap at 4:32 PM": the server checked the stand's signature for this stamp. */
export function verifiedSeal(at: Date, label = 'Verified tap') {
  return el(
    'p',
    { class: 'verified' },
    svg(
      'svg',
      { class: 'verified-icon', viewBox: '0 0 20 20', 'aria-hidden': 'true' },
      svg('path', { d: 'M10 1.5 3.5 4v5.2c0 4 2.8 7.6 6.5 9.3 3.7-1.7 6.5-5.3 6.5-9.3V4L10 1.5Z', class: 'verified-shield' }),
      svg('path', { d: 'm6.8 10.2 2.2 2.2 4.3-4.6', class: 'verified-check', pathLength: 1 }),
    ),
    `${label} at ${timeFormat.format(at)}`,
  );
}

const visitDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function visitLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = sameDay(date, today) ? 'Today' : sameDay(date, yesterday) ? 'Yesterday' : visitDay.format(date);
  return { day, time: timeFormat.format(date) };
}

/** The diner's recent stamps here; shows 4, with the rest one tap away. */
export function visitHistory(state: CardState) {
  const visits = state.recentVisits ?? [];
  if (!visits.length) return null;
  // Newest first, as small date stamps in a row that scrolls sideways.
  return el(
    'section',
    { class: 'block panel', 'aria-labelledby': 'visits-title' },
    panelTitle('calendar', 'Your visits', 'visits-title'),
    // Scrolls sideways, so it takes focus: arrow keys can scroll it too.
    el('ol', { class: 'visit-strip', style: pageStyle(state), tabindex: 0, 'aria-labelledby': 'visits-title' }, ...visits.map((iso, index) => {
      const { day, time } = visitLabel(iso);
      return el(
        'li',
        { class: `visit-chip${index === 0 ? ' is-latest' : ''}` },
        el('span', { class: 'visit-chip-day' }, day),
        el('span', { class: 'visit-chip-time' }, time),
      );
    })),
  );
}

/** A three-step explainer. Open by default the first time someone uses JOEYY. */
export function howItWorks(open: boolean) {
  const steps: [string, string][] = [
    ['Tap the stand', 'Hold the top of your phone on the JOEYY stand after you pay. No app needed.'],
    ['Collect stamps', 'Each visit adds one stamp. Your card is kept here, and in Apple Wallet if you add it.'],
    ['Get your reward', 'When the card fills, tap Use now, then Start, and tap the stand at the counter. Show the screen to the staff.'],
  ];
  return el(
    'details',
    { class: 'how', open },
    el('summary', { class: 'how-summary' }, el('span', { class: 'panel-title' }, el('span', { class: 'panel-icon' }, icon('question', 18)), 'How JOEYY works')),
    el(
      'ol',
      { class: 'how-steps' },
      ...steps.map(([title, text]) => el('li', {}, el('p', { class: 'how-title' }, title), el('p', { class: 'how-text' }, text))),
    ),
  );
}
