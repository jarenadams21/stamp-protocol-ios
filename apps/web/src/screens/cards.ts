import { ApiError, type StampApi } from '../api';
import { accountChip, header, identityNote, notice, rewardTicket, signInBanner, toast } from '../ui/components';
import { otherCards } from '../ui/details';
import { pageStyle, passportStack } from '../ui/passport';
import { startRedeem } from './redeem';
import { el } from '../ui/dom';
import { fold } from '../ui/motion';
import { emptyState, skeletonCards } from '../ui/placeholders';
import { nearlyThere } from '../ui/progress';
import { howItWorks } from '../ui/sections';
import { clearMerchantTheme } from '../ui/theme';
import { navigate } from '../router';
import { cardPage, cardSections, footer, loading, messagePage, mount, plural, welcomeBack } from './shared';

/** No cards yet: a blank page where the first stamp will land. */
function offline(retry: () => void) {
  messagePage({
    drawing: 'signal',
    headline: 'No connection',
    message: 'Your cards are safe. Check your signal and try again.',
    action: { label: 'Try again', onClick: retry },
  });
}

export async function cardsScreen(api: StampApi, open?: string) {
  clearMerchantTheme();
  let data;
  try {
    data = await loading(api.myCards(), 'Loading your cards…', skeletonCards(3));
  } catch {
    offline(() => void cardsScreen(api, open));
    return;
  }

  if (!data.cards.length) {
    mount(
      el(
        'main',
        { class: 'page page-empty' },
        header({ account: accountChip(data.identity) }),
        el('section', { class: 'hero' }, el('h1', { class: 'headline' }, 'Your cards')),
        emptyState({
          title: 'No cards yet',
          text: 'Tap your phone on a JOEYY stand at the counter to start your first card. No app or sign-up needed.',
          action: { label: 'Find a place', href: '/discover' },
        }),
        el('section', { class: 'block' }, signInBanner(api, () => void cardsScreen(api), 'Cards on another phone?')),
        el('section', { class: 'block' }, howItWorks(true)),
        footer(),
      ),
    );
    return;
  }

  const visits = data.cards.reduce((sum, state) => sum + (state.recentVisits?.length ?? state.card.punches), 0);
  const ready = data.cards.flatMap((state) => state.rewardsAvailable.map((reward) => ({ state, reward })));
  const summary = [
    plural(data.cards.length, 'place', 'places'),
    plural(visits, 'visit', 'visits'),
    ready.length ? plural(ready.length, 'reward ready', 'rewards ready') : null,
  ].filter(Boolean).join(', ');

  const identitySlot = el('div', {}, identityNote(api, data.identity, () => void cardsScreen(api, open)));

  // Rewards waiting come first: they're the reason most people open this page.
  const tickets = ready.map(({ state, reward }) => {
    const ticket = rewardTicket(reward, () => startRedeem(api, state, reward), `Ready at ${state.business.name}`);
    ticket.setAttribute('style', pageStyle(state));
    return ticket;
  });

  // A nudge toward the card closest to its reward; it folds away with the strip when a card opens.
  const nearly = nearlyThere(data.cards);
  const rewardStrip = tickets.length ? el('section', { class: 'rewards list-rewards', 'aria-label': 'Rewards ready' }, ...tickets) : null;

  mount(
    el(
      'main',
      { class: 'page page-list' },
      header({ account: accountChip(data.identity) }),
      el('section', { class: 'hero' },
        el('h1', { class: 'headline' }, 'Your cards'),
        el('p', { class: 'subline' }, summary)),
      nearly,
      rewardStrip,
      el('section', { class: 'wallet-stack', 'aria-label': 'Your passport pages' },
        passportStack(data.cards, {
          open,
          // An open card shows its own rewards, so the strip folds away while it's open (sliding
          // the stack up with it rather than jumping).
          onOpenChange: (isOpen, instant) => {
            if (rewardStrip) fold(rewardStrip, isOpen, instant);
            if (nearly) fold(nearly, isOpen, instant);
          },
          // The same sections as the card's own page, then the rest of the wallet.
          details: (state) => el('div', { class: 'card-details' },
            ...cardSections(api, state, { identity: data.identity, onSignedIn: () => void cardsScreen(api, state.business.id) }).sections,
            otherCards(data.cards.filter((other) => other.business.id !== state.business.id))),
          onReorder: (businessIds) => void api.reorderCards(businessIds).catch(() => toast('Couldn’t save the new order. Try again.')),
        })),
      el('section', { class: 'save' }, identitySlot),
      footer(),
    ),
  );
}

export function legalScreen(api: StampApi, kind: 'privacy' | 'terms') {
  clearMerchantTheme();
  messagePage({
    api,
    drawing: 'page',
    headline: kind === 'privacy' ? 'Privacy' : 'Terms',
    message: kind === 'privacy'
      ? 'The full policy comes before launch. JOEYY keeps a random ID for your stamps, plus your number or Apple or Google email if you sign in. Restaurants see visits, never your name, email or number.'
      : 'The full terms come before launch. Each restaurant sets and honours its own rewards.',
    action: { label: 'Open your cards', href: '/c' },
  });
}

/** /w/:token, the "Open my JOEYY card" link on the back of a Wallet pass. */
export async function walletRestoreScreen(api: StampApi, token: string) {
  // "Use my reward" on the pass is this same link with ?use=reward.
  const useReward = new URLSearchParams(window.location.search).get('use') === 'reward';
  try {
    const result = await loading(api.restoreFromPass(token), 'Opening your card…');
    const businessId = result.businessId;
    if (!businessId) {
      navigate('/c', { replace: true });
      return;
    }
    const state = await api.card(businessId);
    history.replaceState(null, '', `/c?open=${encodeURIComponent(businessId)}`);
    const reward = useReward ? state.rewardsAvailable[0] : undefined;
    cardPage(api, state, {
      identity: result.identity,
      fromPass: true,
      headline: reward ? 'Use your reward' : `Your ${state.business.name} card is back`,
      subline: reward
        ? `${reward.rewardDescription} at ${state.business.name}. Start when you’re at the counter.`
        : 'This browser is signed in now. Your next tap at the stand lands right here.',
    });
    if (reward) startRedeem(api, state, reward);
    else if (useReward) {
      notice('This reward has been used', 'Your card below is up to date. Update your Wallet card to clear the reward from it.', 'See my card');
    }
  } catch (error) {
    const offline = error instanceof ApiError && error.code === 'offline';
    messagePage({
      api,
      drawing: offline ? 'signal' : 'stand',
      headline: offline ? 'No connection' : 'This link no longer works',
      message: offline
        ? 'Check your signal, then try the link again.'
        : 'Your card is safe. Tap the JOEYY stand at the counter to open it, or sign in from Your cards.',
      action: offline
        ? { label: 'Try again', onClick: () => void walletRestoreScreen(api, token) }
        : { label: 'Open your cards', href: '/c' },
    });
  }
}

/**
 * /signed-in?next=/c/norema: where the backend sends the diner back after Apple or Google
 * (docs/identity-and-api.md). Shows what came over, like any other sign-in. `error` is set when
 * the diner cancelled or the provider refused.
 */
export async function signedInScreen(api: StampApi, query: URLSearchParams) {
  const asked = query.get('next') ?? '';
  // Only a card page: never a redirect to anywhere the query names.
  const next = /^\/c(\/[\w-]+)?$/.test(asked) ? asked : '/c';
  const error = query.get('error');
  if (error) {
    navigate(next, { replace: true });
    if (error !== 'cancelled') notice('Couldn’t sign you in', 'Try again, or use your mobile number.');
    return;
  }
  let result;
  try {
    result = await api.providerSignInResult();
  } catch {
    navigate(next, { replace: true });
    return;
  }
  const businessId = /^\/c\/([\w-]+)$/.exec(next)?.[1];
  if (businessId && (result.moved.length || result.restoredCards)) {
    await welcomeBack(api, businessId, result);
    return;
  }
  navigate(next, { replace: true });
  toast('Signed in. Your cards are saved.');
}
