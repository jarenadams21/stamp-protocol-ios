import type { CardState, StampApi } from '../api';
import { accountChip, header, signInBanner } from '../ui/components';
import { el } from '../ui/dom';
import { icon, panelTitle } from '../ui/icons';
import { passportPage } from '../ui/passport';
import { howItWorks } from '../ui/sections';
import { clearMerchantTheme } from '../ui/theme';
import { navigate } from '../router';
import { footer, loading, mount } from './shared';

// `/` for someone with no cards yet: not at a counter, maybe never heard of JOEYY. One thing
// moves, and only when they ask: "Try a tap" stamps a sample card with the same press a real tap
// gets. Then the two ways on: find a place, or sign in to cards from another phone.

/** A sample card in the passport paper. It never touches the server and says it's a sample. */
function sampleCard(): CardState {
  const paper = { lightPaper: 'var(--m-light-paper)', lightInk: 'var(--m-light-ink)', darkPaper: 'var(--m-dark-paper)', darkInk: 'var(--m-dark-ink)' };
  return {
    business: { id: 'sample', name: 'Your first card', location: 'Any place with a JOEYY stand' },
    program: {
      versionId: 'sample',
      version: 1,
      requiredPunches: 8,
      rewardDescription: 'A treat on the house',
      theme: { ...paper, typeface: 'serif', artwork: 'rail', allowsMotion: true },
    },
    card: { cardId: 'sample', punches: 1, requiredPunches: 8, status: 'active' },
    rewardsAvailable: [],
    recentVisits: [new Date().toISOString()],
  };
}

/** The sample card and its one button. Each press starts from a blank page, so it can't stack up. */
function tryATap() {
  const slot = el('div', { class: 'wallet-stack has-glow try-card' });
  const note = el('p', { class: 'try-note', 'aria-live': 'polite' }, 'A sample card. Real stamps come from the stand at the counter.');
  const button = el('button', { class: 'button button-secondary try-button', type: 'button' }, icon('stamp', 20), 'Try a tap');
  let page = passportPage(sampleCard(), { shown: 0 });
  slot.append(page.root);

  button.addEventListener('click', () => {
    if (button.dataset.done) {
      // Again: swap in a fresh blank page (instantly), then stamp it.
      const fresh = passportPage(sampleCard(), { shown: 0 });
      page.root.replaceWith(fresh.root);
      page = fresh;
    }
    button.dataset.done = 'true';
    button.lastChild!.textContent = 'Tap again';
    void page.stampIn(0, 'Sample').then(() => {
      note.textContent = 'That’s it. At a real stand, your card opens and the stamp lands on it, just like that.';
    });
  });

  return el('section', { class: 'try', 'aria-label': 'Try a sample tap' }, slot, el('div', { class: 'try-row' }, button, note));
}

/** For someone standing at a counter right now, who scrolled here instead of tapping. */
function atAStand() {
  return el(
    'section',
    { class: 'block panel', 'aria-labelledby': 'stand-title' },
    panelTitle('pin', 'At a JOEYY stand now?', 'stand-title'),
    el('p', { class: 'panel-note' }, 'Hold the top of your phone against the stand after you pay. Your card opens right here, with your first stamp on it.'),
  );
}

export async function homeScreen(api: StampApi) {
  let identity;
  try {
    const mine = await loading(api.myCards(), 'Loading…');
    if (mine.cards.length) {
      navigate('/c', { replace: true });
      return;
    }
    identity = mine.identity;
  } catch {
    /* Offline: the introduction still makes sense. */
  }
  clearMerchantTheme();
  mount(
    el(
      'main',
      { class: 'page page-home' },
      header({ account: identity ? accountChip(identity) : null }),
      el(
        'section',
        { class: 'hero' },
        el('h1', { class: 'headline' }, 'Tap a stand. Get a stamp.'),
        el('p', { class: 'subline' }, 'Stamp cards for the places you love, kept on your phone. No app, no account, no paper card to lose.'),
      ),
      tryATap(),
      el('a', { class: 'button button-primary home-find', href: '/discover' }, 'Find a place near you'),
      // Someone with cards on another phone (or who just signed out) needs a way back in from here.
      el('section', { class: 'block' }, signInBanner(api, () => navigate('/c'), 'Already have cards?')),
      el('section', { class: 'block' }, howItWorks(true)),
      atAStand(),
      footer(),
    ),
  );
}
