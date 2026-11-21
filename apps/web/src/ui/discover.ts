import type { CardState, PlaceSummary } from '../api';
import { businessMark, coverArt, directionsUrl, hoursLine } from './business';
import { openSheet } from './components';
import { el, haptic, lowerFirst } from './dom';
import { fontFor } from './theme';

// Places using JOEYY: spot cards for the Discover tab (src/screens/discover.ts), like the
// Discoverable gallery in the iOS app's Search tab.

function themeVars(place: PlaceSummary) {
  const { theme } = place.program;
  return `--m-light-paper:${theme.lightPaper};--m-light-ink:${theme.lightInk};--m-dark-paper:${theme.darkPaper};--m-dark-ink:${theme.darkInk};--m-font:${fontFor(theme.typeface)}`;
}

export function placeSheet(place: PlaceSummary) {
  const { business, program } = place;
  const hours = hoursLine(business);
  openSheet(
    (close) =>
      el(
        'div',
        { class: 'sheet-body place-sheet', style: themeVars(place) },
        el('div', { class: 'place-cover', 'data-stock': program.theme.artwork }, coverArt(program.theme.artwork, business.id), businessMark(business, program.theme, 'biz-mark')),
        el('h2', { class: 'sheet-title' }, business.name),
        el('p', { class: 'sheet-text' }, [business.category, business.location].filter(Boolean).join(' in ')),
        el(
          'dl',
          { class: 'place-facts' },
          el('div', {}, el('dt', {}, 'Reward'), el('dd', {}, `${program.rewardDescription} after ${program.requiredPunches} stamps`)),
          hours ? el('div', {}, el('dt', {}, 'Today'), el('dd', {}, hours.text)) : null,
          business.address ? el('div', {}, el('dt', {}, 'Address'), el('dd', {}, business.address)) : null,
        ),
        el('p', { class: 'sheet-text' }, 'Your card starts with your first tap on their JOEYY stand.'),
        el('a', { class: 'button button-primary', href: directionsUrl(business), target: '_blank', rel: 'noopener' }, 'Get directions'),
        el('button', { class: 'button button-quiet', type: 'button', onclick: close }, 'Close'),
      ),
    business.name,
  );
}

/**
 * One place as a card: its cover, logo, where it is and its reward. A place the diner already has
 * a card at shows their progress and opens that card; a new one opens its details.
 */
export function spotCard(place: PlaceSummary, mine?: CardState) {
  const { business, program } = place;
  const body = [
    el('span', { class: 'spot-cover', 'data-stock': program.theme.artwork }, coverArt(program.theme.artwork, business.id), businessMark(business, program.theme, 'spot-mark')),
    el('span', { class: 'spot-name' }, business.name),
    el('span', { class: 'spot-meta' }, business.location),
    el('span', { class: 'spot-reward' }, mine
      ? (mine.rewardsAvailable.length ? 'Reward ready' : `${mine.card.punches} of ${mine.card.requiredPunches} stamps`)
      : `${program.requiredPunches} stamps for ${lowerFirst(program.rewardDescription)}`),
  ];
  return el(
    'li',
    { class: `spot${mine ? ' is-mine' : ''}`, style: themeVars(place) },
    mine
      ? el('a', { class: 'spot-button', href: `/c?open=${encodeURIComponent(business.id)}` }, ...body)
      : el('button', { class: 'spot-button', type: 'button', onclick: () => { haptic(8); placeSheet(place); } }, ...body),
  );
}
