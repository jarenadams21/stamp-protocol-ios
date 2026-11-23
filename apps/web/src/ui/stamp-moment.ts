import type { CardState } from '../api';
import { el, haptic, prefersReducedMotion } from './dom';
import { impression, impressionURL, IMPRESSION_SCALE, paper } from './ink';
import { stampSpec } from './passport';
import { token } from './spring';
import { seedOf } from './stamp-style';

// The stamp page: the first thing a diner sees after a verified tap, before the card. A sheet of
// the place's own paper fills the screen, seen from above. The ink falls onto it (bigger and soft
// just above the paper, sharpening as it lands) and hits with a thump: the sheet gives and shakes,
// the paper darkens around it, the phone buzzes. The impression sits in wet, dark ink that dries
// lighter, and "Stamp 4 of 8" pops in. After a beat, or a tap, it flies down into its slot on the
// card. Reduced motion, or a business that turned motion off, skips straight to the card.

export interface StampMoment {
  /** Waits for the moment to finish (or a tap), flies the stamp into `slot`, and removes the page. */
  land(slot: HTMLElement | null): Promise<void>;
}

/** The ink falls onto the paper: from a little above (bigger, soft) down to it. */
const FALL = 360;
/** The thump: the sheet gives, shakes and darkens under the hit. */
const THUMP = 260;
/** The wet ink settles into the paper and dries lighter. */
const DRY = 1100;
/** The page moves on to the card by itself after this long; a tap moves on sooner. */
const AUTO_LAND = 2400;
/** Even a tap waits for the ink to have landed, so the diner always sees their stamp. */
const EARLIEST_LAND = FALL + THUMP + 200;

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sleep = (ms: number) => new Promise((done) => window.setTimeout(done, ms));

export function stampMoment(state: CardState, index: number, options: { complete?: boolean } = {}): StampMoment | null {
  if (prefersReducedMotion() || !state.program.theme.allowsMotion) return null;
  const { lightPaper, lightInk } = state.program.theme;
  const spec = stampSpec(index, seedOf(state.business.id), state.recentVisits?.[0]);
  const angle = (spec.rotate * Math.PI) / 180;
  const total = state.card.requiredPunches;

  // Sizes: a square sheet, with room around it for the sheet's shadow and the shake.
  const sheet = Math.min(window.innerWidth * 0.82, 340);
  const stage = { w: Math.min(window.innerWidth, 440), h: sheet * 1.5 };
  const stampSize = sheet * 0.55;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const view = el('canvas', { class: 'moment-canvas', width: Math.round(stage.w * ratio), height: Math.round(stage.h * ratio), 'aria-hidden': 'true' });
  view.style.width = `${stage.w}px`;
  view.style.height = `${stage.h}px`;
  const g = view.getContext('2d')!;
  g.scale(ratio, ratio);
  const cx = stage.w / 2;
  const cy = stage.h / 2;
  const sheetX = cx - sheet / 2;
  const sheetY = cy - sheet / 2;

  const paperImage = paper(lightPaper, lightInk).node;
  const ink = impression(spec, stampSize);
  const inkSide = stampSize / IMPRESSION_SCALE;
  // A scratch canvas for the impression's wet sheen, reused every frame.
  const wet = document.createElement('canvas');
  wet.width = ink.width;
  wet.height = ink.height;
  const w = wet.getContext('2d')!;

  const count = el('p', { class: 'moment-count' }, options.complete ? 'Card complete' : `Stamp ${index + 1} of ${total}`);
  const place = el('p', { class: 'moment-place', translate: 'no' }, state.business.name);
  const hint = el('p', { class: 'moment-hint' }, 'Tap to see your card');
  const root = el('div', {
    class: `stamp-moment${options.complete ? ' is-complete' : ''}`,
    role: 'status',
    'aria-label': options.complete ? `Card complete at ${state.business.name}` : `Stamp ${index + 1} of ${total} added at ${state.business.name}`,
  }, place, view, count, hint);
  document.body.append(root);
  root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });

  const started = performance.now();
  let buzzed = false;
  let counted = false;
  let showInk = true;
  let running = true;

  function drawImpression(dry: number) {
    w.globalCompositeOperation = 'source-over';
    w.clearRect(0, 0, wet.width, wet.height);
    w.drawImage(ink, 0, 0);
    if (dry < 1) {
      // A wet sheen sweeps across while the ink is fresh, only where there's ink.
      w.globalCompositeOperation = 'source-atop';
      const at = lerp(-0.3, 1.3, dry);
      const sheen = w.createLinearGradient(wet.width * (at - 0.3), 0, wet.width * (at + 0.1), wet.height);
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.5, `rgba(255,255,255,${0.35 * (1 - dry)})`);
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      w.fillStyle = sheen;
      w.fillRect(0, 0, wet.width, wet.height);
    }
    g.save();
    g.translate(cx, cy);
    g.rotate(angle);
    g.globalCompositeOperation = 'multiply';
    g.filter = `saturate(${lerp(1.7, 1, dry)}) brightness(${lerp(0.7, 1, dry)})`;
    g.drawImage(wet, -inkSide / 2, -inkSide / 2, inkSide, inkSide);
    g.restore();
  }

  function frame(now: number) {
    if (!running) return;
    const t = now - started;
    const fall = clamp(t / FALL);
    const thump = clamp((t - FALL) / THUMP);
    const dry = clamp((t - FALL) / DRY);
    const hit = fall >= 1 ? Math.exp(-thump * 5) : 0;
    const shake = fall >= 1 && thump < 1 ? Math.sin(thump * 46) * hit * 7 : 0;

    g.clearRect(0, 0, stage.w, stage.h);
    g.save();
    g.translate(shake, shake * 0.5);
    // The sheet, with a soft shadow, giving a little under the hit.
    const give = 1 - 0.022 * hit;
    g.translate(cx, cy);
    g.scale(give, give);
    g.translate(-cx, -cy);
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 36;
    g.shadowOffsetY = 16;
    g.beginPath();
    g.roundRect(sheetX, sheetY, sheet, sheet, 18);
    g.fillStyle = lightPaper;
    g.fill();
    g.shadowColor = 'transparent';
    g.save();
    g.clip();
    g.drawImage(paperImage, sheetX, sheetY, sheet, sheet);
    // The dent: the paper darkens around the ink for a moment, as if pressed hard.
    if (hit > 0.01) {
      const dent = g.createRadialGradient(cx, cy, stampSize * 0.25, cx, cy, stampSize * 0.95);
      dent.addColorStop(0, `rgba(0,0,0,${0.22 * hit})`);
      dent.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = dent;
      g.fillRect(sheetX, sheetY, sheet, sheet);
    }
    if (showInk) {
      if (fall < 1) {
        // Falling: bigger, soft and pale above the paper, sharpening as it reaches it.
        const height = 1 - easeOut(fall);
        g.save();
        g.translate(cx, cy);
        g.rotate(angle - height * 0.25);
        const scale = 1 + height * 0.45;
        g.globalAlpha = 0.25 + 0.75 * fall;
        g.filter = `blur(${height * 6}px)`;
        g.drawImage(ink, (-inkSide / 2) * scale, (-inkSide / 2) * scale, inkSide * scale, inkSide * scale);
        g.restore();
      } else {
        drawImpression(dry);
      }
    }
    g.restore();
    g.restore();

    if (!buzzed && fall >= 1) {
      buzzed = true;
      haptic(options.complete ? [20, 40, 26, 40, 30] : [18, 30, 22]);
    }
    if (!counted && t > FALL + 80) {
      counted = true;
      count.animate(
        [
          { transform: 'translateY(16px) scale(1.5)', opacity: 0 },
          { transform: 'translateY(0) scale(0.94)', opacity: 1, offset: 0.6 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 520, easing: token('--spring-lift'), fill: 'both' },
      );
      hint.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 500, fill: 'both' });
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // A tap anywhere moves on to the card, once the ink has landed.
  let tapped: () => void = () => undefined;
  const tap = new Promise<void>((done) => { tapped = done; });
  root.addEventListener('pointerdown', () => tapped(), { once: true });

  return {
    async land(slot) {
      await Promise.race([sleep(AUTO_LAND), tap]);
      await sleep(Math.max(0, EARLIEST_LAND - (performance.now() - started)));
      // Hand the impression from the canvas to an image that can fly over the page.
      const box = view.getBoundingClientRect();
      const fly = el('img', { class: 'moment-fly', alt: '', src: impressionURL(spec, stampSize) });
      Object.assign(fly.style, {
        left: `${box.left + cx - inkSide / 2}px`,
        top: `${box.top + cy - inkSide / 2}px`,
        width: `${inkSide}px`,
        height: `${inkSide}px`,
        transform: `rotate(${spec.rotate}deg)`,
      });
      document.body.append(fly);
      showInk = false;
      const to = slot?.getBoundingClientRect();
      const fade = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 480, easing: token('--ease-out'), fill: 'both' });
      let flight: Animation;
      if (to && to.width > 0) {
        // The card's stamp image is 128% of its slot, with the same room for specks as this one.
        const targetSide = to.width * 1.28;
        const dx = to.left + to.width / 2 - (box.left + cx);
        const dy = to.top + to.height / 2 - (box.top + cy);
        flight = fly.animate(
          [
            { transform: `translate(0, 0) rotate(${spec.rotate}deg) scale(1)` },
            { transform: `translate(${dx}px, ${dy}px) rotate(${spec.rotate}deg) scale(${targetSide / inkSide})` },
          ],
          { duration: 600, easing: token('--spring-smooth'), fill: 'both' },
        );
      } else {
        flight = fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'both' });
      }
      await Promise.race([Promise.all([flight.finished, fade.finished]), sleep(900)]).catch(() => undefined);
      running = false;
      root.remove();
      fly.remove();
    },
  };
}
