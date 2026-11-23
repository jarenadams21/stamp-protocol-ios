import { ApiError, type Identity, type StampApi, type TapResult } from '../api';
import { header } from '../ui/components';
import { announce, el, prefersReducedMotion } from '../ui/dom';
import { stampMoment } from '../ui/stamp-moment';
import { clearMerchantTheme } from '../ui/theme';
import { cardPage, footer, messagePage, mount, plural, printTicket, skeletonPassport } from './shared';
import { staffScreen } from './staff';

// /t?picc=…&cmac=… is the URL the NTAG 424 DNA stand writes on every tap. The page posts
// both values to the server, which verifies them and finds (or creates) this diner from
// its HttpOnly cookie. The page never decides who the diner is.

/** The stamp waits for the card to arrive (enterPage) before it comes down: cause, then effect. */
const cardArrived = () => new Promise((done) => window.setTimeout(done, prefersReducedMotion() ? 0 : 420));

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function verifying() {
  clearMerchantTheme();
  mount(
    el(
      'main',
      { class: 'page page-verifying', 'aria-busy': 'true' },
      header(),
      el(
        'section',
        { class: 'hero' },
        el('h1', { class: 'headline' }, 'Adding your stamp…'),
        el('p', { class: 'subline' }, 'Keep this page open for a second.'),
      ),
      skeletonPassport(),
      footer(),
    ),
  );
}

export async function tapScreen(api: StampApi, query: URLSearchParams) {
  // Stands programmed for the app's verifier write picc_data; the page's own links write picc.
  const picc = query.get('picc') ?? query.get('picc_data') ?? '';
  const cmac = query.get('cmac') ?? '';
  verifying();

  let result: TapResult;
  try {
    result = picc && cmac ? await api.tap(picc, cmac) : { outcome: 'invalidTag' };
  } catch (error) {
    // The stand's link wasn't used up because the server never saw it, so retrying it is safe.
    messagePage({
      api,
      drawing: 'signal',
      secondary: { label: 'Open your cards', href: '/c' },
      headline: error instanceof ApiError && error.code === 'offline' ? 'No connection' : 'Something went wrong',
      message: 'Your stamp wasn’t added yet. Check your signal, then try again.',
      action: { label: 'Try again', onClick: () => void tapScreen(api, query) },
    });
    return;
  }

  // The signed link works once. Drop it from the address bar so a reload shows the card instead.
  if (result.outcome === 'redeemed') {
    history.replaceState(null, '', `/r/${encodeURIComponent(result.redemption.intentId)}`);
  } else if ('state' in result && result.state) {
    history.replaceState(null, '', `/c?open=${encodeURIComponent(result.state.business.id)}`);
  } else {
    history.replaceState(null, '', '/t');
  }

  switch (result.outcome) {
    case 'stamped': {
      const { state } = result;
      // The blow comes first, over everything; the card page builds underneath it.
      const moment = stampMoment(state, state.card.punches - 1);
      const left = state.card.requiredPunches - state.card.punches;
      const { passport } = cardPage(api, state, {
        identity: result.identity,
        verified: { at: new Date() },
        justStamped: true,
        firstTime: state.card.punches === 1 && (state.recentVisits?.length ?? 1) <= 1,
        headline: result.startedNewCard ? `New card at ${state.business.name}` : `Stamp ${state.card.punches} added at ${state.business.name}`,
        subline: result.startedNewCard
          ? `Stamp 1 of ${state.card.requiredPunches}. Your last reward is still waiting below.`
          : `${plural(left, 'more stamp', 'more stamps')} to your ${state.rewardsAvailable.length ? 'next ' : ''}reward.`,
      });
      await cardArrived();
      await moment?.land(passport.slot(state.card.punches - 1));
      await passport.stampIn(state.card.punches - 1, 'New', { arrived: Boolean(moment) });
      announce(`Stamp added. ${state.card.punches} of ${state.card.requiredPunches}.`);
      return;
    }
    case 'completed': {
      const { state } = result;
      const moment = stampMoment(state, state.card.punches - 1, { complete: true });
      const { passport, tickets } = cardPage(api, state, {
        identity: result.identity,
        verified: { at: new Date() },
        justStamped: true,
        headline: `Card complete at ${state.business.name}`,
        subline: `${result.reward.rewardDescription} is yours. Use it now or save it for another visit.`,
      });
      // Hold the new ticket back until the last stamp lands and the page celebrates, then print it.
      const fresh = tickets.at(-1);
      if (fresh) fresh.style.visibility = 'hidden';
      await cardArrived();
      await moment?.land(passport.slot(state.card.punches - 1));
      await passport.stampIn(state.card.punches - 1, 'New', { arrived: Boolean(moment) });
      const celebrating = passport.celebrate();
      window.setTimeout(() => printTicket(fresh), prefersReducedMotion() ? 0 : 360);
      await celebrating;
      announce(`Card complete. Reward ready: ${result.reward.rewardDescription}.`);
      return;
    }
    case 'cooldown': {
      const wait = Date.parse(result.nextStampAt) - Date.now();
      const last = result.state.recentVisits?.[0];
      cardPage(api, result.state, {
        identity: result.identity,
        verified: last ? { at: new Date(last), label: 'Last stamp' } : undefined,
        headline: 'Already stamped',
        subline: wait < 120_000
          ? 'This visit is already on your card. Tap again in a minute if you bought something new.'
          : `This visit is already on your card. Your next stamp opens at ${timeFormat.format(new Date(result.nextStampAt))}.`,
      });
      return;
    }
    case 'redeemed':
      staffScreen(result.state, result.redemption);
      return;
    case 'replayed':
      if (result.state) {
        const identity = await api.myCards().then((mine) => mine.identity).catch((): Identity => ({ kind: 'anonymous' }));
        cardPage(api, result.state, {
          identity,
          headline: 'This link was already used',
          subline: 'Each tap works once. Tap the stand again to collect a stamp.',
        });
      } else {
        messagePage({
          api,
          headline: 'This link was already used',
          message: 'Each tap works once. Tap the stand again to collect a stamp.',
          action: { label: 'Open your cards', href: '/c' },
        });
      }
      return;
    case 'invalidTag':
      messagePage({
        api,
        headline: 'Couldn’t read that stand',
        message: 'Hold the top of your phone flat on the stand for a second, then try again. No stamp was added.',
        action: { label: 'Open your cards', href: '/c' },
      });
      return;
    case 'tagNotActive':
      messagePage({
        api,
        headline: 'This stand isn’t set up yet',
        message: `No stamp was added. Let the staff${result.business ? ` at ${result.business.name}` : ''} know so they can finish setting it up.`,
        action: { label: 'Open your cards', href: '/c' },
      });
      return;
    case 'tagDisabled':
      messagePage({
        api,
        headline: 'This stand is no longer in use',
        message: 'No stamp was added. Ask the staff where to tap for your stamp.',
        action: { label: 'Open your cards', href: '/c' },
      });
      return;
    case 'standLinked':
      // The owner's phone, linking a stand from the business site: that page says "You're live" too.
      messagePage({
        api,
        drawing: 'stand',
        headline: 'Stand linked',
        message: `Diners who tap it now get a stamp${result.business ? ` at ${result.business.name}` : ''}.`,
        action: { label: 'Open your stands', href: '/business/stands' },
      });
      return;
  }
}
