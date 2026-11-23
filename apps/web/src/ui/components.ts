import { ApiError, type CardState, type Identity, type Reward, type SignInProvider, type SignInResult, type StampApi, type WalletPlatform } from '../api';
import { isDemo } from '../api';
import { announce, busy, el, haptic, lowerFirst, prefersReducedMotion, svg } from './dom';
import { project, rubberband, SMOOTH, Spring, THROWN, VelocityTracker } from './spring';
import { logoMark } from './sections';
import { pageStyle } from './passport';

// ---------- Sheets ----------

/**
 * A bottom sheet built on <dialog>: native focus trapping, Escape to close, inert page behind.
 * It rises on a spring and you can drag it down to put it away: it follows your finger 1:1, a
 * flick or a pull past halfway sends it off at your finger's speed, and anything less springs it
 * back. You can catch it again while it's moving.
 */
export function openSheet(build: (close: () => void) => Node, label: string, onClose?: () => void) {
  const dialog = el('dialog', { class: 'sheet', 'aria-label': label });
  const reduce = prefersReducedMotion();
  let closing = false;
  const height = () => dialog.offsetHeight || window.innerHeight;
  // One value drives both the sheet and the dimming behind it, so they never drift apart.
  const offset = new Spring(0, (y) => {
    const progress = Math.max(0, Math.min(1, 1 - y / height()));
    if (reduce) {
      dialog.style.opacity = String(progress);
    } else {
      dialog.style.transform = `translate3d(0, ${y}px, 0)`;
    }
    dialog.style.setProperty('--sheet-progress', progress.toFixed(3));
  });

  const finishClose = () => {
    dialog.close();
    dialog.remove();
    onClose?.();
  };
  const dismiss = (velocity = 0) => {
    closing = true;
    // Leaves the way it came in: straight down. With Reduce Motion it fades instead.
    void offset.to(height() + 24, reduce ? { response: 0.24, damping: 1 } : SMOOTH, velocity).then((settled) => {
      if (settled && closing) finishClose();
    });
  };
  const close = () => {
    if (!dialog.open || closing) return;
    dismiss();
  };

  dialog.append(el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), build(close));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && !dragged) close();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });

  // Drag down to dismiss. Presses on buttons and fields stay presses; a sheet scrolled down
  // scrolls first and only drags once it's back at the top.
  const tracker = new VelocityTracker();
  const capture = (event: PointerEvent) => {
    try {
      dialog.setPointerCapture(event.pointerId);
    } catch {
      /* The pointer already ended. */
    }
  };
  let pointer: number | undefined;
  let startX = 0;
  let startY = 0;
  let base = 0;
  let dragging = false;
  let dragged = false;
  dialog.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer !== undefined) return;
    const interactive = (event.target as Element).closest('button, a, input, select, textarea, label');
    if (interactive && event.target !== dialog) return;
    pointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dragging = false;
    dragged = false;
    tracker.reset();
    tracker.add(event);
    // Caught mid-flight: stop right where it is, and take it from there.
    if (offset.value !== 0 || closing) {
      closing = false;
      offset.stop();
      base = offset.value;
      dragging = true;
      capture(event);
    } else {
      base = 0;
    }
  });
  dialog.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointer) return;
    tracker.add(event);
    const dy = event.clientY - startY;
    if (!dragging) {
      // Wait for a clear downward pull (10px) before taking over from scrolling.
      if (Math.abs(dy) < 10 && Math.abs(event.clientX - startX) < 10) return;
      if (dy <= 0 || Math.abs(dy) < Math.abs(event.clientX - startX) || dialog.scrollTop > 0) {
        pointer = undefined;
        return;
      }
      dragging = true;
      startY = event.clientY;
      capture(event);
    }
    dragged = true;
    const y = base + (event.clientY - startY);
    // Pulled up past the top, it resists instead of stopping dead.
    offset.set(y < 0 ? rubberband(y, height()) : y);
  });
  const release = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    pointer = undefined;
    if (!dragging) return;
    dragging = false;
    const velocity = tracker.velocity().y;
    // Decide from where the throw would land, not where the finger let go.
    const landing = offset.value + project(velocity);
    if (landing > height() * 0.5 || velocity > 700) dismiss(velocity);
    else void offset.to(0, THROWN, velocity);
    window.setTimeout(() => (dragged = false), 0);
  };
  dialog.addEventListener('pointerup', release);
  dialog.addEventListener('pointercancel', release);
  // While dragging, the page under the sheet must not scroll or bounce.
  dialog.addEventListener('touchmove', (event) => {
    if (dragging) event.preventDefault();
  }, { passive: false });

  document.body.append(dialog);
  dialog.showModal();
  if (reduce) dialog.style.transform = 'none';
  const fits = () => dialog.classList.toggle('is-fixed', dialog.scrollHeight <= dialog.clientHeight + 1);
  new ResizeObserver(fits).observe(dialog.firstElementChild!.nextElementSibling ?? dialog);
  fits();
  offset.set(height());
  void offset.to(0, reduce ? { response: 0.24, damping: 1 } : SMOOTH);
  return close;
}

/** A short sheet with news and one button that closes it. The button says so ("Close") unless a caller has better words. */
export function notice(title: string, message: string, action = 'Close') {
  openSheet(
    (close) =>
      el(
        'div',
        { class: 'sheet-body' },
        el('h2', { class: 'sheet-title' }, title),
        el('p', { class: 'sheet-text' }, message),
        el('button', { class: 'button button-secondary', type: 'button', onclick: close }, action),
      ),
    title,
  );
}

// ---------- Toast ----------

export function toast(message: string) {
  document.querySelector('.toast')?.remove();
  // Screen readers hear it through the page's standing live region; a live region added with its
  // text already inside is often skipped.
  const node = el('div', { class: 'toast', 'aria-hidden': 'true' }, message);
  document.body.append(node);
  announce(message);
  setTimeout(() => node.classList.add('is-leaving'), 2600);
  setTimeout(() => node.remove(), 3000);
}

// ---------- Header ----------

/** The sticky bar at the top: the wordmark, and who's signed in. Pages move with the tab bar. */
export function header(options: { account?: Node | null } = {}) {
  return el(
    'header',
    { class: 'topbar' },
    el('a', { class: 'brand', href: '/', 'aria-label': 'Joeyy home' }, logoMark(26, true), el('span', { translate: 'no' }, 'Joeyy', el('span', { class: 'brand-sub' }, ' passport'))),
    options.account ? el('div', { class: 'topbar-end' }, options.account) : null,
  );
}

// ---------- Reward ticket (TicketShape in Design.swift) ----------

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function rewardTicket(reward: Reward, onUse: () => void, label?: string) {
  return el(
    'article',
    { class: 'ticket' },
    el(
      'div',
      { class: 'ticket-main' },
      label ? el('p', { class: 'ticket-meta' }, label) : null,
      el('p', { class: 'ticket-reward' }, reward.rewardDescription),
      label ? null : el('p', { class: 'ticket-meta' }, `Earned ${dateFormat.format(new Date(reward.earnedAt))}`),
    ),
    el('button', { class: 'ticket-use', type: 'button', 'aria-label': `Use ${lowerFirst(reward.rewardDescription)} now`, onclick: () => { haptic(12); onUse(); } }, 'Use now'),
  );
}

// ---------- Wallet and app ----------

export function platform(): 'ios' | 'android' | 'other' {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

/** No App Store listing exists yet. Set this once the app ships. */
const APP_STORE_URL = '';

async function addToWallet(api: StampApi, state: CardState, which: WalletPlatform, button: HTMLButtonElement) {
  const sub = button.querySelector('.dock-sub');
  const was = sub?.textContent ?? '';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (sub) sub.textContent = 'Adding…';
  try {
    const { url } = await api.walletPass(state.card.cardId, which);
    if (url) {
      window.location.href = url;
      return;
    }
    if (which === 'apple' && isDemo) {
      notice(
        'Wallet signing isn’t set up yet',
        'Apple only accepts passes signed with a Pass Type ID certificate. Add yours to apps/web/.wallet (the README there has the steps), and this button will add the card to Wallet.',
      );
    } else {
      notice(
        which === 'apple' ? 'Apple Wallet is coming' : 'Google Wallet is coming',
        `Wallet cards are created by the JOEYY server, which isn't connected in this preview. Your ${state.business.name} card is still saved here.`,
      );
    }
  } catch (error) {
    notice('Couldn’t create your Wallet card', error instanceof ApiError && error.code === 'offline'
      ? 'Check your connection and try again.'
      : 'Try again in a moment.');
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (sub) sub.textContent = was;
  }
}

/** A line icon in the theme's style. `d` is one or more path strings. */
function lineIcon(...paths: string[]) {
  return svg(
    'svg',
    { class: 'dock-glyph', width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...paths.map((d) => svg('path', { d })),
  );
}

/** A tiny pass in the card's own paper and ink, for the Wallet tile. */
function miniPass(done: boolean) {
  return el(
    'span',
    { class: `dock-pass${done ? ' is-done' : ''}`, 'aria-hidden': 'true' },
    el('span', { class: 'dock-pass-dot' }),
    el('span', { class: 'dock-pass-dot' }),
    el('span', { class: 'dock-pass-dot' }),
  );
}

function dockTile(icon: Node, label: string, sub: string, tone: 'plain' | 'attention' | 'done' = 'plain') {
  return el(
    'button',
    { class: `dock-tile is-${tone}`, type: 'button' },
    el('span', { class: 'dock-icon' }, icon),
    el('span', { class: 'dock-label' }, label),
    el('span', { class: 'dock-sub' }, sub),
  );
}

/**
 * Three tiles under a card: Wallet, the diner's account, and the app. Each says its state in two
 * or three words; the sheet it opens does the explaining.
 */
export function cardActions(api: StampApi, state: CardState, identity: Identity, onSignedIn: SignedIn) {
  const which: WalletPlatform = platform() === 'android' ? 'google' : 'apple';
  const pass = state.walletPass;
  const wallet = !pass
    ? dockTile(miniPass(false), 'Add to Wallet', which === 'apple' ? 'Apple Wallet' : 'Google Wallet')
    : pass.outOfDate
      ? dockTile(miniPass(false), 'Update', 'Wallet card', 'attention')
      : dockTile(miniPass(true), 'In Wallet', pass.autoUpdates ? 'Updates itself' : 'Up to date', 'done');
  wallet.addEventListener('click', () => addToWallet(api, state, which, wallet));

  const shield = 'M12 3.5l6.5 2.6v4.8c0 4.2-2.7 7.6-6.5 9.6-3.8-2-6.5-5.4-6.5-9.6V6.1z';
  let account: HTMLButtonElement;
  if (identity.kind === 'account') {
    account = dockTile(lineIcon(shield, 'M9 12l2 2 4-4'), accountName(identity, 'short'), 'Cards saved', 'done');
    account.addEventListener('click', () => toast(`Your cards are saved to ${accountName(identity, 'long')}`));
  } else {
    account = dockTile(lineIcon(shield, 'M12 8.5v4', 'M12 15.6v.01'), 'Save cards', identity.kind === 'pass' ? 'Not saved yet' : 'This phone only', 'attention');
    account.addEventListener('click', () => signInSheet(api, onSignedIn, 'save'));
  }

  const app = dockTile(lineIcon('M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z', 'M11 18h2'), 'The app', APP_STORE_URL ? 'App Store' : 'Coming soon');
  app.addEventListener('click', () => {
    if (APP_STORE_URL) window.location.href = APP_STORE_URL;
    else notice('The app is on its way', 'JOEYY isn’t in the App Store yet. Add this card to your Wallet for now, and it will move into the app when it’s out.');
  });

  return el('div', { class: 'dock', role: 'group', 'aria-label': 'Keep this card', style: pageStyle(state) }, wallet, account, app);
}

// ---------- Identity ----------

export type SignedIn = (result: SignInResult) => void;

const PROVIDER_NAME: Record<SignInProvider, string> = { apple: 'Apple', google: 'Google' };

/** The account in a few words: "••• 0123", "Apple ID" (short), or "your Apple ID" (long). */
export function accountName(identity: Identity, form: 'short' | 'long') {
  if (identity.method === 'apple') return form === 'short' ? 'Apple ID' : 'your Apple ID';
  if (identity.method === 'google') return form === 'short' ? 'Google' : 'your Google account';
  if (identity.method === 'email' && identity.maskedEmail) return form === 'short' ? identity.maskedEmail : `your email ${identity.maskedEmail}`;
  return (identity.maskedPhone ?? '').replace('••• ••• ', '••• ') || (form === 'short' ? 'Account' : 'your account');
}

/**
 * Each provider's own mark, as their brand guidelines require. Apple: the logo path from Apple's
 * Sign in with Apple JS button (appleid.cdn-apple.com), in the button's text colour. Google: the
 * four-colour "G" from Google's Sign in with Google branding guidelines.
 */
function providerLogo(provider: SignInProvider) {
  if (provider === 'apple') {
    return svg(
      'svg',
      { class: 'idp-logo', viewBox: '20.5 16 15 19', width: 15, height: 19, 'aria-hidden': 'true' },
      svg('path', {
        fill: 'currentColor',
        d: 'M28.2226562,20.3846154 C29.0546875,20.3846154 30.0976562,19.8048315 30.71875,19.0317864 C31.28125,18.3312142 31.6914062,17.352829 31.6914062,16.3744437 C31.6914062,16.2415766 31.6796875,16.1087095 31.65625,16 C30.7304687,16.0362365 29.6171875,16.640178 28.9492187,17.4494596 C28.421875,18.06548 27.9414062,19.0317864 27.9414062,20.0222505 C27.9414062,20.1671964 27.9648438,20.3121424 27.9765625,20.3604577 C28.0351562,20.3725366 28.1289062,20.3846154 28.2226562,20.3846154 Z M25.2929688,35 C26.4296875,35 26.9335938,34.214876 28.3515625,34.214876 C29.7929688,34.214876 30.109375,34.9758423 31.375,34.9758423 C32.6171875,34.9758423 33.4492188,33.792117 34.234375,32.6325493 C35.1132812,31.3038779 35.4765625,29.9993643 35.5,29.9389701 C35.4179688,29.9148125 33.0390625,28.9122695 33.0390625,26.0979021 C33.0390625,23.6579784 34.9140625,22.5588048 35.0195312,22.474253 C33.7773438,20.6382708 31.890625,20.5899555 31.375,20.5899555 C29.9804688,20.5899555 28.84375,21.4596313 28.1289062,21.4596313 C27.3554688,21.4596313 26.3359375,20.6382708 25.1289062,20.6382708 C22.8320312,20.6382708 20.5,22.5950413 20.5,26.2911634 C20.5,28.5861411 21.3671875,31.013986 22.4335938,32.5842339 C23.3476562,33.9129053 24.1445312,35 25.2929688,35 Z',
      }),
    );
  }
  return svg(
    'svg',
    { class: 'idp-logo', viewBox: '10 10 20 20', width: 20, height: 20, 'aria-hidden': 'true' },
    svg('path', { fill: '#4285F4', d: 'M29.6 20.2273C29.6 19.5182 29.5364 18.8364 29.4182 18.1818H20V22.05H25.3818C25.15 23.3 24.4455 24.3591 23.3864 25.0682V27.5773H26.6182C28.5091 25.8364 29.6 23.2727 29.6 20.2273Z' }),
    svg('path', { fill: '#34A853', d: 'M20 30C22.7 30 24.9636 29.1045 26.6181 27.5773L23.3863 25.0682C22.4909 25.6682 21.3454 26.0227 20 26.0227C17.3954 26.0227 15.1909 24.2636 14.4045 21.9H11.0636V24.4909C12.7091 27.7591 16.0909 30 20 30Z' }),
    svg('path', { fill: '#FBBC04', d: 'M14.4045 21.9C14.2045 21.3 14.0909 20.6591 14.0909 20C14.0909 19.3409 14.2045 18.7 14.4045 18.1V15.5091H11.0636C10.3864 16.8591 10 18.3864 10 20C10 21.6136 10.3864 23.1409 11.0636 24.4909L14.4045 21.9Z' }),
    svg('path', { fill: '#E94235', d: 'M20 13.9773C21.4681 13.9773 22.7863 14.4818 23.8227 15.4727L26.6909 12.6045C24.9591 10.9909 22.6954 10 20 10C16.0909 10 12.7091 12.2409 11.0636 15.5091L14.4045 18.1C15.1909 15.7364 17.3954 13.9773 20 13.9773Z' }),
  );
}

/** "Continue with Apple" (white, for dark grounds) and "Continue with Google" (light theme). */
function providerButton(provider: SignInProvider, onClick: (button: HTMLButtonElement) => void) {
  const button = el(
    'button',
    { class: `idp-button is-${provider}`, type: 'button' },
    providerLogo(provider),
    el('span', {}, `Continue with ${PROVIDER_NAME[provider]}`),
  );
  button.addEventListener('click', () => onClick(button));
  return button;
}

function phoneGlyph() {
  return svg(
    'svg',
    { class: 'idp-logo', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    svg('path', { d: 'M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z' }),
    svg('path', { d: 'M11 18h2' }),
  );
}

/**
 * On the preview, stands in for Apple's or Google's own consent screen (the real one is theirs,
 * on their site). Resolves true if the diner continues.
 */
async function previewConsent(provider: SignInProvider) {
  const { SAMPLE_EMAILS } = await import('../demo/sample');
  const name = PROVIDER_NAME[provider];
  return new Promise<boolean>((resolve) => {
    let answer = false;
    openSheet((dismiss) => {
      const finish = (ok: boolean) => {
        answer = ok;
        dismiss();
      };
      return el(
        'div',
        { class: 'sheet-body consent' },
        el('p', { class: 'preview-tag' }, `Preview: ${name}’s sign-in screen`),
        el('div', { class: 'consent-marks', 'aria-hidden': 'true' },
          el('span', { class: 'consent-mark' }, logoMark(34)),
          el('span', { class: 'consent-link' }, el('span'), el('span'), el('span')),
          el('span', { class: `consent-mark is-${provider}` }, providerLogo(provider))),
        el('h2', { class: 'sheet-title' }, `Sign in to JOEYY with ${name}?`),
        el('div', { class: 'consent-account' },
          el('span', { class: 'consent-avatar', 'aria-hidden': 'true' }, 'S'),
          el('span', {}, el('span', { class: 'consent-name' }, 'Sample Diner'), el('span', { class: 'consent-email' }, SAMPLE_EMAILS[provider]))),
        el('p', { class: 'sheet-text' }, 'JOEYY gets your name and email to find your cards. Restaurants never see them.'),
        el('button', { class: 'button button-primary', type: 'button', onclick: () => finish(true) }, `Sign in with ${name}`),
        el('button', { class: 'button button-quiet', type: 'button', onclick: () => finish(false) }, 'Cancel'),
        el('p', { class: 'consent-foot' }, `On a real phone, ${name} shows this on its own page. Here it signs in to the sample account.`),
      );
    }, `Sign in with ${name}`, () => resolve(answer));
  });
}

async function signInWithProvider(api: StampApi, onSignedIn: SignedIn, provider: SignInProvider, button: HTMLButtonElement) {
  if (isDemo && !(await previewConsent(provider))) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    // In production the page leaves for Apple or Google here and comes back to /signed-in.
    const result = await api.signInWithProvider(provider);
    announce(`Signed in with ${PROVIDER_NAME[provider]}`);
    onSignedIn(result);
  } catch (error) {
    notice('Couldn’t sign you in', error instanceof ApiError && error.code === 'offline'
      ? 'Check your connection and try again.'
      : 'Try again, or use your mobile number.');
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/**
 * The three ways in, agreed at the Nov 11 team meeting: Apple, Google, or a mobile number with a
 * text code. No email and password, so throwaway addresses can't fill the servers with accounts.
 */
function signInSheet(api: StampApi, onSignedIn: SignedIn, mode: 'signin' | 'save' = 'signin') {
  openSheet((close) => {
    const choose = (provider: SignInProvider) => (button: HTMLButtonElement) => {
      // The demo's consent sheet replaces this one; the real flow leaves the page.
      close();
      void signInWithProvider(api, onSignedIn, provider, button);
    };
    return el(
      'div',
      { class: 'sheet-body signin-sheet' },
      el('span', { class: 'signin-fan is-large', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
      el('h2', { class: 'sheet-title' }, mode === 'signin' ? 'Get your cards back' : 'Keep your stamps'),
      el('p', { class: 'sheet-text' }, mode === 'signin'
        ? 'Sign in the way you did before. Today’s stamp comes with you.'
        : 'Sign in once and your cards follow you to any phone.'),
      providerButton('apple', choose('apple')),
      providerButton('google', choose('google')),
      el('p', { class: 'signin-or', 'aria-hidden': 'true' }, el('span', {}, 'or')),
      el('button', {
        class: 'button button-secondary idp-phone',
        type: 'button',
        onclick: () => {
          close();
          phoneSheet(api, onSignedIn, mode);
        },
      }, phoneGlyph(), 'Use my mobile number'),
      el('p', { class: 'signin-small' }, 'No password. Restaurants never see your name, email or number.'),
      el('button', { class: 'button button-quiet', type: 'button', onclick: close }, 'Not now'),
    );
  }, mode === 'signin' ? 'Sign in' : 'Keep your stamps');
}

/**
 * One slim row for diners who already have JOEYY cards on another phone: a fan of card shapes,
 * "Already have cards?", and a Sign in pill that opens the three ways in.
 */
export function signInBanner(api: StampApi, onSignedIn: SignedIn, title = 'Already have cards?') {
  return el(
    'section',
    { class: 'signin-banner', 'aria-labelledby': 'signin-title' },
    el('span', { class: 'signin-fan', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
    el(
      'div',
      { class: 'signin-copy' },
      el('p', { class: 'signin-title', id: 'signin-title' }, title),
      el('p', { class: 'keep-sub' }, 'Apple, Google or phone'),
    ),
    el('button', { class: 'signin-go', type: 'button', onclick: () => signInSheet(api, onSignedIn, 'signin') }, 'Sign in'),
  );
}

export function identityNote(api: StampApi, identity: Identity, onSignedIn: SignedIn) {
  // The same slim row as the sign-in banner: a shield, a few words, and one action.
  const row = (title: string, sub: string, action: HTMLElement | null, saved: boolean) =>
    el(
      'section',
      { class: `signin-banner keep-row${saved ? ' is-saved' : ''}` },
      el('span', { class: 'keep-shield', 'aria-hidden': 'true' },
        lineIcon('M12 3.5l6.5 2.6v4.8c0 4.2-2.7 7.6-6.5 9.6-3.8-2-6.5-5.4-6.5-9.6V6.1z', saved ? 'M9 12l2 2 4-4' : 'M12 8.5v4 M12 15.6v.01')),
      el('div', { class: 'signin-copy' },
        el('p', { class: 'signin-title' }, title),
        el('p', { class: 'keep-sub' }, sub)),
      action,
    );

  if (identity.kind === 'account') return row(`Saved to ${accountName(identity, 'long')}`, 'On any phone you sign in to', null, true);
  // Pass-only and anonymous diners are one lost phone away from losing their cards.
  return row(
    'Keep your cards safe',
    identity.kind === 'pass' ? 'Sign in to use them anywhere' : 'They’re on this phone only',
    el('button', { class: 'signin-go', type: 'button', onclick: () => signInSheet(api, onSignedIn, 'save') }, 'Save'),
    false,
  );
}

export function signedInAs(identity: Identity) {
  if (identity.kind !== 'account') return 'Signed in with your Wallet pass';
  if (identity.method === 'apple' || identity.method === 'google') {
    return `Signed in with ${PROVIDER_NAME[identity.method]}${identity.maskedEmail ? ` as ${identity.maskedEmail}` : ''}`;
  }
  return `Signed in as ${identity.method === 'email' ? identity.maskedEmail : identity.maskedPhone}`;
}

/** The header chip: who this browser is signed in as, linking to the profile page (/me). */
export function accountChip(identity: Identity) {
  const saved = identity.kind !== 'anonymous';
  const label = identity.kind === 'account' ? accountName(identity, 'short') : identity.kind === 'pass' ? 'Wallet pass' : 'Profile';
  return el(
    'a',
    {
      class: 'account-chip',
      href: '/me',
      'aria-label': saved
        ? `Your profile. Signed in with ${identity.kind === 'account' ? accountName(identity, 'long') : 'your Wallet pass'}`
        : 'Your profile',
    },
    el('span', { class: `account-dot${saved ? '' : ' is-local'}`, 'aria-hidden': 'true' }),
    label,
  );
}

/** Sign out, for shared phones. Confirms first, since it takes the cards off this browser. */
export function signOutSheet(api: StampApi, identity: Identity) {
  openSheet((close) => {
    const out = el('button', { class: 'button button-danger', type: 'button' }, 'Sign out');
    out.addEventListener('click', async () => {
      busy(out, 'Signing out…');
      await api.signOut().catch(() => undefined);
      close();
      toast('Signed out');
      window.location.assign('/');
    });
    return el(
      'div',
      { class: 'sheet-body' },
      el('h2', { class: 'sheet-title' }, signedInAs(identity)),
      el('p', { class: 'sheet-text' }, 'Signing out removes your cards from this browser only. They stay on your account, ready on any phone you sign in to.'),
      out,
      el('button', { class: 'button button-quiet', type: 'button', onclick: close }, 'Cancel'),
    );
  }, 'Sign out');
}

function phoneSheet(api: StampApi, onSignedIn: SignedIn, mode: 'save' | 'signin' = 'save') {
  openSheet((close) => {
    const body = el('div', { class: 'sheet-body' });

    const showStart = () => {
      const error = el('p', { class: 'field-error', id: 'phone-error', role: 'alert' });
      const input = el('input', {
        class: 'field-input', id: 'phone', name: 'tel', type: 'tel', inputmode: 'tel',
        autocomplete: 'tel', placeholder: '(604) 555-0123', required: true, 'aria-describedby': 'phone-help phone-error',
      });
      const submit = el('button', { class: 'button button-primary', type: 'submit' }, 'Text me a code');
      const form = el(
        'form',
        { class: 'form', novalidate: true },
        el('h2', { class: 'sheet-title' }, mode === 'signin' ? 'Sign in with your number' : 'Keep your stamps'),
        el('label', { class: 'field-label', for: 'phone' }, 'Mobile number'),
        input,
        el('p', { class: 'field-help', id: 'phone-help' }, 'You’ll get a text with a 6-digit code. Restaurants never see your number.'),
        error,
        submit,
        el('button', { class: 'button button-quiet', type: 'button', onclick: close }, 'Cancel'),
      );
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.textContent = '';
        if (input.value.replace(/\D/g, '').length < 10) {
          error.textContent = 'Enter a 10-digit mobile number, including the area code.';
          input.focus();
          return;
        }
        const done = busy(submit, 'Sending code…');
        try {
          const { maskedPhone } = await api.startPhone(input.value);
          showVerify(maskedPhone);
        } catch (err) {
          error.textContent = err instanceof ApiError && err.code === 'offline'
            ? 'No connection. Check your signal and try again.'
            : 'That number didn’t work. Check it and try again.';
          done();
          input.focus();
        }
      });
      input.addEventListener('input', () => (error.textContent = ''));
      body.replaceChildren(form);
      setTimeout(() => input.focus(), 50);
    };

    const showVerify = (maskedPhone: string) => {
      const error = el('p', { class: 'field-error', id: 'code-error', role: 'alert' });
      const input = el('input', {
        class: 'field-input is-code', id: 'code', name: 'code', type: 'text', inputmode: 'numeric',
        autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*', required: true, spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': 'code-help code-error',
      });
      const submit = el('button', { class: 'button button-primary', type: 'submit' }, mode === 'signin' ? 'Sign in and move my stamp' : 'Confirm');
      const form = el(
        'form',
        { class: 'form', novalidate: true },
        el('h2', { class: 'sheet-title' }, 'Enter your code'),
        el('label', { class: 'field-label', for: 'code' }, `Sent to ${maskedPhone}`),
        input,
        el('p', { class: 'field-help', id: 'code-help' },
          isDemo ? 'Preview code: 123456. On a phone, the keyboard offers the code from your texts.' : 'Your keyboard offers the code from your texts. One tap fills it in.'),
        error,
        submit,
        el('button', { class: 'link-button', type: 'button', onclick: showStart }, 'Use a different number'),
      );
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.textContent = '';
        if (!/^\d{6}$/.test(input.value.trim())) {
          error.textContent = 'Enter the 6-digit code from the text.';
          input.focus();
          return;
        }
        const done = busy(submit, 'Checking…');
        try {
          const result = await api.verifyPhone(input.value);
          close();
          announce(`Signed in as ${result.identity.maskedPhone}`);
          onSignedIn(result);
        } catch (err) {
          error.textContent = err instanceof ApiError && err.code === 'invalidCode'
            ? 'That code doesn’t match. Check the text and try again.'
            : 'Something went wrong. Request a new code.';
          done();
          input.focus();
        }
      });
      input.addEventListener('input', () => (error.textContent = ''));
      body.replaceChildren(form);
      setTimeout(() => input.focus(), 50);
    };

    showStart();
    return body;
  }, mode === 'signin' ? 'Sign in' : 'Add mobile number');
}
