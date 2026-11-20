import type { CardState, Identity, Reward, SignInResult, StampApi } from '../api';
import { cardRules, nextReward, otherCards, placeSection } from '../ui/details';
import { pageStyle, passportPage, type PassportView } from '../ui/passport';
import { drawing, type Drawing } from '../ui/placeholders';
import { accountChip, accountName, cardActions, header, rewardTicket, signInBanner, type SignedIn } from '../ui/components';
import { panelTitle } from '../ui/icons';
import { el, prefersReducedMotion } from '../ui/dom';
import { howItWorks, logoMark, verifiedSeal, visitHistory } from '../ui/sections';
import { enterPage, reinkStamps, revealOnScroll, attachTilt, sheen } from '../ui/motion';
import { applyMerchantTheme } from '../ui/theme';
import { syncTabBar } from '../ui/tabbar';
import { token } from '../ui/spring';
import { pageMounted } from '../ui/page-transition';
import { startRedeem } from './redeem';

export function mount(...nodes: (Node | null)[]) {
  const app = document.getElementById('app')!;
  app.replaceChildren(...nodes.filter((node): node is Node => node !== null));
  pageMounted();
  // Move focus to the page heading so screen readers start at the news, not the logo.
  const heading = app.querySelector<HTMLElement>('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  syncTabBar(app.firstElementChild);
  // Moving between pages, the whole page slides in (page-transition.ts); the entrance wave is
  // for a page's first load, so the two never play at once.
  if (!document.documentElement.dataset.nav) enterPage(app);
  requestAnimationFrame(() => revealOnScroll(app));
}

/** The page's shape while it loads: a breathing headline and a blank passport page. */
export function skeletonPassport() {
  const slots = Array.from({ length: 10 }, () => el('span', { class: 'ink-slot' }, el('span', { class: 'ink-empty' })));
  return el(
    'div',
    { class: 'passport is-skeleton', 'aria-hidden': 'true' },
    el('div', { class: 'passport-head' }, el('span', { class: 'passport-mark' }), el('span', { class: 'skeleton-line is-short' })),
    el('div', { class: 'ink-grid' }, ...slots),
    el('span', { class: 'skeleton-line is-short' }),
  );
}

/**
 * Runs `work`, and if it takes longer than a blink, shows the page's shape meanwhile (so a fast
 * answer never flashes a skeleton): `skeleton` when the caller has one (card stacks), or a
 * passport page. Screen readers hear `label`.
 */
export async function loading<T>(work: Promise<T>, label: string, skeleton?: Node): Promise<T> {
  const timer = window.setTimeout(() => {
    mount(
      el(
        'main',
        { class: 'page page-loading', 'aria-busy': 'true' },
        header(),
        el('h1', { class: 'visually-hidden' }, label),
        ...(skeleton
          ? [skeleton]
          : [el('section', { class: 'hero', 'aria-hidden': 'true' }, el('span', { class: 'skeleton-line is-title' }), el('span', { class: 'skeleton-line is-short' })), skeletonPassport()]),
      ),
    );
  }, 150);
  try {
    return await work;
  } finally {
    window.clearTimeout(timer);
  }
}

interface CardPageOptions {
  headline: string;
  subline?: string;
  identity: Identity;
  /** When this page came from a verified tap: shows the seal with the tap's time. */
  verified?: { at: Date; label?: string };
  /** Open "How JOEYY works" for someone on their first stamp. */
  firstTime?: boolean;
  /** The tap just landed here: badge and outline the page, and stamp in the newest visit. */
  justStamped?: boolean;
  /** Just signed in: the stamp from this phone moved onto the account's card. */
  welcome?: SignInResult;
  /** Just signed in from the link on the Wallet pass. */
  fromPass?: boolean;
}

interface CardPageView {
  passport: PassportView;
  /** The reward tickets, so a just-completed card can "print" its new one. */
  tickets: HTMLElement[];
}

/**
 * Everything under a card, in order: progress, rewards, Wallet, the place, visits, the card's
 * rules and how JOEYY works. The tap page and a card opened in Your cards both use this, so a
 * card looks the same wherever you open it.
 */
export function cardSections(
  api: StampApi,
  state: CardState,
  options: { identity: Identity; onSignedIn: SignedIn; firstTime?: boolean },
) {
  const rewards = state.rewardsAvailable;
  const tickets = rewards.map((reward: Reward) => rewardTicket(reward, () => startRedeem(api, state, reward)));
  const sections = [
    nextReward(state),
    rewards.length
      ? el(
          'section',
          { class: 'block panel rewards', 'aria-labelledby': 'rewards-title', style: pageStyle(state) },
          panelTitle('gift', rewards.length === 1 ? 'Your reward' : `Your rewards (${rewards.length})`, 'rewards-title'),
          ...tickets,
        )
      : null,
    el(
      'section',
      { class: 'block panel save', 'aria-labelledby': 'save-title' },
      panelTitle('bookmark', 'Keep this card', 'save-title'),
      cardActions(api, state, options.identity, options.onSignedIn),
    ),
    placeSection(state),
    visitHistory(state),
    cardRules(state),
    el('section', { class: 'block' }, howItWorks(Boolean(options.firstTime))),
  ];
  return { sections, tickets };
}

export function cardPage(api: StampApi, state: CardState, options: CardPageOptions): CardPageView {
  applyMerchantTheme(state.program.theme);
  const newest = state.card.punches - 1;
  const moved = options.welcome?.moved.find((entry) => entry.businessId === state.business.id);
  const animateIn = options.justStamped || Boolean(moved);
  const passport = passportPage(state, {
    justStamped: animateIn,
    shown: animateIn ? newest : state.card.punches,
  });

  // The same frame as a card opened in Your cards: All cards above it, the rest of the wallet below.
  const others = el('div', { class: 'other-cards-slot' });
  void api.myCards().then(({ cards }) => {
    const rest = otherCards(cards.filter((other) => other.business.id !== state.business.id));
    if (rest) others.replaceChildren(rest);
  }).catch(() => undefined);

  // Signing in from this page: show the merge if anything moved or came back, else just refresh.
  const onSignedIn = (result: SignInResult) => {
    if (result.moved.length || result.restoredCards) void welcomeBack(api, state.business.id, result);
    else void refreshCard(api, state.business.id);
  };
  const anonymous = options.identity.kind === 'anonymous';
  const body = cardSections(api, state, { identity: options.identity, onSignedIn, firstTime: options.firstTime });

  const restored = options.welcome && (options.welcome.restoredCards || options.welcome.restoredRewards)
    ? el(
        'div',
        { class: 'restored-row' },
        el('p', {}, restoredText(options.welcome)),
        el('a', { href: '/c' }, 'See all cards'),
      )
    : null;

  const page = el(
    'main',
    { class: 'page page-card' },
    header({ account: accountChip(options.identity) }),
    el(
      'section',
      { class: 'hero', 'aria-labelledby': 'headline' },
      options.welcome
        ? el('p', { class: 'seal-chip' }, 'Signed in. Your cards are back.')
        : options.fromPass
          ? el('p', { class: 'seal-chip' }, 'Opened from your Wallet')
          : options.verified ? verifiedSeal(options.verified.at, options.verified.label) : null,
      el('h1', { class: 'headline', id: 'headline' }, options.headline),
      options.subline ? el('p', { class: 'subline' }, options.subline) : null,
    ),
    el('section', { class: 'wallet-stack has-glow', 'aria-label': 'Your card', style: pageStyle(state) },
      el('a', { class: 'wallet-back', href: '/c' }, 'All cards'),
      passport.root),
    // Under the card, not above it: the stamp stays the first thing you see.
    anonymous && options.justStamped ? signInBanner(api, onSignedIn) : null,
    restored,
    ...body.sections,
    others,
    footer(),
  );
  mount(page);
  passport.root.classList.add('is-tiltable');
  attachTilt(passport.root);
  // A page arriving from a tap gets its stamp pressed in; a page you're just viewing re-inks.
  if (moved) {
    // After the card arrives (enterPage), the moved stamp comes down onto it.
    window.setTimeout(() => void passport.stampIn(newest, 'Moved'), prefersReducedMotion() ? 0 : 420);
    sheen(passport.root, 520);
  } else if (options.justStamped) sheen(passport.root, 520);
  else {
    reinkStamps(passport.root, 200);
    sheen(passport.root, 300);
  }
  return { passport, tickets: body.tickets };
}

function restoredText(result: SignInResult) {
  const cards = plural(result.restoredCards, 'card', 'cards');
  const rewards = plural(result.restoredRewards, 'reward', 'rewards');
  if (result.restoredCards && result.restoredRewards) return `${cards} and ${rewards} restored from your account`;
  return `${result.restoredCards ? cards : rewards} restored from your account`;
}

async function refreshCard(api: StampApi, businessId: string) {
  const [state, mine] = await Promise.all([api.card(businessId), api.myCards()]);
  cardPage(api, state, {
    identity: mine.identity,
    headline: `${state.card.punches} of ${state.card.requiredPunches} visits at ${state.business.name}`,
    subline: `Saved to ${accountName(mine.identity, 'long')}.`,
  });
}

/** "Welcome back": the account's card, with today's stamp moved onto it. */
export async function welcomeBack(api: StampApi, businessId: string, result: SignInResult) {
  const state = await api.card(businessId);
  history.replaceState(null, '', `/c?open=${encodeURIComponent(businessId)}`);
  const moved = result.moved.find((entry) => entry.businessId === businessId);
  cardPage(api, state, {
    identity: result.identity,
    welcome: result,
    headline: moved
      ? (state.card.status === 'completed'
          ? `Welcome back. Your card at ${state.business.name} is full`
          : `Welcome back. Stamp ${state.card.punches} added at ${state.business.name}`)
      : 'Welcome back',
    subline: moved
      ? 'Today’s stamp from this phone moved onto your card.'
      : 'Your cards from your account are here.',
  });
}

/** The new reward ticket slides out from under the card like a printed receipt. */
export function printTicket(ticket: HTMLElement | undefined) {
  if (!ticket) return;
  ticket.style.visibility = '';
  if (prefersReducedMotion()) return;
  ticket.animate(
    [
      { clipPath: 'inset(0 0 100% 0)', transform: 'translateY(-28px)' },
      { clipPath: 'inset(0 0 0 0)', transform: 'translateY(0)' },
    ],
    { duration: 640, easing: token('--spring-lift') },
  );
}

export function footer() {
  return el(
    'footer',
    { class: 'footer' },
    el('p', { class: 'footer-brand', translate: 'no' }, logoMark(20), 'Joeyy passport'),
    el('p', {}, 'Stamp cards for the places you love. Every stamp is verified at the counter, and restaurants see your visits, never your name or number.'),
    el('nav', { class: 'footer-links', 'aria-label': 'Legal' },
      el('a', { href: '/privacy' }, 'Privacy'),
      el('a', { href: '/terms' }, 'Terms')),
  );
}

/** The header's account chip for a page that hasn't loaded the diner's cards: filled in when they arrive. */
export function accountSlot(api: StampApi) {
  const slot = el('span', { class: 'chip-slot' });
  api.myCards().then(({ identity }) => slot.replaceChildren(accountChip(identity))).catch(() => undefined);
  return slot;
}

/**
 * A page with news instead of a card: a problem with a tap or a link, no connection, the legal
 * pages. The same panel as an empty state (a drawing, the headline, a line of text) and always a
 * way on, so no message is a dead end. With `api`, the header shows who's signed in, as elsewhere.
 */
export function messagePage(options: {
  headline: string;
  message: string;
  action: { label: string; onClick: () => void } | { label: string; href: string };
  secondary?: { label: string; href: string };
  drawing?: Drawing;
  api?: StampApi;
}) {
  const action = 'href' in options.action
    ? el('a', { class: 'button button-primary', href: options.action.href }, options.action.label)
    : el('button', { class: 'button button-primary', type: 'button', onclick: options.action.onClick }, options.action.label);
  mount(
    el(
      'main',
      { class: 'page page-message' },
      header({ account: options.api ? accountSlot(options.api) : null }),
      el(
        'section',
        { class: 'empty message' },
        drawing(options.drawing),
        el('h1', { class: 'empty-title' }, options.headline),
        el('p', { class: 'empty-text' }, options.message),
        action,
        options.secondary ? el('a', { class: 'link-button', href: options.secondary.href }, options.secondary.label) : null,
      ),
      footer(),
    ),
  );
}

export function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}
