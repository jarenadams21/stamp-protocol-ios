import type { CardState, PlaceSummary, StampApi } from '../api';
import { header } from '../ui/components';
import { spotCard } from '../ui/discover';
import { el, haptic } from '../ui/dom';
import { emptyState, skeletonCards } from '../ui/placeholders';
import { clearMerchantTheme } from '../ui/theme';
import { accountSlot, footer, loading, messagePage, mount, plural } from './shared';

// /discover: every place using JOEYY, the Discover tab. New places open their details; places
// the diner already has a card at show their progress and open the card. The search box looks
// places up by name through the shared backend's Places API (GET /v1/places?query=), so it finds
// every live place, not only the ones listed here; /discover?q=… opens with a search in it.

const SEARCH_DELAY_MS = 250; // Wait for a pause in typing before asking the server.

type Filter = 'all' | 'new' | 'mine';

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['new', 'New to you'],
  ['mine', 'Your cards'],
];

export async function discoverScreen(api: StampApi, initialQuery = '') {
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
  const listed = new Map(places.map((place) => [place.business.id, place]));
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

  // ---------- Search ----------
  const status = el('p', { class: 'search-status', role: 'status' });
  const filters = el('div', { class: 'filters', role: 'group', 'aria-label': 'Show' }, ...chips);
  const input = el('input', {
    class: 'field-input search-input',
    id: 'place-search',
    type: 'search',
    name: 'q',
    placeholder: 'Search by name',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    maxlength: 40,
    'aria-controls': 'discover-list',
    'aria-describedby': 'search-status',
  });
  status.id = 'search-status';
  let timer: number | undefined;
  let latest = 0; // Only the newest search may draw: answers can arrive out of order.

  const showQuery = (query: string) => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    history.replaceState(history.state, '', url);
  };

  async function search(query: string) {
    const ticket = ++latest;
    showQuery(query);
    if (!query) {
      filters.hidden = false;
      status.textContent = '';
      list.removeAttribute('aria-busy');
      draw();
      return;
    }
    filters.hidden = true;
    list.setAttribute('aria-busy', 'true');
    try {
      const found = await api.searchPlaces(query);
      if (ticket !== latest) return;
      // A place already in the Discover list has more to show (category, address, hours).
      const shown = found.map((place) => listed.get(place.business.id) ?? place);
      list.replaceChildren(...shown.map((place) => spotCard(place, mine.get(place.business.id))));
      status.textContent = found.length ? `${plural(found.length, 'place', 'places')} found` : '';
      if (!found.length) {
        list.replaceChildren(el('li', {}, emptyState({
          title: 'No places found',
          text: `Nothing matches “${query}”. Check the spelling, or try part of the name.`,
          action: { label: 'See all places', href: '/discover' },
        })));
      }
    } catch {
      if (ticket !== latest) return;
      status.textContent = 'Couldn’t search. Check your signal and try again.';
    } finally {
      if (ticket === latest) list.removeAttribute('aria-busy');
    }
  }

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    const query = input.value.trim();
    // Clearing the box brings the full list straight back; typing waits for a pause.
    if (!query) void search('');
    else timer = window.setTimeout(() => void search(query), SEARCH_DELAY_MS);
  });
  const form = el('form', { class: 'place-search', role: 'search', onsubmit: (event: Event) => {
    event.preventDefault();
    window.clearTimeout(timer);
    input.blur(); // Puts the keyboard away so the results show.
    void search(input.value.trim());
  } },
  el('label', { class: 'visually-hidden', for: 'place-search' }, 'Search places'),
  input);

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
      form,
      filters,
      status,
      list,
      footer(),
    ),
  );
  if (initialQuery) {
    input.value = initialQuery;
    void search(initialQuery.trim());
  }
}
