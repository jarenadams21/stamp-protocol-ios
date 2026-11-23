import '../styles/business.css';
import { navigate } from '../router';
import { loading, mount } from '../screens/shared';
import { notice, openSheet, toast } from '../ui/components';
import { announce, busy, countdown, el, haptic } from '../ui/dom';
import { icon, panelTitle } from '../ui/icons';
import { logoMark } from '../ui/sections';
import { clearMerchantTheme } from '../ui/theme';
import { createPartnerApi, PartnerError, type Activity, type Dashboard, type LiveProgram, type PartnerApi, type PartnerBusiness, type Stand, type Stands } from './api';
import { draftFrom, ideas, LIMITS, lookFields, preview, programInput, stepper, textField, type Draft } from './card-form';

// The business site: /business and below. An owner signs in with their email, makes their card in
// four steps (place, reward, look, stand), then lands on Today. Loaded on its own (main.ts imports
// it lazily), so diners never download it. Talks to the shared API through ./api.ts.

const isDemo = import.meta.env.VITE_MODE === 'demo';
/** The development API (AUTH_MODE=dev) and the demo both answer /v1/dev/stands/touch; prod has no such route. */
const canTouchStand = isDemo || import.meta.env.DEV;
let api: PartnerApi | undefined;
const partnerApi = () => (api ??= createPartnerApi());

type Section = 'today' | 'card' | 'stands';

/** What the owner has set up so far. */
interface Account extends Stands {
  business: PartnerBusiness | null;
  program: LiveProgram | null;
}

const isLive = (account: Account) => Boolean(account.program && account.stands.some((stand) => stand.status === 'active'));
const homeFor = (account: Account) => (account.program ? '/business/today' : '/business/setup');
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The API's own words for a refused change, or a connection hint when there was no answer. */
const problemText = (problem: unknown, fallback: string) =>
  problem instanceof PartnerError && problem.status >= 400 && problem.status < 500 ? problem.message : fallback;

/** The signed-in owner's account, or null when this browser has no session (or it ended). */
async function loadAccount(): Promise<Account | null> {
  const partner = partnerApi();
  if (!partner.hasSession()) return null;
  try {
    const business = await partner.business();
    if (!business) return { business, program: null, stands: [], pairing: null };
    const [program, stands] = await Promise.all([partner.program(), partner.stands()]);
    return { business, program, ...stands };
  } catch (problem) {
    if (problem instanceof PartnerError && problem.status === 401) return null;
    throw problem;
  }
}

// ---------- Frame ----------

function bizHeader(account: Account | null, current?: Section) {
  const signOut = el('button', { class: 'biz-signout', type: 'button' }, 'Sign out');
  signOut.addEventListener('click', async () => {
    busy(signOut, 'Signing out…');
    forgetDraft();
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

function page(account: Account | null, current: Section | undefined, ...children: (Node | null)[]) {
  clearMerchantTheme();
  mount(el('main', { class: `page page-business${current ? ` is-${current}` : ''}` }, bizHeader(account, current), ...children, bizFooter()));
}

/** The signed-in account, or a trip to sign-in. */
async function signedIn(label: string) {
  try {
    const account = await loading(loadAccount(), label);
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
  const account = await loadAccount().catch(() => null);
  if (account) {
    navigate(homeFor(account), { replace: true });
    return;
  }
  const sample = draftFrom(null, null);
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
  const existing = await loadAccount().catch(() => null);
  if (existing) {
    navigate(homeFor(existing), { replace: true });
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
    const address = email.value.trim();
    try {
      await partnerApi().startEmail(address);
      codeStep(form, address);
    } catch (problem) {
      done();
      error.textContent = problem instanceof PartnerError && problem.code === 'invalidEmail'
        ? 'That doesn’t look like an email. Check it and try again.'
        : problemText(problem, 'Couldn’t send the code. Check your connection.');
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

function codeStep(form: HTMLFormElement, address: string) {
  const error = el('p', { class: 'field-error', role: 'alert' });
  const code = el('input', { class: 'field-input is-code', id: 'biz-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*' });
  const verify = el('button', { class: 'button button-primary', type: 'submit' }, 'Sign in');
  const next = el('form', { class: 'biz-form', novalidate: true },
    el('label', { class: 'field-label', for: 'biz-code' }, `Code sent to ${address}`),
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
      await partnerApi().verifyEmail(address, code.value.replace(/\D/g, ''));
      forgetDraft();
      announce('Signed in.');
      const account = await loadAccount().catch(() => null);
      navigate(account ? homeFor(account) : '/business/setup', { replace: true });
    } catch (problem) {
      done();
      error.textContent = problem instanceof PartnerError && problem.code === 'invalidCode'
        ? 'That code doesn’t match. Check the email and try again.'
        : problemText(problem, 'Couldn’t sign in. Try again.');
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
// starts again at every sign-in and sign-out. Nothing in it is secret: it becomes the public card.
const DRAFT_KEY = 'joeyy-business-draft';
let draft: Draft | undefined;

function restoreDraft() {
  try {
    return (JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null) ?? undefined;
  } catch {
    return undefined;
  }
}

function keepDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* Private mode or storage off: the draft lasts until the tab reloads. */
  }
}

function forgetDraft() {
  draft = undefined;
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* Nothing kept. */
  }
}

function progress(current: StepId, account: Account) {
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
  draft ??= restoreDraft() ?? draftFrom(account.business, account.program);
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
      textField('Name', current.name, (value) => { current.name = value; card.update(); }, { max: LIMITS.name, autocomplete: 'organization', placeholder: 'Ferrous Coffee' }),
      textField('Neighbourhood and city', current.location, (value) => { current.location = value; card.update(); }, { max: LIMITS.location, placeholder: 'Belltown, Seattle' }),
    ];
    next.addEventListener('click', async () => {
      if (!current.name.trim()) {
        error.textContent = 'Add your place’s name.';
        return;
      }
      const done = busy(next, 'Saving…');
      try {
        await saveBusiness(account, current);
        navigate('/business/setup?step=reward');
      } catch (problem) {
        done();
        error.textContent = problemText(problem, 'Couldn’t save. Check your connection and try again.');
      }
    });
  } else if (step === 'reward') {
    question = 'What do regulars get?';
    lede = 'Something you’d be glad to hand over. Keep it short: it’s printed on the card.';
    const rewardField = textField('Reward', current.reward, (value) => { current.reward = value; card.update(); }, { max: LIMITS.reward, placeholder: 'A free coffee' });
    fields = [
      rewardField,
      ideas(() => rewardField.querySelector('input'), (value) => { current.reward = value; card.update(); }),
      stepper('Stamps to earn it', current.punches, (value) => { current.punches = value; card.update(); }),
    ];
    next.addEventListener('click', () => {
      if (!current.reward.trim()) {
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
        // Null means it matches the live card already: nothing to publish, carry on.
        await partnerApi().publish(programInput(current));
        // Published: the server's copy is the card now.
        forgetDraft();
        haptic([10, 40, 14]);
        navigate('/business/setup?step=stand');
      } catch (problem) {
        done();
        error.textContent = problemText(problem, 'Couldn’t publish. Check your connection and try again.');
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

/** Saves the place's name and location. The time zone is the browser's at first, then kept as it is. */
function saveBusiness(account: Account, current: Draft) {
  return partnerApi().saveBusiness({
    name: current.name.trim(),
    location: current.location.trim(),
    timeZone: account.business?.timeZone ?? browserTimeZone(),
  });
}

// ---------- Linking a stand ----------

/**
 * Opens a two-minute linking window, then waits for the owner's phone to touch a stand from their
 * kit. The server links the first unlinked stand tapped by this signed-in owner while it's open.
 */
function standLinker(account: Account, onDone: () => void, heading: 'h1' | 'h2' = 'h1') {
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
        if (!opened.pairing) throw new PartnerError(500, 'server', 'Linking didn’t open.');
        waiting(Date.parse(opened.pairing.expiresAt));
      } catch (problem) {
        done();
        notice('Couldn’t start linking', problemText(problem, 'Check your connection and try again.'));
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
    const simulate = canTouchStand
      ? el('button', {
          class: 'button button-secondary', type: 'button',
          onclick: async () => {
            // Stands in for the owner's phone touching a new stand from their kit.
            await partnerApi().request('POST', '/v1/dev/stands/touch').catch(() => undefined);
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
      const fresh = await partnerApi().stands().catch(() => null);
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

function activityLine(item: Activity, required: number) {
  // An earned stamp fills its card, so its number is that card's size (older versions may differ).
  const filled = item.punches ?? required;
  const what = {
    first: 'First visit: stamp 1',
    stamp: item.punches ? `Stamp ${item.punches} of ${required}` : 'Stamp',
    earned: `Stamp ${filled} of ${filled}: reward earned`,
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
  const business = account.business!;
  const stats = el('div', { class: 'biz-figures', 'aria-live': 'polite' });
  const till = el('ol', { class: 'till' });
  const empty = el('p', { class: 'panel-note till-empty' }, 'No taps yet today. When a diner taps your stand, it shows up here.');
  const draw = (figures: Dashboard, activity: Activity[]) => {
    stats.replaceChildren(
      figure(figures.punches, figures.punches === 1 ? 'stamp' : 'stamps'),
      figure(figures.rewardsEarned, figures.rewardsEarned === 1 ? 'reward earned' : 'rewards earned'),
      figure(figures.rewardsRedeemed, figures.rewardsRedeemed === 1 ? 'reward used' : 'rewards used'));
    till.replaceChildren(...activity.map((item) => activityLine(item, program.requiredPunches)));
    empty.hidden = activity.length > 0;
  };
  /** Today in this browser's time zone, as UTC instants: midnight to the next midnight. */
  const fetchToday = () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return Promise.all([partnerApi().dashboard(from, to), partnerApi().activity(from, to)]);
  };
  const first = await fetchToday().catch(() => null);
  if (first) draw(...first);

  const live = isLive(account);
  const tryTap = isDemo && live
    ? el('button', {
        class: 'button button-secondary', type: 'button',
        onclick: async () => {
          const { demo } = await import('../api/demo');
          const { next } = await demo.stamp(business.id);
          // The diner's side opens in its own tab, as it would on their phone.
          window.open(next, '_blank', 'noopener');
        },
      }, 'Preview: a diner taps')
    : null;
  const card = preview(draftFrom(business, program));

  page(account, 'today',
    el('section', { class: 'hero' },
      el('p', { class: 'setup-kicker' }, longDate.format(new Date())),
      el('h1', { class: 'headline' }, `Today at ${business.name}`)),
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
    const fresh = await fetchToday().catch(() => null);
    if (fresh) draw(...fresh);
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
  const current = draftFrom(account.business, account.program);
  let savedPlace = { name: current.name, location: current.location };
  const card = preview(current);
  const error = el('p', { class: 'field-error', role: 'alert' });
  const publish = el('button', { class: 'button button-primary', type: 'button' }, 'Publish changes');
  publish.addEventListener('click', async () => {
    error.textContent = '';
    if (!current.name.trim() || !current.reward.trim()) {
      error.textContent = 'Fill in the name and the reward.';
      return;
    }
    const done = busy(publish, 'Publishing…');
    try {
      const place = { name: current.name.trim(), location: current.location.trim() };
      const placeChanged = place.name !== savedPlace.name || place.location !== savedPlace.location;
      if (placeChanged) {
        await saveBusiness(account, current);
        savedPlace = place;
      }
      const published = await partnerApi().publish(programInput(current));
      done();
      if (published) {
        version.textContent = `Version ${published.version}, published just now.`;
        toast('Card published');
      } else {
        toast(placeChanged ? 'Place saved' : 'Nothing changed');
      }
    } catch (problem) {
      done();
      error.textContent = problemText(problem, 'Couldn’t publish. Check your connection and try again.');
    }
  });
  const version = el('p', { class: 'field-help' }, `Version ${account.program.version} is live.`);
  const rewardField = textField('Reward', current.reward, (value) => { current.reward = value; card.update(); }, { max: LIMITS.reward });

  page(account, 'card',
    el('section', { class: 'hero' }, el('h1', { class: 'headline' }, 'Your card')),
    el('div', { class: 'biz-split is-desk' },
      el('div', { class: 'desk-form' },
        el('section', { class: 'block panel', 'aria-labelledby': 'place-title' },
          el('h2', { class: 'desk-title', id: 'place-title' }, 'Your place'),
          textField('Name', current.name, (value) => { current.name = value; card.update(); }, { max: LIMITS.name, autocomplete: 'organization' }),
          textField('Neighbourhood and city', current.location, (value) => { current.location = value; card.update(); }, { max: LIMITS.location })),
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
  const draw = (fresh: Stands) => {
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
      } catch (problem) {
        close();
        notice('Couldn’t turn it off', problemText(problem, 'Check your connection and try again.'));
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
