import '../styles/business.css';
import { ApiError } from '../api/types';
import { navigate } from '../router';
import { loading, mount } from '../screens/shared';
import { notice, openSheet, toast } from '../ui/components';
import { announce, busy, countdown, el, haptic } from '../ui/dom';
import { icon, panelTitle } from '../ui/icons';
import { logoMark } from '../ui/sections';
import { clearMerchantTheme } from '../ui/theme';
import { createPartnerApi, type PartnerAccount, type PartnerApi, type Stand, type Today } from './api';
import { draftFrom, ideas, lookFields, preview, stepper, textField, type Draft } from './card-form';

// The business site: /business and below. An owner signs in with their email, makes their card in
// four steps (place, reward, look, stand), then lands on Today. Loaded on its own (main.ts imports
// it lazily), so diners never download it.

const isDemo = import.meta.env.VITE_MODE === 'demo';
let api: PartnerApi | undefined;
const partnerApi = () => (api ??= createPartnerApi());

type Section = 'today' | 'card' | 'stands';

const isLive = (account: PartnerAccount) => Boolean(account.program && account.stands.some((stand) => stand.status === 'active'));

// ---------- Frame ----------

function bizHeader(account: PartnerAccount | null, current?: Section) {
  const signOut = el('button', { class: 'biz-signout', type: 'button' }, 'Sign out');
  signOut.addEventListener('click', async () => {
    busy(signOut, 'Signing out…');
    await partnerApi().signOut().catch(() => undefined);
    navigate('/business', { replace: true });
  });
  const links: [Section, string][] = [['today', 'Today'], ['card', 'Card'], ['stands', 'Stands']];
  return el(
    'header',
    { class: 'topbar biz-topbar' },
    el('a', { class: 'brand', href: '/business', 'aria-label': 'Joeyy for business home' }, logoMark(26), el('span', { translate: 'no' }, 'Joeyy', el('span', { class: 'brand-sub' }, ' for business'))),
    current
      ? el('nav', { class: 'biz-nav', 'aria-label': 'Business' }, ...links.map(([section, label]) =>
          el('a', { class: 'biz-tab', href: `/business/${section}`, 'aria-current': section === current ? 'page' : undefined }, label)))
      : null,
    account ? el('div', { class: 'topbar-end' }, signOut) : null,
  );
}

function bizFooter() {
  return el(
    'footer',
    { class: 'footer biz-footer' },
    el('p', { class: 'footer-brand', translate: 'no' }, logoMark(20), 'Joeyy for business'),
    el('p', {}, 'Diners stay anonymous. You see visits and rewards, never names, numbers or emails.'),
    el('nav', { class: 'footer-links', 'aria-label': 'More' }, el('a', { href: '/' }, 'The diner side'), el('a', { href: '/privacy' }, 'Privacy'), el('a', { href: '/terms' }, 'Terms')),
  );
}

function page(account: PartnerAccount | null, current: Section | undefined, ...children: (Node | null)[]) {
  clearMerchantTheme();
  mount(el('main', { class: `page page-business${current ? ` is-${current}` : ''}` }, bizHeader(account, current), ...children, bizFooter()));
}

/** The signed-in account, or a trip to sign-in. */
async function signedIn(label: string) {
  try {
    const account = await loading(partnerApi().me(), label);
    if (!account) navigate('/business/sign-in', { replace: true });
    return account;
  } catch {
    offline();
    return null;
  }
}

function offline() {
  page(null, undefined, el('section', { class: 'hero' },
    el('h1', { class: 'headline' }, 'Can’t reach JOEYY'),
    el('p', { class: 'subline' }, 'Check your connection, then try again.')),
  el('button', { class: 'button button-primary biz-cta', type: 'button', onclick: () => window.location.reload() }, 'Try again'));
}

// ---------- Landing ----------

export async function landingScreen() {
  const account = await partnerApi().me().catch(() => null);
  if (account) {
    navigate(account.program ? '/business/today' : '/business/setup', { replace: true });
    return;
  }
  const sample = draftFrom(null);
  Object.assign(sample, { name: 'Your place', location: 'Your neighbourhood', reward: 'A free coffee', punches: 8 });
  page(
    null,
    undefined,
    el('div', { class: 'biz-split' },
      el('section', { class: 'hero biz-hero' },
        el('h1', { class: 'headline' }, 'A stamp card that lives on your counter.'),
        el('p', { class: 'subline' }, 'Diners tap a JOEYY stand after they pay. The stamp lands on their phone. No app to download, no paper cards to print.'),
        el('a', { class: 'button button-primary biz-cta', href: '/business/sign-in' }, 'Make your card'),
        el('p', { class: 'biz-aside' }, 'Already set up? ', el('a', { href: '/business/sign-in' }, 'Sign in'))),
      preview(sample).root),
    el('section', { class: 'block panel', 'aria-labelledby': 'how-title' },
      panelTitle('stamp', 'Live in about five minutes', 'how-title'),
      el('ol', { class: 'biz-steps' },
        el('li', {}, el('strong', {}, 'Make your card. '), 'Your name, your reward, your colours.'),
        el('li', {}, el('strong', {}, 'Link your stand. '), 'Hold your phone on the stand from your kit, once.'),
        el('li', {}, el('strong', {}, 'Diners tap after they pay. '), 'Each visit shows up on your Today page as it happens.'))),
    el('section', { class: 'block panel', 'aria-labelledby': 'trust-title' },
      panelTitle('person', 'Fair to your regulars', 'trust-title'),
      el('p', { class: 'panel-note' }, 'Every stamp is checked against the stand’s signature, so a screenshot or a shared link can’t add one. Each reward can be used once. Diners don’t sign up to collect, and you never see who they are.')),
  );
}

// ---------- Sign in ----------

export async function signInScreen() {
  const existing = await partnerApi().me().catch(() => null);
  if (existing) {
    navigate(existing.program ? '/business/today' : '/business/setup', { replace: true });
    return;
  }
  const error = el('p', { class: 'field-error', role: 'alert' });
  const email = el('input', { class: 'field-input', id: 'biz-email', type: 'email', autocomplete: 'email', inputmode: 'email', required: true, maxlength: 120 });
  const send = el('button', { class: 'button button-primary', type: 'submit' }, 'Email me a code');
  const form = el('form', { class: 'biz-form', novalidate: true },
    el('label', { class: 'field-label', for: 'biz-email' }, 'Your email'),
    email,
    el('p', { class: 'field-help' }, 'New here? The same code makes your account.'),
    error,
    send);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const done = busy(send, 'Sending…');
    try {
      const { maskedEmail } = await partnerApi().startEmail(email.value);
      codeStep(form, maskedEmail);
    } catch (problem) {
      done();
      error.textContent = problem instanceof ApiError && problem.code === 'invalidEmail' ? 'That doesn’t look like an email. Check it and try again.' : 'Couldn’t send the code. Check your connection.';
      email.focus();
    }
  });
  page(null, undefined,
    el('section', { class: 'hero' },
      el('h1', { class: 'headline' }, 'Sign in to make your card'),
      el('p', { class: 'subline' }, 'We’ll email you a 6-digit code. No password to remember.')),
    el('section', { class: 'block panel biz-signin' }, form));
  email.focus();
}

function codeStep(form: HTMLFormElement, maskedEmail: string) {
  const error = el('p', { class: 'field-error', role: 'alert' });
  const code = el('input', { class: 'field-input is-code', id: 'biz-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*' });
  const verify = el('button', { class: 'button button-primary', type: 'submit' }, 'Sign in');
  const next = el('form', { class: 'biz-form', novalidate: true },
    el('label', { class: 'field-label', for: 'biz-code' }, `Code sent to ${maskedEmail}`),
    code,
    isDemo ? el('p', { class: 'field-help' }, 'Demo: the code is 123456.') : null,
    error,
    verify,
    el('a', { class: 'button button-quiet', href: '/business/sign-in', onclick: (event: Event) => { event.preventDefault(); void signInScreen(); } }, 'Use a different email'));
  next.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const done = busy(verify, 'Checking…');
    try {
      const account = await partnerApi().verifyEmail(code.value);
      announce('Signed in.');
      navigate(account.program ? '/business/today' : '/business/setup', { replace: true });
    } catch (problem) {
      done();
      error.textContent = problem instanceof ApiError && problem.code === 'invalidCode' ? 'That code doesn’t match. Check the email and try again.' : 'Couldn’t sign in. Try again.';
      code.select();
    }
  });
  form.replaceWith(next);
  code.focus();
}

// ---------- Setup ----------

const STEPS = [
  { id: 'place', label: 'Place' },
  { id: 'reward', label: 'Reward' },
  { id: 'look', label: 'Look' },
  { id: 'stand', label: 'Stand' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

// The draft lives across the steps' page changes and a reload (sessionStorage, this tab only), and
// starts again when another owner signs in. Nothing in it is secret: it becomes the public card.
const DRAFT_KEY = 'joeyy-business-draft';
let draft: Draft | undefined;
let draftOwner = '';

function restoreDraft(owner: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as { owner: string; draft: Draft } | null;
    return saved?.owner === owner ? saved.draft : undefined;
  } catch {
    return undefined;
  }
}

function keepDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ owner: draftOwner, draft }));
  } catch {
    /* Private mode or storage off: the draft lasts until the tab reloads. */
  }
}

function progress(current: StepId, account: PartnerAccount) {
  const saved: Record<StepId, boolean> = {
    place: Boolean(account.business),
    reward: Boolean(account.program),
    look: Boolean(account.program),
    stand: account.stands.length > 0,
  };
  const at = STEPS.findIndex((step) => step.id === current);
  // A step is stamped once it's saved, or once the owner has moved past it.
  const done = Object.fromEntries(STEPS.map((step, index) => [step.id, saved[step.id] || index < at])) as Record<StepId, boolean>;
  return el('ol', { class: 'setup-progress', 'aria-label': 'Setup' }, ...STEPS.map((step, index) =>
    el('li', { class: `${done[step.id] ? 'is-done' : ''}${step.id === current ? ' is-current' : ''}`, 'aria-current': step.id === current ? 'step' : undefined },
      el('span', { class: 'setup-dot', 'aria-hidden': 'true' }, done[step.id] && step.id !== current ? icon('stamp', 14) : String(index + 1)),
      el('span', { class: 'setup-label' }, step.label))));
}

export async function setupScreen(query: URLSearchParams) {
  const account = await signedIn('Opening setup…');
  if (!account) return;
  if (draftOwner !== account.maskedEmail || !draft) {
    draftOwner = account.maskedEmail;
    draft = restoreDraft(draftOwner) ?? draftFrom(account);
  }
  const requested = query.get('step') as StepId | null;
  const fallback: StepId = !account.business ? 'place' : !account.program ? 'reward' : 'stand';
  const step: StepId = requested && STEPS.some((item) => item.id === requested) ? requested : fallback;
  // A step that needs an earlier one sends the owner back to it.
  if ((step !== 'place' && !account.business) || (step === 'stand' && !account.program)) {
    navigate(`/business/setup?step=${fallback}`, { replace: true });
    return;
  }

  const current = draft;
  const card = preview(current);
  const error = el('p', { class: 'field-error', role: 'alert' });
  const next = el('button', { class: 'button button-primary', type: 'button' }, 'Next');
  const index = STEPS.findIndex((item) => item.id === step);
  const back = index > 0
    ? el('a', { class: 'button button-quiet', href: `/business/setup?step=${STEPS[index - 1].id}` }, 'Back')
    : null;

  let question: string;
  let lede: string;
  let fields: Node[];
  if (step === 'place') {
    question = 'What’s your place called?';
    lede = 'This is how it shows on the card and on Discover.';
    fields = [
      textField('Name', current.name, (value) => { current.name = value; card.update(); }, { autocomplete: 'organization', placeholder: 'Ferrous Coffee' }),
      textField('What kind of place', current.category, (value) => { current.category = value; }, { max: 30, placeholder: 'Café, bakery, ramen bar…' }),
      textField('Neighbourhood and city', current.location, (value) => { current.location = value; card.update(); }, { max: 60, placeholder: 'Belltown, Seattle' }),
      textField('Street address', current.address, (value) => { current.address = value; }, { max: 100, autocomplete: 'street-address', help: 'Optional. Diners use it for directions.' }),
    ];
    next.addEventListener('click', async () => {
      if (current.name.trim().length < 2 || current.location.trim().length < 2) {
        error.textContent = 'Add your place’s name and where it is.';
        return;
      }
      const done = busy(next, 'Saving…');
      try {
        await partnerApi().saveBusiness({ name: current.name, category: current.category, location: current.location, address: current.address });
        navigate('/business/setup?step=reward');
      } catch {
        done();
        error.textContent = 'Couldn’t save. Check your connection and try again.';
      }
    });
  } else if (step === 'reward') {
    question = 'What do regulars get?';
    lede = 'Something you’d be glad to hand over. Keep it short: it’s printed on the card.';
    const rewardField = textField('Reward', current.reward, (value) => { current.reward = value; card.update(); }, { max: 50, placeholder: 'A free coffee' });
    fields = [
      rewardField,
      ideas(() => rewardField.querySelector('input'), (value) => { current.reward = value; card.update(); }),
      stepper('Stamps to earn it', current.punches, (value) => { current.punches = value; card.update(); }),
    ];
    next.addEventListener('click', () => {
      if (current.reward.trim().length < 2) {
        error.textContent = 'Add the reward diners earn.';
        return;
      }
      navigate('/business/setup?step=look');
    });
  } else if (step === 'look') {
    question = 'How should it look?';
    lede = 'Pick a paper and lettering close to your shop. You can change it any time.';
    fields = lookFields(current, () => card.update());
    next.textContent = 'Publish card';
    next.addEventListener('click', async () => {
      const done = busy(next, 'Publishing…');
      try {
        await partnerApi().publishCard({ requiredPunches: current.punches, rewardDescription: current.reward, theme: current.theme });
        // Published: the server's copy is the card now.
        try {
          sessionStorage.removeItem(DRAFT_KEY);
        } catch {
          /* Nothing kept. */
        }
        draft = undefined;
        haptic([10, 40, 14]);
        navigate('/business/setup?step=stand');
      } catch (problem) {
        done();
        error.textContent = problem instanceof ApiError && problem.code === 'invalidCard'
          ? 'Check the reward and the stamps, then try again.'
          : 'Couldn’t publish. Check your connection and try again.';
      }
    });
  } else {
    page(account, undefined,
      el('div', { class: 'setup is-stand' },
        el('div', { class: 'setup-head' }, progress(step, account), el('p', { class: 'setup-kicker' }, 'Step 4 of 4')),
        card.root,
        el('div', { class: 'setup-body' }, standLinker(account, () => navigate('/business/today', { replace: true })))));
    return;
  }

  const form = el('div', { class: 'setup' },
      el('div', { class: 'setup-head' },
        progress(step, account),
        el('p', { class: 'setup-kicker' }, `Step ${index + 1} of 4`),
        el('h1', { class: 'headline setup-question' }, question),
        el('p', { class: 'subline' }, lede)),
      card.root,
      el('div', { class: 'setup-body' },
        el('div', { class: 'setup-fields' }, ...fields),
        error,
        el('div', { class: 'setup-actions' }, next, back)));
  // Every field, chip and swatch changes the draft before this runs.
  for (const type of ['input', 'change', 'click']) form.addEventListener(type, keepDraft);
  page(account, undefined, form);
}

// ---------- Linking a stand ----------

/**
 * Opens a two-minute linking window, then waits for the owner's phone to touch a stand from their
 * kit. The server links the first unlinked stand tapped by this signed-in owner while it's open.
 */
function standLinker(account: PartnerAccount, onDone: () => void, heading: 'h1' | 'h2' = 'h1') {
  const root = el('section', { class: 'linker', 'aria-labelledby': 'linker-title' });
  const title = (text: string, extra = '') => el(heading, { class: `headline${extra}`, id: 'linker-title' }, text);
  const known = account.stands.length;
  let timer = 0;
  let polling = true;
  const stop = () => {
    polling = false;
    window.clearInterval(timer);
  };

  const linked = (stand: Stand) => {
    stop();
    haptic([12, 50, 18]);
    announce(`${stand.label} linked.`);
    // In setup, the last step gets its stamp.
    const last = root.closest('.setup')?.querySelector('.setup-progress li:last-child');
    last?.classList.add('is-done');
    last?.querySelector('.setup-dot')?.replaceChildren(icon('stamp', 14));
    root.replaceChildren(
      el('div', { class: 'linker-done', 'aria-hidden': 'true' }, icon('stamp', 34)),
      title(known ? 'Stand linked.' : 'You’re live.'),
      el('p', { class: 'subline' }, `Diners who tap your ${stand.label.toLowerCase()} get a stamp on your card.`),
      el('div', { class: 'setup-actions' }, el('button', { class: 'button button-primary', type: 'button', onclick: onDone }, known ? 'Done' : 'Open Today')),
    );
  };

  const intro = () => {
    stop();
    const start = el('button', { class: 'button button-primary', type: 'button' }, 'I’m at the stand');
    start.addEventListener('click', async () => {
      const done = busy(start, 'Getting ready…');
      try {
        const opened = await partnerApi().startPairing();
        waiting(Date.parse(opened.pairing!.expiresAt));
      } catch {
        done();
        notice('Couldn’t start linking', 'Check your connection and try again.');
      }
    });
    root.replaceChildren(
      title(known ? 'Link another stand.' : 'Link your stand.', ' setup-question'),
      el('p', { class: 'subline' }, `Take the stand from your kit to the counter. You’ll hold this phone on it once, and it starts stamping for ${account.business?.name ?? 'your place'}.`),
      el('div', { class: 'setup-actions' },
        start,
        el('button', { class: 'button button-quiet', type: 'button', onclick: onDone }, known ? 'Cancel' : 'I’ll do this later')),
    );
  };

  const waiting = (expires: number) => {
    const time = el('p', { class: 'linker-time', role: 'timer', 'aria-label': 'Time left to tap' }, countdown(expires - Date.now()));
    const cancel = el('button', { class: 'button button-quiet', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', async () => {
      stop();
      await partnerApi().cancelPairing().catch(() => undefined);
      intro();
    });
    const simulate = isDemo
      ? el('button', {
          class: 'button button-secondary', type: 'button',
          onclick: async () => {
            const { demo } = await import('../api/demo');
            await demo.linkStand().catch(() => undefined);
            void check();
          },
        }, 'Preview: touch the stand')
      : null;
    root.replaceChildren(
      title('Hold your phone on the stand.', ' setup-question'),
      el('p', { class: 'subline' }, 'Top of the phone, flat on the JOEYY mark, until it buzzes. Keep this page open.'),
      el('div', { class: 'linker-ring' }, el('span', { class: 'linker-pulse', 'aria-hidden': 'true' }), time),
      el('div', { class: 'setup-actions' }, simulate, cancel),
    );
    announce('Hold your phone on the stand within 2 minutes.');

    const check = async () => {
      if (!polling || !root.isConnected) return stop();
      const fresh = await partnerApi().me().catch(() => null);
      if (!polling || !fresh) return;
      if (fresh.stands.length > known) linked(fresh.stands[fresh.stands.length - 1]);
    };
    polling = true;
    let ticks = 0;
    timer = window.setInterval(() => {
      if (!root.isConnected) return stop();
      const left = expires - Date.now();
      time.textContent = countdown(left);
      if (left <= 0) {
        stop();
        root.replaceChildren(
          title('Linking timed out', ' setup-question'),
          el('p', { class: 'subline' }, 'No stand was tapped in 2 minutes. Nothing changed.'),
          el('div', { class: 'setup-actions' }, el('button', { class: 'button button-primary', type: 'button', onclick: intro }, 'Try again')),
        );
        return;
      }
      if ((ticks += 1) % 8 === 0) void check();
    }, 250);
  };

  if (account.pairing) waiting(Date.parse(account.pairing.expiresAt));
  else intro();
  return root;
}

// ---------- Today ----------

const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

function activityLine(item: Today['activity'][number], required: number) {
  const what = {
    first: 'First visit: stamp 1',
    stamp: `Stamp ${item.punches} of ${required}`,
    earned: `Stamp ${required} of ${required}: reward earned`,
    used: 'Reward used',
  }[item.kind];
  return el('li', { class: `till-row is-${item.kind}` },
    el('span', {}, what),
    el('time', { datetime: item.at }, timeOfDay.format(new Date(item.at))));
}

function figure(value: number, label: string) {
  return el('div', { class: 'biz-figure' }, el('span', { class: 'biz-figure-num' }, String(value)), el('span', { class: 'biz-figure-label' }, label));
}

export async function todayScreen() {
  const account = await signedIn('Opening Today…');
  if (!account) return;
  if (!account.program) {
    navigate('/business/setup', { replace: true });
    return;
  }
  const program = account.program;
  const stats = el('div', { class: 'biz-figures', 'aria-live': 'polite' });
  const till = el('ol', { class: 'till' });
  const empty = el('p', { class: 'panel-note till-empty' }, 'No taps yet today. When a diner taps your stand, it shows up here.');
  const draw = (today: Today) => {
    stats.replaceChildren(figure(today.stamps, today.stamps === 1 ? 'stamp' : 'stamps'), figure(today.rewardsUsed, today.rewardsUsed === 1 ? 'reward used' : 'rewards used'), figure(today.newDiners, today.newDiners === 1 ? 'new diner' : 'new diners'));
    till.replaceChildren(...today.activity.map((item) => activityLine(item, program.requiredPunches)));
    empty.hidden = today.activity.length > 0;
  };
  draw(await partnerApi().today().catch(() => ({ stamps: 0, rewardsUsed: 0, newDiners: 0, activity: [] })));

  const live = isLive(account);
  const tryTap = isDemo && live
    ? el('button', {
        class: 'button button-secondary', type: 'button',
        onclick: async () => {
          const { demo } = await import('../api/demo');
          const { next } = await demo.stamp(account.business!.id);
          // The diner's side opens in its own tab, as it would on their phone.
          window.open(next, '_blank', 'noopener');
        },
      }, 'Preview: a diner taps')
    : null;
  const card = preview(draftFrom(account));

  page(account, 'today',
    el('section', { class: 'hero' },
      el('p', { class: 'setup-kicker' }, longDate.format(new Date())),
      el('h1', { class: 'headline' }, `Today at ${account.business!.name}`)),
    live ? null : el('section', { class: 'block panel biz-alert', 'aria-labelledby': 'alert-title' },
      panelTitle('pin', 'Your card isn’t on a counter yet', 'alert-title'),
      el('p', { class: 'panel-note' }, 'Link a stand so diners can start collecting.'),
      el('a', { class: 'button button-primary', href: '/business/setup?step=stand' }, 'Link a stand')),
    el('div', { class: 'biz-split is-today' },
      el('div', {},
        stats,
        el('section', { class: 'block panel', 'aria-labelledby': 'till-title' },
          panelTitle('clock', 'Taps today', 'till-title'),
          empty,
          till,
          tryTap)),
      el('div', { class: 'biz-side' }, card.root, el('a', { class: 'button button-secondary', href: '/business/card' }, 'Edit card'))),
  );

  // Fresh numbers while the page is open and in view.
  const refresh = window.setInterval(async () => {
    if (!stats.isConnected) return window.clearInterval(refresh);
    if (document.visibilityState !== 'visible') return;
    const today = await partnerApi().today().catch(() => null);
    if (today) draw(today);
  }, 5000);
}

// ---------- Card ----------

export async function cardScreen() {
  const account = await signedIn('Opening your card…');
  if (!account) return;
  if (!account.program) {
    navigate('/business/setup', { replace: true });
    return;
  }
  const current = draftFrom(account);
  const card = preview(current);
  const error = el('p', { class: 'field-error', role: 'alert' });
  const publish = el('button', { class: 'button button-primary', type: 'button' }, 'Publish changes');
  publish.addEventListener('click', async () => {
    error.textContent = '';
    if (current.name.trim().length < 2 || current.location.trim().length < 2 || current.reward.trim().length < 2) {
      error.textContent = 'Fill in the name, where you are and the reward.';
      return;
    }
    const done = busy(publish, 'Publishing…');
    try {
      await partnerApi().saveBusiness({ name: current.name, category: current.category, location: current.location, address: current.address });
      const saved = await partnerApi().publishCard({ requiredPunches: current.punches, rewardDescription: current.reward, theme: current.theme });
      done();
      version.textContent = `Version ${saved.program!.version}, published just now.`;
      toast('Card published');
    } catch {
      done();
      error.textContent = 'Couldn’t publish. Check your connection and try again.';
    }
  });
  const version = el('p', { class: 'field-help' }, `Version ${account.program.version} is live.`);
  const rewardField = textField('Reward', current.reward, (value) => { current.reward = value; card.update(); }, { max: 50 });

  page(account, 'card',
    el('section', { class: 'hero' }, el('h1', { class: 'headline' }, 'Your card')),
    el('div', { class: 'biz-split is-desk' },
      el('div', { class: 'desk-form' },
        el('section', { class: 'block panel', 'aria-labelledby': 'place-title' },
          el('h2', { class: 'desk-title', id: 'place-title' }, 'Your place'),
          textField('Name', current.name, (value) => { current.name = value; card.update(); }, { autocomplete: 'organization' }),
          textField('What kind of place', current.category, (value) => { current.category = value; }, { max: 30 }),
          textField('Neighbourhood and city', current.location, (value) => { current.location = value; card.update(); }, { max: 60 }),
          textField('Street address', current.address, (value) => { current.address = value; }, { max: 100, autocomplete: 'street-address' })),
        el('section', { class: 'block panel', 'aria-labelledby': 'reward-title' },
          el('h2', { class: 'desk-title', id: 'reward-title' }, 'Reward'),
          rewardField,
          ideas(() => rewardField.querySelector('input'), (value) => { current.reward = value; card.update(); }),
          stepper('Stamps to earn it', current.punches, (value) => { current.punches = value; card.update(); })),
        el('section', { class: 'block panel', 'aria-labelledby': 'look-title' },
          el('h2', { class: 'desk-title', id: 'look-title' }, 'Look'),
          ...lookFields(current, () => card.update()))),
      el('div', { class: 'biz-side' },
        card.root,
        error,
        publish,
        version,
        el('p', { class: 'field-help' }, 'Diners see changes on their next visit. Cards already started keep the number of stamps they began with.'))),
  );
}

// ---------- Stands ----------

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(iso: string) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes > -60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

function standRow(stand: Stand, onTurnOff: (stand: Stand) => void) {
  const on = stand.status === 'active';
  return el('li', { class: `stand-row${on ? '' : ' is-off'}` },
    el('div', { class: 'stand-text' },
      el('span', { class: 'stand-name' }, stand.label),
      el('span', { class: 'stand-meta' },
        el('span', { class: 'stand-dot', 'aria-hidden': 'true' }),
        on ? (stand.lastTapAt ? `Working. Last tap ${ago(stand.lastTapAt)}` : 'Working. No taps yet') : 'Turned off')),
    on ? el('button', { class: 'button button-quiet stand-off', type: 'button', onclick: () => onTurnOff(stand) }, 'Turn off') : null);
}

export async function standsScreen() {
  const account = await signedIn('Opening your stands…');
  if (!account) return;
  if (!account.program) {
    navigate('/business/setup', { replace: true });
    return;
  }
  const list = el('ul', { class: 'stand-list' });
  const linkerSlot = el('div', {});
  const draw = (fresh: PartnerAccount) => {
    list.replaceChildren(...fresh.stands.map((stand) => standRow(stand, turnOff)));
  };
  const turnOff = (stand: Stand) => openSheet((close) => {
    const confirm = el('button', { class: 'button button-danger', type: 'button' }, 'Turn off stand');
    confirm.addEventListener('click', async () => {
      busy(confirm, 'Turning off…');
      try {
        draw(await partnerApi().turnOffStand(stand.standId));
        close();
        toast(`${stand.label} turned off`);
      } catch {
        close();
        notice('Couldn’t turn it off', 'Check your connection and try again.');
      }
    });
    return el('div', { class: 'sheet-body' },
      el('h2', { class: 'sheet-title' }, `Turn off ${stand.label.toLowerCase()}?`),
      el('p', { class: 'sheet-text' }, 'Taps on it will stop adding stamps. Do this if a stand is lost, stolen or broken. Diners keep every stamp they have.'),
      confirm,
      el('button', { class: 'button button-quiet', type: 'button', onclick: close, autofocus: true }, 'Keep it on'));
  }, 'Turn off stand');
  draw(account);

  const addButton = el('button', { class: 'button button-secondary', type: 'button' }, 'Link another stand');
  addButton.addEventListener('click', () => {
    addButton.hidden = true;
    linkerSlot.replaceChildren(standLinker(account, () => void standsScreen(), 'h2'));
  });

  page(account, 'stands',
    el('section', { class: 'hero' },
      el('h1', { class: 'headline' }, 'Stands'),
      el('p', { class: 'subline' }, 'Each stand stamps your card when a diner taps it.')),
    el('section', { class: 'block panel', 'aria-label': 'Your stands' },
      account.stands.length ? list : el('p', { class: 'panel-note' }, 'No stands linked yet.'),
      addButton,
      linkerSlot),
    el('section', { class: 'block panel', 'aria-labelledby': 'lost-title' },
      panelTitle('question', 'Lost a stand?', 'lost-title'),
      el('p', { class: 'panel-note' }, 'Turn it off here, so its taps stop stamping. Then write to us for a new one.')),
  );
}
