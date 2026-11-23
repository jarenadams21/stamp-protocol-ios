import type { CardState } from '../api';
import { el, haptic, prefersReducedMotion } from './dom';
import { inkStamp, pageStyle } from './passport';
import { token } from './spring';
import { INKS, rotationOf, seedOf } from './stamp-style';

// The stamp moment: the first thing a diner sees after a verified tap, before the card page. The
// screen dims and a big stamp in this visit's ink falls from above, slams down (shockwave, ink
// spatter, a shake, a double buzz, the count popping over), holds a beat, then shrinks and flies
// into its own slot on the card as the page shows through. One orchestrated moment; everything
// on the page waits for it. Reduced motion, or a business that turned motion off, skips it.

export interface StampMoment {
  /** Flies the stamp into `slot` (or fades out without one) and removes the moment. */
  land(slot: HTMLElement | null): Promise<void>;
}

const IMPACT_MS = 430;
/** The least time the stamp stays on screen, so the blow and the count can be read. */
const HOLD_MS = 1250;

const sleep = (ms: number) => new Promise((done) => window.setTimeout(done, ms));
const finished = (animation: Animation, fallbackMs: number) =>
  Promise.race([animation.finished, sleep(fallbackMs)]).catch(() => undefined);

function spatter(stage: HTMLElement, inks: string[], count: number, reach: number) {
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + (index % 3) * 0.21;
    const distance = reach * (0.62 + ((index * 37) % 40) / 100);
    const size = 8 + ((index * 7) % 14);
    const fleck = el('span', { class: 'moment-fleck', style: `--ink:${inks[index % inks.length]};--size:${size}px`, 'aria-hidden': 'true' });
    stage.append(fleck);
    void finished(
      fleck.animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 1 },
          { transform: `translate(calc(-50% + ${Math.cos(angle) * distance}px), calc(-50% + ${Math.sin(angle) * distance}px)) scale(1)`, opacity: 1, offset: 0.55 },
          { transform: `translate(calc(-50% + ${Math.cos(angle) * distance * 1.12}px), calc(-50% + ${Math.sin(angle) * distance * 1.12 + 18}px)) scale(0.7)`, opacity: 0 },
        ],
        { duration: 900 + (index % 4) * 90, easing: token('--ease-out') },
      ),
      1400,
    ).then(() => fleck.remove());
  }
}

/** Starts the moment for the visit at `index` on `state`'s card. Null when motion is off. */
export function stampMoment(state: CardState, index: number, options: { complete?: boolean } = {}): StampMoment | null {
  if (prefersReducedMotion() || !state.program.theme.allowsMotion) return null;
  const seed = seedOf(state.business.id);
  const iso = state.recentVisits?.[0];
  const stamp = inkStamp(index, seed, iso);
  const ink = stamp.style.getPropertyValue('--ink');
  const rot = rotationOf(index, seed);
  const total = state.card.requiredPunches;

  const count = el('p', { class: 'moment-count' },
    options.complete ? 'Card complete' : `Stamp ${index + 1} of ${total}`);
  const place = el('p', { class: 'moment-place', translate: 'no' }, state.business.name);
  const shadow = el('span', { class: 'moment-shadow', 'aria-hidden': 'true' });
  const holder = el('div', { class: 'moment-stamp' }, shadow, stamp);
  const stage = el('div', { class: 'moment-stage' }, place, holder, count);
  const root = el('div', {
    class: `stamp-moment${options.complete ? ' is-complete' : ''}`,
    style: `${pageStyle(state)};--ink:${ink}`,
    role: 'status',
    'aria-label': options.complete ? `Card complete at ${state.business.name}` : `Stamp ${index + 1} of ${total} added at ${state.business.name}`,
  }, stage);
  document.body.append(root);
  const started = performance.now();

  root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out', fill: 'both' });
  count.style.opacity = '0';

  // The fall: big, blurred and turning, picking up speed; the shadow gathers underneath.
  shadow.animate(
    [
      { transform: 'scale(2.2)', opacity: 0, easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
      { transform: 'scale(0.9)', opacity: 0.55, offset: IMPACT_MS / 1100 },
      { transform: 'scale(1)', opacity: 0.25 },
    ],
    { duration: 1100, fill: 'both' },
  );
  stamp.animate(
    [
      { transform: `translateY(-70vh) rotate(${rot - 40}deg) scale(3.4)`, opacity: 0, filter: 'blur(8px)', easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
      { transform: `translateY(0) rotate(${rot}deg) scale(0.78, 0.84)`, opacity: 1, filter: 'blur(0) saturate(1.8) brightness(0.75)', offset: IMPACT_MS / 1100, easing: token('--spring-lift') },
      { transform: `rotate(${rot}deg) scale(1.1)`, filter: 'saturate(1.5) brightness(0.85)', offset: 0.62 },
      { transform: `rotate(${rot}deg) scale(1)`, opacity: 0.96, filter: 'saturate(1) brightness(1)' },
    ],
    { duration: 1100, fill: 'both' },
  );

  // The blow: everything else happens on the impact frame, so it reads as one cause.
  window.setTimeout(() => {
    haptic(options.complete ? [16, 40, 26, 40, 30] : [12, 30, 22]);
    for (const [delay, scale] of [[0, 2.6], [110, 3.4]] as const) {
      const ring = el('span', { class: 'moment-ring', 'aria-hidden': 'true' });
      holder.append(ring);
      void finished(
        ring.animate(
          [{ transform: 'scale(0.7)', opacity: 0.85 }, { transform: `scale(${scale})`, opacity: 0 }],
          { duration: 700, delay, easing: token('--ease-out') },
        ),
        1000,
      ).then(() => ring.remove());
    }
    spatter(holder, options.complete ? INKS : [ink], options.complete ? 26 : 14, options.complete ? 190 : 130);
    stage.animate(
      [
        { transform: 'translate(0, 0)' },
        { transform: 'translate(-7px, 5px)', offset: 0.15 },
        { transform: 'translate(6px, -4px)', offset: 0.35 },
        { transform: 'translate(-3px, 2px)', offset: 0.6 },
        { transform: 'translate(0, 0)' },
      ],
      { duration: 340, easing: 'ease-out' },
    );
    root.animate(
      [{ backgroundColor: 'color-mix(in srgb, var(--page-paper) 30%, var(--paper))' }, { backgroundColor: 'color-mix(in srgb, var(--paper) 88%, transparent)' }],
      { duration: 520, easing: token('--ease-out') },
    );
    count.animate(
      [
        { transform: 'translateY(14px) scale(1.5)', opacity: 0 },
        { transform: 'translateY(0) scale(0.94)', opacity: 1, offset: 0.6 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: 520, delay: 60, easing: token('--spring-lift'), fill: 'both' },
    );
  }, IMPACT_MS);

  return {
    async land(slot) {
      await sleep(Math.max(0, HOLD_MS - (performance.now() - started)));
      const from = stamp.getBoundingClientRect();
      const to = slot?.getBoundingClientRect();
      const fade = root.animate(
        [{ backgroundColor: 'color-mix(in srgb, var(--paper) 88%, transparent)' }, { backgroundColor: 'transparent' }],
        { duration: 520, easing: token('--ease-out'), fill: 'both' },
      );
      for (const text of [place, count]) text.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'both' });
      shadow.animate([{ opacity: 0.25 }, { opacity: 0 }], { duration: 200, fill: 'both' });
      let flight: Animation;
      if (to && to.width > 0 && from.width > 0) {
        // Shrink into the slot: the stamp keeps its angle and lands where the card shows it.
        const dx = to.left + to.width / 2 - (from.left + from.width / 2);
        const dy = to.top + to.height / 2 - (from.top + from.height / 2);
        const scale = (to.width * 0.9) / from.width;
        flight = holder.animate(
          [{ transform: 'translate(0, 0) scale(1)' }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})` }],
          { duration: 560, easing: token('--spring-smooth'), fill: 'both' },
        );
      } else {
        flight = holder.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.8)' }], { duration: 320, fill: 'both' });
      }
      await Promise.all([finished(flight, 800), finished(fade, 800)]);
      root.remove();
    },
  };
}
