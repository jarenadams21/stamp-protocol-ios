import type { CardState } from '../api';
import { el, haptic, prefersReducedMotion } from './dom';
import { pageStyle } from './passport';
import { token } from './spring';

// The stamp stage: what a diner sees after a verified tap, before the page. It's a camera move on
// the real card, so nothing is handed from one object to another:
//   1. The page fades away, the cover dims to a glow in the place's colour, and the card comes in
//      zoomed on the empty slot.
//   2. The stamp strikes at that zoom (passport.stampIn), so it's big.
//   3. The camera pulls back to the whole card; the count turns; "Stamp 4 of 8" sits under it.
//   4. The card glides down into its place on the page as the rest of the page fades in around it.
// A tap anywhere skips to the end. Reduced motion, or a business with motion off, skips the stage.

export interface StampStage {
  /** Resolves once the card is zoomed in and the strike can start. */
  ready: Promise<void>;
  /** After the strike: pull back, hold a beat (or until a tap), then settle into the page. */
  finish(during?: () => Promise<unknown>): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((done) => window.setTimeout(done, ms));
const settled = (animation: Animation, fallback: number) =>
  Promise.race([animation.finished, sleep(fallback)]).catch(() => undefined);

/** How long the whole card stays centred before it settles, unless the diner taps. */
const HOLD = 1100;

export function stampStage(page: HTMLElement, stack: HTMLElement, slot: HTMLElement, state: CardState, options: { complete?: boolean } = {}): StampStage | null {
  if (prefersReducedMotion() || !state.program.theme.allowsMotion) return null;
  window.scrollTo(0, 0);
  page.classList.add('is-presenting');
  const backdrop = el('div', { class: 'stamp-stage', style: pageStyle(state), 'aria-hidden': 'true' });
  const punches = state.card.punches;
  const total = state.card.requiredPunches;
  const left = total - punches;
  const caption = el('div', { class: 'stage-caption', 'aria-hidden': 'true' },
    el('p', { class: 'stage-count' }, options.complete ? 'Card complete' : `Stamp ${punches} of ${total}`),
    el('p', { class: 'stage-note' }, options.complete
      ? `${state.program.rewardDescription} is yours`
      : `${left} more to ${state.program.rewardDescription.charAt(0).toLowerCase()}${state.program.rewardDescription.slice(1)}`));
  document.body.append(backdrop, caption);

  // Where things are with no transform: the card's place on the page and the slot inside it.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const card = stack.getBoundingClientRect();
  const target = slot.getBoundingClientRect();
  // Zoomed: the slot about 150px wide, its centre a little above the middle of the screen.
  const zoom = Math.min(2.4, Math.max(1.6, 150 / Math.max(1, target.width)));
  const slotX = target.left + target.width / 2 - card.left;
  const slotY = target.top + target.height / 2 - card.top;
  const zoomed = (scale: number) => `translate(${vw / 2 - card.left - slotX * scale}px, ${vh * 0.42 - card.top - slotY * scale}px) scale(${scale})`;
  // The whole card, centred, as big as fits with a margin.
  const fit = Math.min(1.08, (vw - 32) / card.width, (vh * 0.6) / card.height);
  const whole = `translate(${vw / 2 - card.left - (card.width * fit) / 2}px, ${vh * 0.4 - card.top - (card.height * fit) / 2}px) scale(${fit})`;
  stack.style.transformOrigin = '0 0';

  backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: token('--ease-out'), fill: 'forwards' });
  const enter = stack.animate(
    [{ transform: zoomed(zoom * 0.9), opacity: 0 }, { transform: zoomed(zoom), opacity: 1 }],
    { duration: 380, easing: token('--ease-out'), fill: 'forwards' },
  );
  // The glow flares with the strike's contact (stampIn's contact is 230ms in).
  const ready = settled(enter, 500).then(() => {
    window.setTimeout(() => {
      backdrop.animate(
        [{ filter: 'brightness(1)' }, { filter: 'brightness(1.9)', offset: 0.2 }, { filter: 'brightness(1)' }],
        { duration: 700, easing: token('--ease-out') },
      );
    }, 230);
  });

  let skip: () => void = () => undefined;
  const tapped = new Promise<void>((done) => { skip = done; });
  const onTap = () => skip();
  window.addEventListener('pointerdown', onTap, { once: true });

  return {
    ready,
    async finish(during) {
      // Pull back to the whole card; the caption rises in under it.
      const back = stack.animate([{ transform: zoomed(zoom) }, { transform: whole }], { duration: 640, easing: token('--spring-smooth'), fill: 'forwards' });
      const below = vh * 0.4 + (card.height * fit) / 2;
      caption.style.top = `${below + 22}px`;
      caption.animate(
        [{ transform: 'translateY(14px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 420, delay: 220, easing: token('--ease-out'), fill: 'both' },
      );
      await settled(back, 800);
      if (during) await Promise.race([during(), sleep(1600)]);
      await Promise.race([sleep(HOLD), tapped]);
      window.removeEventListener('pointerdown', onTap);

      // Settle: the card glides into its place; the stage lifts; the page comes in around it.
      const home = stack.animate([{ transform: whole }, { transform: 'none' }], { duration: 560, easing: token('--spring-smooth'), fill: 'forwards' });
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: token('--ease-out'), fill: 'forwards' });
      caption.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(8px)' }], { duration: 220, fill: 'forwards' });
      page.classList.add('is-revealing');
      page.classList.remove('is-presenting');
      haptic(6);
      await settled(home, 700);
      for (const animation of [enter, back, home]) animation.cancel();
      stack.style.removeProperty('transform-origin');
      backdrop.remove();
      caption.remove();
      await sleep(400);
      page.classList.remove('is-revealing');
    },
  };
}
