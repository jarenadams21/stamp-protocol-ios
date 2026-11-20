import type { CardState } from '../api';
import { businessHeader } from './business';
import { el, lowerFirst } from './dom';
import { panelTitle } from './icons';
import { pageStyle } from './passport';
import { milestones } from './progress';
import { rewardVessel } from './vessel';

// The details under a card, like the first design's card page: the restaurant itself,
// progress to the next reward, recent visits and the card's rules.

/**
 * Progress to the next reward, drawn as the reward itself filling up: "3 more visits to one
 * handcrafted drink" beside a cup that's 70% full.
 */
export function nextReward(state: CardState) {
  const { card, program, business } = state;
  const full = card.status === 'completed';
  const left = card.requiredPunches - card.punches;
  const reward = lowerFirst(program.rewardDescription);
  return el(
    'section',
    { class: `block panel next${full ? ' is-done' : ''}`, style: pageStyle(state), 'aria-label': 'Your progress' },
    el(
      'div',
      {
        class: 'next-art',
        role: 'progressbar',
        'aria-label': `Progress to ${program.rewardDescription}`,
        'aria-valuemin': 0,
        'aria-valuemax': card.requiredPunches,
        'aria-valuenow': full ? card.requiredPunches : card.punches,
      },
      rewardVessel(business.category, full ? 1 : card.punches / card.requiredPunches),
    ),
    el(
      'div',
      { class: 'next-text' },
      el('p', { class: 'next-count' }, full ? 'Card full' : left === 1 ? '1 more visit' : `${left} more visits`),
      el('p', { class: 'next-reward' }, full ? 'Your next visit starts a new page' : `to ${reward}`),
    ),
    milestones(state),
  );
}

/** The restaurant: cover, logo badge, type of place, address, today's hours and directions. */
export function placeSection(state: CardState) {
  return el(
    'section',
    { class: 'block panel place-block', style: pageStyle(state), 'aria-label': `About ${state.business.name}` },
    panelTitle('pin', 'About this place'),
    businessHeader(state.business, state.program.theme),
  );
}

/** The card's rules, in plain words. */
export function cardRules(state: CardState) {
  const { card, business } = state;
  return el(
    'section',
    { class: 'block panel', 'aria-labelledby': 'rules-title' },
    panelTitle('stamp', 'How this card works', 'rules-title'),
    // Three facts, each a big figure and a few words, instead of a paragraph of rules.
    el(
      'ul',
      { class: 'rule-chips' },
      ...([
        ['1', 'stamp each visit'],
        [String(card.requiredPunches), 'stamps fill the card'],
        ['No', 'expiry date on rewards'],
      ] as const).map(([figure, words]) =>
        el('li', { class: 'rule-chip' }, el('span', { class: 'rule-figure' }, figure), el('span', { class: 'rule-words' }, words))),
    ),
    el('p', { class: 'rules-issuer' }, `Rewards are set and honoured by ${business.name}.`),
  );
}

/** The rest of the wallet as tabs, so another card is one tap away without going back to the list. */
export function otherCards(others: CardState[]) {
  if (!others.length) return null;
  return el(
    'nav',
    { class: 'block panel other-cards', 'aria-labelledby': 'other-cards-title' },
    panelTitle('cards', 'Your other cards', 'other-cards-title'),
    el('div', { class: 'other-cards-list' }, ...others.map((other) =>
      el(
        'a',
        { class: 'peek', style: pageStyle(other), href: `/c?open=${encodeURIComponent(other.business.id)}` },
        el('span', { class: 'peek-name' }, other.business.name),
        el('span', { class: 'peek-count' },
          other.rewardsAvailable.length ? 'Reward ready' : other.card.punches === 1 ? '1 visit' : `${other.card.punches} visits`),
      ))),
  );
}
