import { prefersReducedMotion } from './dom';
import { token } from './spring';

// Shared motion: tilt with a moving sheen, stamps re-inking in sequence, the page's entrance,
// and sections easing in as they scroll into view. Movement is off with Reduce Motion; the
// entrance becomes a plain fade.

/**
 * Drag (or hover with a mouse) to tilt a card toward your finger, with a light sheen that
 * follows it. Writes --tx, --ty, --shine-x and --shine-y; the card's CSS transform reads them,
 * so the tilt composes with whatever else positions the card.
 */
export function attachTilt(card: HTMLElement, enabled: () => boolean = () => true) {
  if (prefersReducedMotion()) return;
  let active = false;
  // Measured once as a gesture starts, not on every move.
  let box: DOMRect | undefined;
  const measure = () => (box = card.getBoundingClientRect());
  const move = (event: PointerEvent) => {
    if (!enabled()) return;
    if (!active && event.pointerType !== 'mouse') return;
    box ??= measure();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    card.style.setProperty('--tx', `${(-y * 9).toFixed(2)}deg`);
    card.style.setProperty('--ty', `${(x * 11).toFixed(2)}deg`);
    card.style.setProperty('--shine-x', `${((x + 0.5) * 100).toFixed(1)}%`);
    card.style.setProperty('--shine-y', `${((y + 0.5) * 100).toFixed(1)}%`);
    card.classList.add('is-tilting');
  };
  const release = () => {
    active = false;
    box = undefined;
    card.classList.remove('is-tilting');
    card.style.setProperty('--tx', '0deg');
    card.style.setProperty('--ty', '0deg');
  };
  card.addEventListener('pointerdown', (event) => {
    active = true;
    measure();
    move(event);
  });
  card.addEventListener('pointermove', move);
  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', release);
  card.addEventListener('pointerleave', release);
}

/** A band of light sweeps once across the card, like a pass catching the light as it lifts. */
export function sheen(card: HTMLElement, delay = 0) {
  if (prefersReducedMotion()) return;
  const band = document.createElement('span');
  band.className = 'sheen';
  band.setAttribute('aria-hidden', 'true');
  card.append(band);
  band
    .animate(
      [{ transform: 'translateX(-120%) skewX(-18deg)' }, { transform: 'translateX(220%) skewX(-18deg)' }],
      { duration: 900, delay, easing: 'cubic-bezier(.4,0,.2,1)' },
    )
    .finished.catch(() => undefined)
    .finally(() => band.remove());
}

/** The page's stamps land again one after another: "here's everywhere you've been". */
export function reinkStamps(card: HTMLElement, delay = 0) {
  if (prefersReducedMotion()) return;
  card.querySelectorAll<HTMLElement>('.ink-stamp').forEach((stamp, index) => {
    const rotate = stamp.style.getPropertyValue('--rot').trim() || '0deg';
    stamp.animate(
      [
        { transform: `rotate(${rotate}) scale(1.5)`, opacity: 0 },
        { transform: `rotate(${rotate}) scale(0.94)`, opacity: 0.9, offset: 0.6 },
        { transform: `rotate(${rotate}) scale(1)`, opacity: 0.88 },
      ],
      { duration: 380, delay: delay + index * 55, easing: token('--ease-out'), fill: 'backwards' },
    );
  });
}

let observer: IntersectionObserver | undefined;

/** Sections ease up as they scroll into view, and the reward drawing fills as it appears. */
export function revealOnScroll(root: HTMLElement) {
  if (prefersReducedMotion() || !('IntersectionObserver' in window)) return;
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        observer?.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  // Read every position first, then write, so the browser lays out once.
  const screenEnd = window.innerHeight * 0.92;
  const below = [...root.querySelectorAll<HTMLElement>('.block, .next, .rewards, .save, .footer')]
    .filter((section) => section.getBoundingClientRect().top >= screenEnd);
  // Anything already on screen when the page arrives shows straight away.
  for (const section of below) {
    section.classList.add('reveal');
    observer?.observe(section);
  }
}

/**
 * A page arrives as one motion, not a pile of separate ones. The headline leads (it rises the
 * furthest and comes into focus), the line under it follows 60ms later, then the card or the
 * first thing below it, then the next. Seals and marks only fade. The gaps shrink as it goes, so
 * it reads as a wave. Anything already moving on its own (the dealt-in wallet) is left alone,
 * and anything below the fold waits for revealOnScroll.
 */
export function enterPage(root: HTMLElement) {
  const main = root.querySelector('main');
  if (!main) return;
  const beat = (node: Element | null | undefined, role: 'lead' | 'support' | 'card' | 'fade', delay: number) => {
    if (!(node instanceof HTMLElement) || node.getBoundingClientRect().top > window.innerHeight) return;
    node.dataset.enter = role;
    node.style.setProperty('--enter-delay', `${delay}ms`);
    node.addEventListener('animationend', () => {
      delete node.dataset.enter;
      node.style.removeProperty('--enter-delay');
    }, { once: true });
  };
  const hero = main.querySelector('.hero, .message');
  beat(hero?.querySelector('.seal-chip, .message-mark'), 'fade', 0);
  beat(hero?.querySelector('h1'), 'lead', 0);
  beat(hero?.querySelector('.subline'), 'support', 60);
  beat(hero?.querySelector('.button'), 'support', 110);
  // The next two things on the page, whatever they are: usually the card, then its first section.
  const after = [...main.children].filter((node) => node !== hero && !node.matches('header, .topbar'));
  const start = hero ? after.findIndex((node) => hero.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) : 0;
  const next = after.slice(Math.max(0, start)).filter((node) => node.getBoundingClientRect().height > 0);
  next.slice(0, 2).forEach((node, index) => {
    if (node.querySelector('.is-dealing')) return;
    beat(node, index === 0 ? 'card' : 'support', index === 0 ? 110 : 150);
  });
}

const folding = new WeakMap<HTMLElement, Animation>();

/**
 * Folds a block away (or back) by shrinking its height, so what's below slides up with it instead
 * of jumping. `instant` sets the end state with no animation (first render, Reduce Motion).
 */
export function fold(node: HTMLElement, away: boolean, instant = false) {
  folding.get(node)?.cancel();
  if (instant || prefersReducedMotion()) {
    node.hidden = away;
    return;
  }
  if (node.hidden === away) return;
  node.hidden = false;
  const style = getComputedStyle(node);
  const open = { height: `${node.offsetHeight}px`, marginTop: style.marginTop, opacity: 1 };
  const shut = { height: '0px', marginTop: '0px', opacity: 0 };
  const animation = node.animate(away ? [open, shut] : [shut, open], {
    duration: 480,
    easing: token('--spring-smooth'),
  });
  node.style.overflow = 'hidden';
  folding.set(node, animation);
  const done = () => {
    if (folding.get(node) !== animation) return;
    folding.delete(node);
    node.hidden = away;
    node.style.overflow = '';
    animation.cancel();
  };
  animation.onfinish = done;
  animation.oncancel = () => (node.style.overflow = '');
  // A page in a background tab gets no animation frames (not even the finish event), so the fold
  // also ends on a timer.
  window.setTimeout(done, 520);
}

