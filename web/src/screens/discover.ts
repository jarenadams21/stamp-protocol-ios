import type { CardState, PlaceSummary, StampApi } from '../api';
import { header } from '../ui/components';
import { spotCard } from '../ui/discover';
import { el, haptic } from '../ui/dom';
import { emptyState, skeletonCards } from '../ui/placeholders';
import { clearMerchantTheme } from '../ui/theme';
import { accountSlot, footer, loading, messagePage, mount, plural } from './shared';

// /discover: every place using JOEYY, the Discover tab. New places open their details; places
// the diner already has a card at show their progress and open the card.

type Filter = 'all' | 'new' | 'mine';

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['new', 'New to you'],
  ['mine', 'Your cards'],
];

export async function discoverScreen(api: StampApi) {
  clearMerchantTheme();
  let places: PlaceSummary[];
  let cards: CardState[];
  try {
    [places, { cards }] = await loading(Promise.all([api.places(), api.myCards()]), 'Loading places…', skeletonCards(2));
  } catch {
    messagePage({
      drawing: 'signal',
      headline: 'No connection',
      message: 'Check your signal and try again.',
      action: { label: 'Try again', onClick: () => void discoverScreen(api) },
    });
    return;
  }

  const mine = new Map(cards.map((state) => [state.business.id, state]));
  const newCount = places.filter((place) => !mine.has(place.business.id)).length;
  const list = el('ul', { class: 'discover-list', id: 'discover-list' });
  let filter: Filter = 'all';

  const draw = () => {
    const shown = places.filter((place) =>
      filter === 'all' || (filter === 'mine') === mine.has(place.business.id));
    list.replaceChildren(...shown.map((place) => spotCard(place, mine.get(place.business.id))));
    if (!shown.length) {
      list.replaceChildren(el('li', {}, emptyState(filter === 'mine'
        ? { title: 'No cards yet', text: 'Tap the JOEYY stand at any of these places to start one.', action: { label: 'See all places', href: '/discover' } }
        : { title: 'You’ve been everywhere', text: 'You have a card at every place using JOEYY so far.', action: { label: 'Open your cards', href: '/c' } })));
    }
  };

  const chips = FILTERS.map(([value, label]) =>
    el('button', {
      class: 'filter-chip',
      type: 'button',
      'aria-pressed': value === filter ? 'true' : 'false',
      'aria-controls': 'discover-list',
      onclick: () => {
        if (filter === value) return;
        haptic(6);
        filter = value;
        chips.forEach((chip, index) => chip.setAttribute('aria-pressed', FILTERS[index][0] === value ? 'true' : 'false'));
        draw();
      },
    }, label));
  draw();

  mount(
    el(
      'main',
      { class: 'page page-discover' },
      header({ account: accountSlot(api) }),
      el('section', { class: 'hero' },
        el('h1', { class: 'headline' }, 'Places with JOEYY'),
        el('p', { class: 'subline' }, newCount
          ? `${plural(newCount, 'place', 'places')} you haven’t tried yet. Your first tap at the stand starts a card.`
          : 'You have a card at every place so far.')),
      el('div', { class: 'filters', role: 'group', 'aria-label': 'Show' }, ...chips),
      list,
      footer(),
    ),
  );
}
