import { ApiError, type CardState, type Identity, type StampApi } from '../api';
import { header, identityNote, openSheet, signedInAs, signInBanner, signOutSheet, toast } from '../ui/components';
import { announce, busy, el, svg } from '../ui/dom';
import { panelTitle } from '../ui/icons';
import { stampMark } from '../ui/passport';
import { emptyState, skeletonCards } from '../ui/placeholders';
import { recentActivity } from '../ui/progress';
import { INKS, initials, rotationOf, seedOf, stampLabel } from '../ui/stamp-style';
import { clearMerchantTheme } from '../ui/theme';
import { footer, loading, messagePage, mount } from './shared';

// /me: the passport's own data page. The diner's name (theirs to set, never shown to a
// restaurant), a stamp for every place they have a card at, and the account: how they're signed
// in, saving their cards, signing out and deleting the account.

const visitsAt = (state: CardState) => Math.max(state.recentVisits?.length ?? 0, state.card.punches);

function holderName(identity: Identity) {
  if (identity.displayName) return identity.displayName;
  if (identity.kind === 'pass') return 'Wallet pass';
  if (identity.kind === 'anonymous') return 'This phone';
  if (identity.method === 'apple') return identity.maskedEmail ?? 'Apple ID';
  if (identity.method === 'google') return identity.maskedEmail ?? 'Google';
  return identity.maskedEmail ?? identity.maskedPhone ?? 'Account';
}

/** The passport photo box: a holder outline, since JOEYY never asks for a face. */
function holderPhoto() {
  return el(
    'div',
    { class: 'bio-photo', 'aria-hidden': 'true' },
    svg(
      'svg',
      { viewBox: '0 0 48 56', width: 48, height: 56 },
      svg('circle', { cx: 24, cy: 20, r: 9 }),
      svg('path', { d: 'M7 52c1.5-10 8.5-16 17-16s15.5 6 17 16' }),
    ),
  );
}

/**
 * The holder line, with the name editable in place on the page (signed-in diners only: a name
 * needs an account to live on). Saving shows straight away and reverts if the server says no.
 */
function holderField(api: StampApi, identity: Identity) {
  const value = el('dd', { class: 'bio-holder' }, holderName(identity));
  const field = el('div', { class: 'bio-field is-wide' }, el('dt', {}, 'Holder'), value);
  if (identity.kind === 'anonymous') return field;

  const edit = el('button', { class: 'bio-edit', type: 'button' }, identity.displayName ? 'Edit name' : 'Add your name');
  field.append(edit);
  edit.addEventListener('click', () => {
    const error = el('p', { class: 'field-error', id: 'name-error', role: 'alert' });
    const input = el('input', {
      class: 'field-input', id: 'display-name', name: 'displayName', type: 'text', maxlength: 40,
      autocomplete: 'nickname', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'done',
      placeholder: 'Sam…', value: identity.displayName ?? '', 'aria-describedby': 'name-help name-error',
    });
    const save = el('button', { class: 'button button-primary', type: 'submit' }, 'Save name');
    const cancel = el('button', { class: 'button button-quiet', type: 'button' }, 'Cancel');
    const form = el(
      'form',
      { class: 'bio-form', novalidate: true },
      el('label', { class: 'field-label', for: 'display-name' }, 'What should we call you?'),
      input,
      el('p', { class: 'field-help', id: 'name-help' }, 'Only you see this. Restaurants see visits, never names.'),
      error,
      el('div', { class: 'bio-form-actions' }, save, cancel),
    );
    // A <dl> may only hold field groups, so the form sits in one.
    const editor = el('div', { class: 'bio-field is-editing' }, form);
    const close = () => {
      editor.replaceWith(field);
      edit.focus();
    };
    cancel.addEventListener('click', close);
    form.addEventListener('keydown', (event) => event.key === 'Escape' && close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      input.removeAttribute('aria-invalid');
      const name = input.value.replace(/\s+/g, ' ').trim();
      if ([...name].length > 40) {
        error.textContent = 'Use 40 letters or fewer.';
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      const done = busy(save, 'Saving…');
      try {
        const saved = await api.saveProfile({ displayName: name });
        identity.displayName = saved.displayName;
        value.textContent = holderName(identity);
        edit.textContent = saved.displayName ? 'Edit name' : 'Add your name';
        document.querySelector('.profile-greeting')?.replaceChildren(greeting(identity));
        close();
        announce(saved.displayName ? `Saved. Hi, ${saved.displayName}.` : 'Name removed.');
      } catch (failure) {
        done();
        error.textContent = failure instanceof ApiError && failure.code === 'invalidName'
          ? 'Use letters, spaces, apostrophes or hyphens, up to 40.'
          : 'Couldn’t save your name. Check your signal and try again.';
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    });
    field.replaceWith(editor);
    input.focus();
  });
  return field;
}

/** The data page: holder, places, visits and rewards, with a machine-readable line along the foot. */
function bioPage(api: StampApi, identity: Identity, cards: CardState[]) {
  const visits = cards.reduce((sum, state) => sum + visitsAt(state), 0);
  const rewards = cards.reduce((sum, state) => sum + state.rewardsAvailable.length, 0);
  const field = (label: string, value: string) => el('div', { class: 'bio-field' }, el('dt', {}, label), el('dd', {}, value));
  // Like a real passport's MRZ: the document type, issuer, then each place's initials.
  const mrz = `P<JOEYY<<${cards.map((state) => initials(state.business.name)).join('<')}`.padEnd(44, '<').slice(0, 44);
  return el(
    'section',
    { class: 'bio-page', 'aria-label': 'Your passport' },
    el('p', { class: 'bio-issuer', translate: 'no' }, 'Joeyy passport'),
    el(
      'div',
      { class: 'bio-body' },
      holderPhoto(),
      el(
        'dl',
        { class: 'bio-fields' },
        holderField(api, identity),
        field('Places', String(cards.length)),
        field('Visits', String(visits)),
        field('Rewards', String(rewards)),
      ),
    ),
    el('p', { class: 'bio-mrz', 'aria-hidden': 'true' }, mrz),
  );
}

/** One entry stamp per place, in that place's ink, linking to its card. */
function placeStamps(cards: CardState[]) {
  if (!cards.length) {
    return emptyState({
      title: 'No stamps yet',
      text: 'Tap a JOEYY stand at the counter and your first stamp lands here.',
      action: { label: 'Find a place', href: '/discover' },
    });
  }
  return el(
    'section',
    { class: 'block panel', 'aria-labelledby': 'stamps-title' },
    panelTitle('stamp', 'Places you’ve been', 'stamps-title'),
    el('ul', { class: 'entry-stamps' }, ...cards.map((state, index) => {
      const seed = seedOf(state.business.id);
      const visits = visitsAt(state);
      return el(
        'li',
        {},
        el(
          'a',
          { class: 'entry-stamp', href: `/c?open=${encodeURIComponent(state.business.id)}` },
          stampMark({
            ink: INKS[seed % INKS.length],
            shape: 'round',
            label: initials(state.business.name),
            sub: stampLabel(state.recentVisits?.[0]),
            seed,
            rotate: rotationOf(index, seed),
          }),
          el('span', { class: 'entry-name' }, state.business.name),
          el('span', { class: 'entry-count' },
            state.rewardsAvailable.length ? 'Reward ready' : visits === 1 ? '1 visit' : `${visits} visits`),
        ),
      );
    })),
  );
}

/** Deleting is for good, so the sheet says exactly what goes, and Cancel is the easy way out. */
function deleteSheet(api: StampApi, cards: CardState[]) {
  const unused = cards.reduce((sum, state) => sum + state.rewardsAvailable.length, 0);
  openSheet((close) => {
    const remove = el('button', { class: 'button button-danger', type: 'button' }, 'Delete my account and data');
    const error = el('p', { class: 'field-error', role: 'alert' });
    remove.addEventListener('click', async () => {
      const done = busy(remove, 'Deleting…');
      try {
        await api.deleteAccount();
        close();
        toast('Your account is deleted');
        window.location.assign('/');
      } catch {
        done();
        error.textContent = 'Couldn’t delete your account. Check your signal and try again.';
      }
    });
    const keep = el('button', { class: 'button button-quiet', type: 'button', onclick: close, autofocus: true }, 'Keep my account');
    return el(
      'div',
      { class: 'sheet-body' },
      el('h2', { class: 'sheet-title' }, 'Delete your account?'),
      el('ul', { class: 'sheet-list' },
        cards.length ? el('li', {}, `Your ${cards.length === 1 ? 'card' : `${cards.length} cards`} and every stamp on them`) : null,
        unused ? el('li', {}, `${unused === 1 ? 'Your unused reward' : `${unused} unused rewards`}, for good`) : null,
        el('li', {}, 'Your name and the ways you sign in'),
        el('li', {}, 'Your Wallet passes stop updating')),
      el('p', { class: 'sheet-text' }, 'You’ll be signed out everywhere. This can’t be undone.'),
      error,
      remove,
      keep,
    );
  }, 'Delete account');
}

function accountSection(api: StampApi, identity: Identity, cards: CardState[]) {
  const refresh = () => void profileScreen(api);
  const signedIn = identity.kind !== 'anonymous';
  return el(
    'section',
    { class: 'block panel', 'aria-labelledby': 'account-title' },
    panelTitle('person', 'Account', 'account-title'),
    !cards.length && !signedIn
      ? signInBanner(api, refresh, 'Cards on another phone?')
      : identityNote(api, identity, refresh),
    signedIn
      ? el('button', { class: 'button button-secondary', type: 'button', onclick: () => signOutSheet(api, identity) }, 'Sign out of this browser')
      : el('p', { class: 'field-help' }, 'Sign in to add your name and keep your cards on any phone.'),
    signedIn
      ? el('button', { class: 'link-button account-delete', type: 'button', onclick: () => deleteSheet(api, cards) }, 'Delete my account')
      : null,
  );
}

/** "Hi, Sam" once the diner has a name; otherwise how this browser is signed in. */
function greeting(identity: Identity) {
  if (identity.displayName) return `Hi, ${identity.displayName}. ${signedInAs(identity)}.`;
  return identity.kind === 'anonymous' ? 'Kept on this phone only' : signedInAs(identity);
}

export async function profileScreen(api: StampApi) {
  clearMerchantTheme();
  let data;
  try {
    data = await loading(api.myCards(), 'Loading your passport…', skeletonCards(1));
  } catch {
    messagePage({
      drawing: 'signal',
      headline: 'No connection',
      message: 'Your cards are safe. Check your signal and try again.',
      action: { label: 'Try again', onClick: () => void profileScreen(api) },
    });
    return;
  }
  const { identity, cards } = data;
  mount(
    el(
      'main',
      { class: 'page page-profile' },
      header(),
      el('section', { class: 'hero' },
        el('h1', { class: 'headline' }, 'Your passport'),
        el('p', { class: 'subline profile-greeting' }, greeting(identity))),
      bioPage(api, identity, cards),
      placeStamps(cards),
      recentActivity(cards),
      accountSection(api, identity, cards),
      footer(),
    ),
  );
}
