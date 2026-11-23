import type { CardState } from '../api';
import { announce, el, haptic, prefersReducedMotion } from './dom';
import { attachTilt, reinkStamps, sheen } from './motion';
import { project, rubberband, Spring, THROWN, token, VelocityTracker } from './spring';
import { INKS, initials, rotationOf, seedOf, stampLabel } from './stamp-style';
import { fontFor } from './theme';

// The passport page: each visit is its own rubber-stamp impression with the visit's date,
// in a rotating set of ink colours and stamp shapes. Pages always use the business's
// light paper and ink, like a physical page under any lighting.

const SHAPES = ['round', 'rect', 'oval'] as const;

export function pageStyle(state: CardState) {
  const { theme } = state.program;
  const font = fontFor(theme.typeface);
  return `--page-paper:${theme.lightPaper};--page-ink:${theme.lightInk};--page-font:${font};--card-paper:${theme.lightPaper};--card-ink:${theme.lightInk};--m-font:${font}`;
}

/** Visit dates for the stamps on the current card, oldest first. */
function stampDates(state: CardState) {
  const visits = state.recentVisits ?? [];
  const count = state.card.punches;
  return Array.from({ length: count }, (_, index) => visits[count - 1 - index]);
}

/** One visit's rubber-stamp impression: its shape, ink and angle come from the visit number and the place. */
export function inkStamp(index: number, seed: number, iso?: string) {
  const shape = SHAPES[(index + seed) % SHAPES.length];
  const ink = INKS[(index + seed) % INKS.length];
  const rotate = rotationOf(index, seed);
  return el(
    'span',
    { class: `ink-stamp is-${shape}`, style: `--ink:${ink};--rot:${rotate}deg;--grain-x:${(index * 47 + seed) % 140}px;--grain-y:${(index * 29 + seed * 3) % 140}px`, 'aria-hidden': 'true' },
    el('span', { class: 'ink-date' }, stampLabel(iso)),
    el('span', { class: 'ink-no' }, `NO. ${index + 1}`),
  );
}

function emptySlot(index: number, total: number) {
  return el('span', { class: 'ink-empty', 'aria-hidden': 'true' }, index === total - 1 ? 'Free' : String(index + 1));
}

interface PassportOptions {
  /** Show the "Just stamped" badge and outline (the page a tap just landed on). */
  justStamped?: boolean;
  /** Render only this many stamps at first, so the newest can be stamped in on arrival. */
  shown?: number;
}

export interface PassportView {
  root: HTMLElement;
  /**
   * Stamps visit `index` onto the page with a rubber-stamp press, tagged "New" (or `tag`). With
   * `arrived`, the stamp moment (stamp-moment.ts) already showed the blow: it just settles in.
   */
  stampIn(index: number, tag?: string, options?: { arrived?: boolean }): Promise<void>;
  /** The slot for visit `index`, for the stamp moment to fly into. */
  slot(index: number): HTMLElement | null;
  /** The card just filled up: the reward-earned moment. */
  celebrate(): Promise<void>;
}

function passportHead(state: CardState, options: { justStamped?: boolean; shown?: number } = {}) {
  const { business, card } = state;
  return el(
    'div',
    { class: 'passport-head' },
    el('span', { class: 'passport-mark', 'aria-hidden': 'true' }, initials(business.name)),
    el(
      'span',
      { class: 'passport-title' },
      el('span', { class: 'passport-name', translate: 'no' }, business.name),
      el('span', { class: 'passport-where' }, business.location),
      options.justStamped ? el('span', { class: 'badge-new' }, 'Just stamped') : null,
    ),
    el(
      'span',
      { class: 'passport-count' },
      el('span', { class: 'passport-label' }, 'Visits'),
      el('span', { class: 'passport-num' }, el('span', { class: 'passport-tick' }, String(options.shown ?? card.punches)), `/${card.requiredPunches}`),
    ),
  );
}

export function passportPage(state: CardState, options: PassportOptions = {}): PassportView {
  const { card, program, business } = state;
  const total = card.requiredPunches;
  const shown = options.shown ?? card.punches;
  const seed = seedOf(business.id);
  const dates = stampDates(state);

  const grid = el('div', {
    class: 'ink-grid',
    role: 'img',
    'aria-label': `${card.punches} of ${total} visits stamped`,
  });
  for (let index = 0; index < total; index += 1) {
    const slot = el('span', { class: 'ink-slot', 'data-index': index });
    if (index < shown) slot.append(inkStamp(index, seed, dates[index]));
    else slot.append(emptySlot(index, total));
    grid.append(slot);
  }

  // Until the newest stamp lands, the counts show the page as it was before this visit.
  const togoLabel = el('span', { class: 'passport-label' });
  const togoValue = el('span', { class: 'passport-togo' });
  const togo = el('p', { class: 'is-end' }, togoLabel, togoValue);
  const showTogo = (count: number) => {
    const full = count >= total;
    togoLabel.textContent = full ? 'Status' : 'To go';
    togoValue.textContent = full ? 'Full' : String(total - count);
  };
  showTogo(shown);
  const root = el(
    'article',
    {
      class: `passport${options.justStamped ? ' is-just-stamped' : ''}`,
      style: pageStyle(state),
      'aria-label': `${business.name} passport page`,
    },
    passportHead(state, { justStamped: options.justStamped, shown }),
    grid,
    el(
      'div',
      { class: 'passport-foot' },
      el('p', {}, el('span', { class: 'passport-label' }, `At ${total} visits`), el('span', { class: 'passport-reward' }, program.rewardDescription)),
      togo,
    ),
  );

  /** The counts in the corner and the foot roll over to the new number. */
  function tickCounts(count: number, pop = false) {
    const tick = root.querySelector<HTMLElement>('.passport-tick');
    if (tick) tick.textContent = String(count);
    showTogo(count);
    if (prefersReducedMotion()) return;
    for (const node of [tick, togoValue]) {
      node?.animate(
        [{ transform: 'translateY(60%)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 320, easing: token('--ease-out') },
      );
    }
    // A stamp landing also bumps the visit count, so the eye goes from the stamp to the number.
    if (pop) {
      root.querySelector('.passport-count')?.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.25)', offset: 0.3 }, { transform: 'scale(1)' }],
        { duration: 420, easing: token('--spring-lift') },
      );
    }
  }

  /**
   * Ink flecks thrown out from a slot, above the whole grid so no neighbouring stamp covers them.
   * `reach` scales how far they fly: a small spatter for one stamp, a burst for a full card.
   */
  function inkBurst(from: HTMLElement, inks: string[], flecks: number, reach: number) {
    const page = root.getBoundingClientRect();
    const origin = from.getBoundingClientRect();
    const burst = el('span', {
      class: 'ink-burst',
      'aria-hidden': 'true',
      style: `left:${origin.left - page.left + origin.width / 2}px;top:${origin.top - page.top + origin.height / 2}px`,
    });
    root.append(burst);
    const runs = Array.from({ length: flecks }, (_, index) => {
      const angle = (index / flecks) * Math.PI * 2 + (index % 2) * 0.25;
      const distance = (58 + ((index * 37) % 46)) * reach;
      const size = (8 + ((index * 5) % 8)) * (reach < 1 ? 0.6 : 1);
      const fleck = el('span', { class: 'ink-fleck', style: `--ink:${inks[index % inks.length]};--size:${size}px` });
      burst.append(fleck);
      return fleck.animate(
        [
          { transform: 'translate(0, 0) scale(0.4)', opacity: 1 },
          { transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(1)`, opacity: 1, offset: 0.6 },
          { transform: `translate(${Math.cos(angle) * distance * 1.15}px, ${Math.sin(angle) * distance * 1.15 + 10}px) scale(0.6)`, opacity: 0 },
        ],
        { duration: 760 + (index % 3) * 80, easing: token('--ease-out') },
      ).finished;
    });
    const done = Promise.race([Promise.all(runs), new Promise((resolve) => window.setTimeout(resolve, 1100))])
      .catch(() => undefined)
      .finally(() => burst.remove());
    return done;
  }

  const slotAt = (index: number) => grid.querySelector<HTMLElement>(`.ink-slot[data-index="${index}"]`);

  async function stampIn(index: number, tag = 'New', options: { arrived?: boolean } = {}) {
    const slot = slotAt(index);
    if (!slot) return;
    const mark = inkStamp(index, seed, dates[index]);
    slot.replaceChildren(mark);
    slot.classList.add('is-newest');
    slot.dataset.tag = tag;
    if (options.arrived) {
      // The stamp flew in from the moment: count it, and let the page give a little under it.
      tickCounts(index + 1, true);
      if (!prefersReducedMotion()) {
        root.animate(
          [{ transform: 'translateY(0)' }, { transform: 'translateY(4px) scale(0.992)', offset: 0.25 }, { transform: 'translateY(0)' }],
          { duration: 420, easing: token('--ease-out'), composite: 'add' },
        );
      }
      return;
    }
    if (prefersReducedMotion() || !program.theme.allowsMotion) {
      tickCounts(index + 1);
      haptic(14);
      return;
    }
    // The press: the stamp's shadow gathers under it as it comes down, big and out of focus and
    // picking up speed like a real hand stamp; it hits, squashes hard and settles on a spring.
    // Everything else (the buzz, the page giving, ink flecks and a ring spreading, the count
    // popping over, the wet ink drying) starts on the impact frame, so it all reads as one blow.
    const rot = rotationOf(index, seed);
    const DURATION = 720;
    const IMPACT = 0.4;
    const ink = mark.style.getPropertyValue('--ink');
    const shadow = el('span', { class: 'ink-shadow', 'aria-hidden': 'true' });
    slot.prepend(shadow);
    shadow
      .animate(
        [
          { transform: 'scale(1.9)', opacity: 0, easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
          { transform: 'scale(0.95)', opacity: 0.45, offset: IMPACT },
          { transform: 'scale(1)', opacity: 0 },
        ],
        { duration: DURATION },
      )
      .finished.catch(() => undefined)
      .finally(() => shadow.remove());
    const press = mark.animate(
      [
        { transform: `translateY(-44px) rotate(${rot - 16}deg) scale(2)`, opacity: 0, filter: 'blur(4px)', easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
        { transform: `translateY(0) rotate(${rot}deg) scale(0.8, 0.86)`, opacity: 1, filter: 'blur(0) saturate(1.6) brightness(0.8)', offset: IMPACT, easing: token('--spring-lift') },
        { transform: `rotate(${rot}deg) scale(1.06)`, filter: 'saturate(1.4) brightness(0.88)', offset: 0.62 },
        { transform: `rotate(${rot}deg) scale(1)`, opacity: 0.94, filter: 'saturate(1) brightness(1)' },
      ],
      { duration: DURATION + 360 },
    );
    window.setTimeout(() => {
      haptic([10, 24, 18]);
      tickCounts(index + 1, true);
      const splash = el('span', { class: 'ink-splash', style: `--ink:${ink}`, 'aria-hidden': 'true' });
      slot.append(splash);
      splash
        .animate([{ transform: 'scale(0.7)', opacity: 0.7 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: 560, easing: token('--ease-out') })
        .finished.catch(() => undefined)
        .finally(() => splash.remove());
      void inkBurst(slot, [ink], 7, 0.5);
      root.animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(6px) scale(0.988)', offset: 0.18 }, { transform: 'translateY(0)' }],
        { duration: 520, easing: token('--ease-out'), composite: 'add' },
      );
    }, DURATION * IMPACT);
    // A hidden tab gets no frames, so the animation may never finish: don't hold the page on it.
    await Promise.race([press.finished, new Promise((done) => window.setTimeout(done, DURATION + 120))]).catch(() => undefined);
  }

  /**
   * The card is full: every stamp on the page pulses once in a wave out from the last one, ink
   * flecks burst from it, and a ring of light runs round the page. It happens once per card, so
   * it can afford a moment.
   */
  async function celebrate() {
    haptic([18, 50, 28]);
    if (prefersReducedMotion() || !program.theme.allowsMotion) return;
    const slots = [...grid.querySelectorAll<HTMLElement>('.ink-slot')];
    const last = slots[card.punches - 1];
    if (!last) return;
    const origin = last.getBoundingClientRect();
    for (const slot of slots) {
      const stamp = slot.querySelector<HTMLElement>('.ink-stamp');
      if (!stamp) continue;
      const box = slot.getBoundingClientRect();
      const distance = Math.hypot(box.left - origin.left, box.top - origin.top);
      const rot = getComputedStyle(stamp).getPropertyValue('--rot').trim() || '0deg';
      stamp.animate(
        [{ transform: `rotate(${rot}) scale(1)` }, { transform: `rotate(${rot}) scale(1.12)`, offset: 0.35 }, { transform: `rotate(${rot}) scale(1)` }],
        { duration: 520, delay: distance * 0.9, easing: token('--ease-out') },
      );
    }
    // Ink flecks, in the page's own stamp inks.
    const runs = inkBurst(last, INKS.map((_, index) => INKS[(index + seed) % INKS.length]), 16, 1);
    const ring = el('span', { class: 'passport-ring', 'aria-hidden': 'true' });
    root.append(ring);
    const glow = ring.animate(
      [
        { opacity: 0, transform: 'scale(0.98)', easing: token('--ease-out') },
        { opacity: 1, transform: 'scale(1)', offset: 0.25, easing: 'ease-in-out' },
        { opacity: 0, transform: 'scale(1.01)' },
      ],
      { duration: 1000 },
    ).finished;
    await Promise.race([Promise.all([runs, glow]), new Promise((done) => window.setTimeout(done, 1100))]).catch(() => undefined);
    ring.remove();
  }

  return { root, stampIn, celebrate, slot: slotAt };
}

/**
 * The "Your cards" wallet, with Apple Wallet's motion: the cards sit in an overlapping list;
 * tap one and it slides up to the top and opens while the others slide down and fade away;
 * "All cards" slides them all back. Press and hold a card in the list to drag it to a new
 * place, or use "Edit order" for move up / move down buttons.
 */
export function passportStack(
  states: CardState[],
  options: {
    open?: string;
    details?: (state: CardState) => Node;
    /**
     * Called when a card opens or the list comes back. `instant` is true for the first layout, so
     * the page can set things up without animating.
     */
    onOpenChange?: (open: boolean, instant: boolean) => void;
    /** Called with the business IDs in their new order after the diner moves a card. */
    onReorder?: (businessIds: string[]) => void;
  },
) {
  const PEEK = 70; // how much of each card shows in the list
  const HOLD_MS = 380; // press-and-hold before a card lifts for dragging

  const wallet = el('div', { class: 'wallet' });
  const hint = el('p', { class: 'stack-hint', 'aria-live': 'polite' });
  const detailsSlot = el('div', { class: 'wallet-details' });
  const back = el('button', { class: 'wallet-back', type: 'button', hidden: true }, 'All cards');
  const edit = el('button', { class: 'wallet-edit', type: 'button', 'aria-pressed': 'false', hidden: states.length < 2 }, 'Edit order');
  back.addEventListener('click', () => {
    const was = selected;
    selected = undefined;
    layout();
    cards.find((entry) => entry.id === was)?.hit.focus({ preventScroll: true });
  });
  let editing = false;
  edit.addEventListener('click', () => {
    editing = !editing;
    edit.textContent = editing ? 'Done' : 'Edit order';
    edit.setAttribute('aria-pressed', String(editing));
    layout();
  });
  const wrap = el('div', { class: 'wallet-wrap' }, el('div', { class: 'wallet-toolbar' }, back, edit), wallet, hint, detailsSlot);
  let selected = states.some((state) => state.business.id === options.open) ? options.open : undefined;
  let wasOpen = false;
  let firstLayout = true;
  let swiping = false;
  let touching = false;

  type Entry = {
    id: string;
    name: string;
    state: CardState;
    card: HTMLElement;
    hit: HTMLButtonElement;
    up: HTMLButtonElement;
    down: HTMLButtonElement;
    justDragged: boolean;
    /** Sideways offset while swiping between open cards (0 otherwise). */
    x: Spring;
    /** Swiped away: stays level with the open card while it slides off sideways. */
    leaving: boolean;
  };

  const commit = () => options.onReorder?.(cards.map((entry) => entry.id));

  function move(entry: Entry, delta: number) {
    const from = cards.indexOf(entry);
    const to = from + delta;
    if (to < 0 || to >= cards.length) return;
    cards.splice(from, 1);
    cards.splice(to, 0, entry);
    layout();
    commit();
    announce(`${entry.name} moved to position ${to + 1} of ${cards.length}`);
    // Keep focus on the same control so repeated presses keep moving the same card.
    (delta < 0 && to > 0 ? entry.up : to < cards.length - 1 ? entry.down : entry.up).focus({ preventScroll: true });
  }

  const cards: Entry[] = states.map((state) => {
    const page = passportPage(state);
    const card = page.root;
    card.classList.add('wallet-card');
    const name = state.business.name;
    const hit = el('button', { class: 'wallet-hit', type: 'button' });
    const up = el('button', { class: 'reorder-button is-up', type: 'button', 'aria-label': `Move ${name} up` });
    const down = el('button', { class: 'reorder-button is-down', type: 'button', 'aria-label': `Move ${name} down` });
    const entry = { id: state.business.id, name, state, card, hit, up, down, justDragged: false, leaving: false } as Entry;
    entry.x = new Spring(0, () => entry.card.style.transform = transformFor(entry));
    up.addEventListener('click', () => move(entry, -1));
    down.addEventListener('click', () => move(entry, 1));
    hit.addEventListener('click', () => {
      if (entry.justDragged || editing) {
        entry.justDragged = false;
        return;
      }
      openCard(state.business.id);
    });
    card.append(el('div', { class: 'reorder-controls' }, up, down), hit);
    // Only the open card tilts (with a mouse, or a finger when there's nothing to swipe to); in
    // the list a press means "open" or "hold to move".
    enableSwipe(entry);
    attachTilt(card, () => card.classList.contains('is-open') && !swiping && (cards.length < 2 || !touching));
    enableDrag(entry);
    wallet.append(card);
    return entry;
  });

  /** Opens a card where it is: it slides to the top and the rest drop away. */
  function openCard(id: string) {
    selected = id;
    layout();
    back.focus({ preventScroll: true });
    // The opened card may now sit above the screen (a long wallet, or switching from the bottom of
    // another card's details): follow it up.
    if (back.getBoundingClientRect().top < 0) {
      back.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }

  // "Your other cards" under an open card switch cards right here, instead of loading the page again.
  detailsSlot.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="/c?open="]');
    const id = link && new URL(link.href).searchParams.get('open');
    if (!id || !cards.some((entry) => entry.id === id)) return;
    event.preventDefault();
    event.stopPropagation();
    openCard(id);
  });

  /** Press and hold, then drag: the card lifts, follows the finger, and the others make room. */
  function enableDrag(entry: Entry) {
    let timer: number | undefined;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseY = 0;
    const cancelHold = () => window.clearTimeout(timer);

    entry.hit.addEventListener('pointerdown', (event) => {
      if (selected || cards.length < 2) return;
      startX = event.clientX;
      startY = event.clientY;
      const pointerId = event.pointerId;
      timer = window.setTimeout(() => {
        dragging = true;
        baseY = cards.indexOf(entry) * PEEK;
        try {
          entry.hit.setPointerCapture(pointerId);
        } catch {
          /* The pointer already ended; the drag still follows pointermove on the button. */
        }
        wallet.classList.add('is-reordering');
        entry.card.classList.add('is-lifted');
        entry.card.style.zIndex = '200';
        haptic(15);
        hint.textContent = 'Drag to move, then let go';
      }, HOLD_MS);
    });

    entry.hit.addEventListener('pointermove', (event) => {
      if (!dragging) {
        // Moving before the hold completes means scrolling, not dragging.
        if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) cancelHold();
        return;
      }
      const y = baseY + (event.clientY - startY);
      entry.card.style.transform = `translateY(${y}px) perspective(1100px) rotateX(2deg) scale(1.035)`;
      const target = Math.max(0, Math.min(cards.length - 1, Math.round(y / PEEK)));
      const current = cards.indexOf(entry);
      if (target !== current) {
        cards.splice(current, 1);
        cards.splice(target, 0, entry);
        layout(entry);
        haptic(6);
      }
    });

    const finish = () => {
      cancelHold();
      if (!dragging) return;
      dragging = false;
      entry.justDragged = true;
      wallet.classList.remove('is-reordering');
      entry.card.classList.remove('is-lifted');
      layout();
      commit();
      announce(`${entry.name} moved to position ${cards.indexOf(entry) + 1} of ${cards.length}`);
      // A click follows pointerup on the same button; let it pass if no click comes.
      window.setTimeout(() => (entry.justDragged = false), 400);
    };
    entry.hit.addEventListener('pointerup', finish);
    entry.hit.addEventListener('pointercancel', finish);
  }

  // While a card is lifted, the page must not scroll under the finger.
  wallet.addEventListener(
    'touchmove',
    (event) => {
      if (wallet.classList.contains('is-reordering')) event.preventDefault();
    },
    { passive: false },
  );

  const poses = new WeakMap<Entry, { y: number; lean: number; scale: number }>();
  function transformFor(entry: Entry) {
    const pose = poses.get(entry) ?? { y: 0, lean: 0, scale: 1 };
    const x = entry.x.value;
    // Swiping, the card turns a touch toward where it's going (never more than 2.5°).
    const turn = x ? ` rotate(${Math.max(-2.5, Math.min(2.5, x / 60)).toFixed(2)}deg)` : '';
    return `translate3d(${x.toFixed(2)}px, ${pose.y}px, 0)${turn} perspective(1100px) rotateX(calc(${pose.lean}deg + var(--tx, 0deg))) rotateY(var(--ty, 0deg)) scale(${pose.scale})`;
  }

  function place(entry: Entry, y: number, z: number, state: 'list' | 'open' | 'away', delay = 0) {
    entry.card.style.setProperty('--delay', `${delay}ms`);
    // In the list, cards lean back a little, like passes standing in a stack, a touch smaller so
    // the leaning bottom edge never pokes past the page. A card on its own, or open, lies flat
    // and follows your finger (--tx/--ty from attachTilt).
    const leaning = state === 'list' && cards.length > 1;
    poses.set(entry, {
      y: entry.leaving ? 0 : y,
      lean: leaning ? 7 : 0,
      scale: state === 'away' && !entry.leaving ? 0.94 : leaning ? 0.97 : 1,
    });
    entry.card.style.transform = transformFor(entry);
    entry.card.style.zIndex = String(z);
    entry.card.classList.toggle('is-open', state === 'open');
    entry.card.classList.toggle('is-away', state === 'away');
    entry.card.toggleAttribute('inert', state === 'away');
    entry.hit.hidden = state !== 'list' || editing;
    entry.hit.setAttribute('aria-label', `Open ${entry.name}`);
  }

  /**
   * Swipe sideways on the open card to go to the next or previous one, like passes in Wallet.
   * The card follows your finger 1:1 (resisting at the first and last card); let go and a flick
   * or a pull past a third of the way carries it off at your finger's speed while the next card
   * slides in from the other side. Anything less springs it back. A card still sliding can be
   * caught and thrown again.
   */
  function enableSwipe(entry: Entry) {
    const tracker = new VelocityTracker();
    let pointer: number | undefined;
    let startX = 0;
    let startY = 0;
    let base = 0;
    let decided = false;
    entry.card.addEventListener('pointerdown', (event) => {
      if (selected !== entry.id || cards.length < 2 || event.button !== 0) return;
      touching = event.pointerType !== 'mouse';
      if ((event.target as Element).closest('button, a')) return;
      pointer = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      tracker.reset();
      tracker.add(event);
      entry.x.stop();
      base = entry.x.value;
      // Caught mid-slide: it's already a swipe.
      decided = base !== 0;
      if (decided) beginSwipe(event);
    });
    const beginSwipe = (event: PointerEvent) => {
      swiping = true;
      entry.card.classList.add('is-swiping');
      entry.card.classList.remove('is-tilting');
      entry.card.style.setProperty('--tx', '0deg');
      entry.card.style.setProperty('--ty', '0deg');
      try {
        entry.card.setPointerCapture(event.pointerId);
      } catch {
        /* The pointer already ended. */
      }
    };
    entry.card.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointer) return;
      tracker.add(event);
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!decided) {
        if (Math.hypot(dx, dy) < 10) return;
        // Mostly vertical: that's a scroll, let the page have it.
        if (Math.abs(dx) < Math.abs(dy) * 1.2) {
          pointer = undefined;
          return;
        }
        decided = true;
        startX = event.clientX;
        beginSwipe(event);
        return;
      }
      const index = cards.indexOf(entry);
      let x = base + (event.clientX - startX);
      // No card that way: it gives a little and resists.
      if ((x > 0 && index === 0) || (x < 0 && index === cards.length - 1)) x = rubberband(x, entry.card.offsetWidth);
      entry.x.set(x);
      // The card you're heading for slides in alongside, so you can see where the swipe goes.
      const step = x < 0 ? 1 : -1;
      peek(cards[index + step], x + step * (entry.card.offsetWidth + GAP));
    });
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = undefined;
      if (!decided) return;
      decided = false;
      const velocity = tracker.velocity().x;
      const width = entry.card.offsetWidth;
      const landing = entry.x.value + project(velocity);
      const step = landing < 0 ? 1 : -1;
      const target = cards[cards.indexOf(entry) + step];
      if (target && (Math.abs(landing) > width / 3 || Math.abs(velocity) > 600)) {
        swipeTo(entry, target, step, velocity);
      } else {
        void entry.x.to(0, THROWN, velocity).then(() => settle(entry));
        const neighbour = peeked;
        if (neighbour) {
          const away = Math.sign(neighbour.x.value) * (width + GAP);
          void neighbour.x.to(away, THROWN, velocity).then((done) => done && unpeek(neighbour));
        }
      }
    };
    entry.card.addEventListener('pointerup', release);
    entry.card.addEventListener('pointercancel', release);
  }

  function settle(entry: Entry) {
    if (entry.x.value !== 0) return;
    entry.card.classList.remove('is-swiping');
    swiping = cards.some((other) => other.card.classList.contains('is-swiping'));
  }

  const GAP = 16;
  let peeked: Entry | undefined;

  /** Shows `entry` level with the open card, `x` pixels to the side (or hides the last one). */
  function peek(entry: Entry | undefined, x: number) {
    if (peeked && peeked !== entry) unpeek(peeked);
    if (!entry) return;
    if (peeked !== entry) {
      peeked = entry;
      entry.leaving = true;
      entry.card.classList.add('is-swiping', 'is-peeking');
      place(entry, 0, 99, 'away');
    }
    entry.x.set(x);
  }

  function unpeek(entry: Entry) {
    if (peeked === entry) peeked = undefined;
    entry.leaving = false;
    entry.x.set(0);
    entry.card.classList.remove('is-peeking', 'is-swiping');
    layout();
  }

  function swipeTo(from: Entry, to: Entry, step: number, velocity: number) {
    const width = from.card.offsetWidth + GAP;
    // The old card keeps its speed and slides off, fading as it goes...
    from.leaving = true;
    // ...while the new one, already alongside, carries on in at the same speed.
    if (peeked !== to) {
      if (peeked) unpeek(peeked);
      to.x.set(step * width);
    }
    peeked = undefined;
    to.leaving = false;
    to.card.classList.remove('is-peeking');
    to.card.classList.add('is-swiping');
    selected = to.id;
    layout();
    haptic(8);
    announce(`${to.name} is open`);
    void from.x.to(-step * width, THROWN, velocity).then(() => {
      from.leaving = false;
      from.x.set(0);
      settle(from);
      layout();
    });
    void to.x.to(0, THROWN, velocity).then(() => settle(to));
  }

  /** Lays the wallet out. While dragging, `lifted` follows the finger and is left alone. */
  function layout(lifted?: Entry) {
    // Keep the open card in the address (/c?open=ferrous), so a reload, a shared link and the
    // demo's Add a stamp all know which card is showing.
    if (Boolean(selected) !== wasOpen) {
      wasOpen = Boolean(selected);
      options.onOpenChange?.(wasOpen, firstLayout);
    }
    firstLayout = false;
    if (window.location.pathname === '/c') {
      const url = new URL(window.location.href);
      if (selected) url.searchParams.set('open', selected);
      else url.searchParams.delete('open');
      if (url.href !== window.location.href) history.replaceState(history.state, '', url);
    }
    const heights = cards.map((entry) => entry.card.offsetHeight);
    wallet.classList.toggle('has-open', Boolean(selected));
    wallet.classList.toggle('is-editing', editing && !selected);
    back.hidden = !selected || cards.length < 2;
    edit.hidden = Boolean(selected) || cards.length < 2;
    if (!selected) {
      // Cards ripple back into the list from the top, one after another.
      cards.forEach((entry, index) => {
        entry.up.disabled = index === 0;
        entry.down.disabled = index === cards.length - 1;
        if (entry !== lifted) place(entry, index * PEEK, index + 1, 'list', lifted ? 0 : index * 45);
      });
      wallet.style.height = `${(cards.length - 1) * PEEK + (heights[cards.indexOf(cards.at(-1)!)] ?? 0)}px`;
      if (!lifted) {
        hint.textContent = editing
          ? 'Use the arrows, or press and hold a card and drag it'
          : cards.length > 1 ? 'Tap a card to open it. Press and hold to move it.' : '';
      }
      detailsSlot.replaceChildren();
      delete detailsSlot.dataset.for;
      delete wrap.dataset.open;
      return;
    }
    // The open card slides to the top; every other card drops away out of sight.
    const openIndex = cards.findIndex((entry) => entry.id === selected);
    const openHeight = heights[openIndex];
    // The others drop away in a quick cascade, nearest the open card first.
    cards.forEach((entry, index) => {
      if (index === openIndex) place(entry, 0, 100, 'open');
      else place(entry, openHeight + 40 + index * 8, index + 1, 'away', Math.abs(index - openIndex) * 35);
    });
    wallet.style.height = `${openHeight}px`;
    hint.textContent = cards.length > 1 ? 'Swipe sideways for your other cards' : `${cards[openIndex].name} is open`;
    const state = cards[openIndex].state;
    if (wrap.dataset.open !== state.business.id) {
      wrap.dataset.open = state.business.id;
      wrap.style.setProperty('--page-paper', state.program.theme.lightPaper);
      sheen(cards[openIndex].card, 380);
      reinkStamps(cards[openIndex].card, 300);
    }
    if (options.details && detailsSlot.dataset.for !== state.business.id) {
      detailsSlot.dataset.for = state.business.id;
      detailsSlot.replaceChildren(options.details(state));
    }
  }

  // Deal the cards in once they're on the page (heights need the real width): each starts a
  // little low and invisible, then rises into place one after another.
  // A page opened in a background tab gets no frames until it's shown, so lay it out straight
  // away there instead of waiting on an animation nobody can see.
  const hidden = document.visibilityState === 'hidden';
  const nextFrame = (fn: () => void) => (hidden ? window.setTimeout(fn, 0) : requestAnimationFrame(fn));
  const dealIn = !prefersReducedMotion() && !selected && !hidden;
  if (dealIn) wallet.classList.add('is-dealing');
  nextFrame(() => {
    if (dealIn) cards.forEach((entry, index) => (entry.card.style.transform = `translateY(${index * PEEK + 90}px)`));
    else layout();
    nextFrame(() => {
      wallet.classList.add('is-ready');
      if (dealIn) {
        wallet.classList.remove('is-dealing');
        layout();
        cards.forEach((entry, index) => entry.card.style.setProperty('--delay', `${index * 70}ms`));
      }
    });
  });
  // Re-measure when the width changes (rotation, resizing); card heights depend on it.
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width !== lastWidth) {
      lastWidth = width;
      layout();
    }
  }).observe(wallet);
  wallet.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selected) {
      selected = undefined;
      layout();
    }
  });

  return wrap;
}
