import type { CardState } from '../api';
import { el } from './dom';
import { panelTitle } from './icons';
import { pageStyle } from './passport';
import { visitDate } from './stamp-style';

// Things that change over time, worked out from data the API already sends (recentVisits,
// punches, rewards): milestones under a card's progress, the "nearly there" nudge on Your cards,
// and the recent-stamps timeline on the passport page.

const DAY = 86_400_000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const daysAgo = (date: Date, now = new Date()) => Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY);

function ordinal(n: number) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

const datesOf = (state: CardState) =>
  (state.recentVisits ?? []).map(visitDate).filter((date): date is Date => Boolean(date));

/** Weeks in a row, counting back from this week, with at least one visit. */
function weekStreak(dates: Date[], now = new Date()) {
  const mondayOf = (date: Date) => {
    const monday = startOfDay(date);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return monday;
  };
  const weeks = new Set(dates.map((date) => mondayOf(date).toDateString()));
  let streak = 0;
  for (const week = mondayOf(now); weeks.has(week.toDateString()); week.setDate(week.getDate() - 7)) streak += 1;
  return streak;
}

/** Up to three short facts: "3rd visit this month", "2 stamps to go", "4 weeks in a row". */
export function milestones(state: CardState) {
  const now = new Date();
  const dates = datesOf(state);
  const facts: string[] = [];
  const thisMonth = dates.filter((date) => date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()).length;
  if (thisMonth >= 2) facts.push(`${ordinal(thisMonth)} visit this month`);
  const left = state.card.requiredPunches - state.card.punches;
  if (state.card.status === 'completed') facts.push('Card full');
  else if (left <= 3) facts.push(left === 1 ? '1 stamp to go' : `${left} stamps to go`);
  const streak = weekStreak(dates, now);
  if (streak >= 2) facts.push(`${streak} weeks in a row`);
  const last = dates[0];
  if (facts.length < 3 && last) {
    const ago = daysAgo(last, now);
    facts.push(ago === 0 ? 'Stamped today' : ago === 1 ? 'Last visit yesterday' : `Last visit ${ago} days ago`);
  }
  if (!facts.length) return null;
  return el('ul', { class: 'milestones', 'aria-label': 'Milestones' }, ...facts.slice(0, 3).map((fact) => el('li', { class: 'milestone' }, fact)));
}

/** The card closest to its reward, as a link on Your cards: "2 stamps to go at Norema Cafe". */
export function nearlyThere(cards: CardState[]) {
  const close = cards
    .filter((state) => state.card.status === 'active')
    .map((state) => ({ state, left: state.card.requiredPunches - state.card.punches }))
    .filter(({ left }) => left > 0 && left <= 3)
    .sort((a, b) => a.left - b.left)[0];
  if (!close) return null;
  const { state, left } = close;
  return el(
    'a',
    { class: 'nearly', href: `/c?open=${encodeURIComponent(state.business.id)}`, style: pageStyle(state) },
    el('span', { class: 'nearly-dots', 'aria-hidden': 'true' },
      ...Array.from({ length: Math.min(state.card.requiredPunches, 10) }, (_, index) =>
        el('span', { class: index < state.card.punches ? 'is-on' : '' }))),
    el('span', { class: 'nearly-text' },
      el('strong', {}, left === 1 ? 'One stamp to go' : `${left} stamps to go`),
      ` at ${state.business.name}`),
  );
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

function dayHeading(date: Date) {
  const ago = daysAgo(date);
  return ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : day.format(date);
}

/** Every recent stamp across places, newest first, grouped by day. */
export function recentActivity(cards: CardState[], limit = 8) {
  const entries = cards
    .flatMap((state) => (state.recentVisits ?? []).map((iso) => ({ state, iso, date: visitDate(iso) })))
    .filter((entry): entry is { state: CardState; iso: string; date: Date } => Boolean(entry.date))
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit);
  if (!entries.length) return null;

  const now = new Date();
  const monthCount = cards
    .flatMap(datesOf)
    .filter((date) => date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()).length;

  const list = el('ol', { class: 'activity' });
  let heading = '';
  for (const { state, iso, date } of entries) {
    const label = dayHeading(date);
    if (label !== heading) {
      heading = label;
      list.append(el('li', { class: 'activity-day' }, label));
    }
    // A bare date has no time of day, so it shows none.
    const at = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? null : time.format(date);
    list.append(el(
      'li',
      { class: 'activity-item', style: pageStyle(state) },
      el('span', { class: 'activity-dot', 'aria-hidden': 'true' }),
      el('a', { class: 'activity-name', href: `/c?open=${encodeURIComponent(state.business.id)}` }, state.business.name),
      at ? el('span', { class: 'activity-time' }, at) : null,
    ));
  }
  return el(
    'section',
    { class: 'block panel', 'aria-labelledby': 'activity-title' },
    panelTitle('clock', 'Recent stamps', 'activity-title'),
    monthCount ? el('p', { class: 'panel-note' }, `${monthCount === 1 ? '1 stamp' : `${monthCount} stamps`} this month`) : null,
    list,
  );
}
