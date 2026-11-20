// Springs, Apple style: two numbers instead of mass, stiffness and damping.
//   response: roughly how long it takes to get there, in seconds (lower is snappier)
//   damping:  1 settles without overshoot; below 1 overshoots a little (0.8 after a flick)
// A spring starts from wherever the value is now and keeps its speed when you retarget it, so
// anything it moves can be grabbed and thrown again mid-flight.

export interface SpringConfig {
  response: number;
  damping: number;
}

/** Calm, no overshoot: things the page moves on its own (a button opened it, not a finger). */
export const SMOOTH: SpringConfig = { response: 0.42, damping: 1 };
/** A little give at the end: only after a drag or a flick put force into it. */
export const THROWN: SpringConfig = { response: 0.4, damping: 0.82 };

function constants({ response, damping }: SpringConfig) {
  const stiffness = (2 * Math.PI / response) ** 2;
  return { stiffness, friction: (4 * Math.PI * damping) / response };
}

/**
 * One animated number. `onUpdate` gets every frame's value; write it straight to a transform.
 * `to()` resolves `true` once the spring settles, or `false` if a newer `to()`, `set()` or
 * `stop()` took over first.
 */
export class Spring {
  value: number;
  velocity = 0;
  private frame = 0;
  private finish?: (settled: boolean) => void;

  constructor(value: number, private readonly onUpdate: (value: number) => void) {
    this.value = value;
  }

  /** Jumps to `value` with no motion (the finger is down: the value is the finger). */
  set(value: number, velocity = 0) {
    this.stop();
    this.value = value;
    this.velocity = velocity;
    this.onUpdate(value);
  }

  /** Stops where it is, keeping the current value and speed for whoever takes over. */
  stop() {
    cancelAnimationFrame(this.frame);
    this.finish?.(false);
    this.finish = undefined;
  }

  to(target: number, config: SpringConfig = SMOOTH, velocity = this.velocity): Promise<boolean> {
    this.stop();
    this.velocity = velocity;
    // A page in a background tab gets no frames: land straight away.
    if (document.visibilityState === 'hidden') {
      this.set(target);
      return Promise.resolve(true);
    }
    const { stiffness, friction } = constants(config);
    let last = performance.now();
    return new Promise((resolve) => {
      // If frames stop coming (a background tab, a throttled frame), land anyway: a sheet must
      // never stay stuck half-way with the page behind it blocked.
      const watchdog = window.setTimeout(() => {
        if (this.finish !== done) return;
        cancelAnimationFrame(this.frame);
        this.finish = undefined;
        this.value = target;
        this.velocity = 0;
        this.onUpdate(target);
        resolve(true);
      }, 1500);
      const done = (settled: boolean) => {
        window.clearTimeout(watchdog);
        resolve(settled);
      };
      this.finish = done;
      const step = (now: number) => {
        // Small fixed steps keep a stiff spring stable even when a frame comes late.
        let dt = Math.min(0.064, (now - last) / 1000);
        last = now;
        while (dt > 0) {
          const h = Math.min(dt, 1 / 240);
          const force = -stiffness * (this.value - target) - friction * this.velocity;
          this.velocity += force * h;
          this.value += this.velocity * h;
          dt -= h;
        }
        if (Math.abs(this.value - target) < 0.3 && Math.abs(this.velocity) < 12) {
          this.value = target;
          this.velocity = 0;
          this.onUpdate(target);
          this.finish = undefined;
          done(true);
          return;
        }
        this.onUpdate(this.value);
        this.frame = requestAnimationFrame(step);
      };
      this.frame = requestAnimationFrame(step);
    });
  }
}

/**
 * The same spring as a CSS `linear()` easing over `durationMs`, for motion the browser can run on
 * its own (transitions stay interruptible: a new target starts from where the card is now).
 */
export function springEasing(config: SpringConfig, durationMs: number) {
  const { stiffness, friction } = constants(config);
  const points: string[] = [];
  let x = 0;
  let v = 0;
  const samples = 48;
  const h = 1 / 1000;
  let t = 0;
  for (let index = 0; index <= samples; index += 1) {
    const until = (index / samples) * (durationMs / 1000);
    while (t < until) {
      v += (stiffness * (1 - x) - friction * v) * h;
      x += v * h;
      t += h;
    }
    points.push(index === samples ? '1' : x.toFixed(4));
  }
  return `linear(${points.join(', ')})`;
}

/** A motion token from tokens.css (or its spring override), for animations started from JS. */
export function token(name: '--ease-out' | '--spring-smooth' | '--spring-lift') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'ease-out';
}

/** Spring curves for CSS, set once on :root. Browsers without linear() keep the cubic fallbacks in tokens.css. */
export function installSpringEasings() {
  if (!CSS.supports('transition-timing-function', 'linear(0, 1)')) return;
  const root = document.documentElement.style;
  root.setProperty('--spring-smooth', springEasing(SMOOTH, 600));
  root.setProperty('--spring-lift', springEasing({ response: 0.5, damping: 0.86 }, 600));
}

/**
 * Where a flick would come to rest if nothing stopped it (Apple's scroll deceleration), so a
 * quick short swipe counts as much as a long slow one.
 */
export function project(velocity: number, decelerationRate = 0.99) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Past an edge, the element follows less the further you pull, instead of stopping dead. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  const sign = Math.sign(overshoot);
  const distance = Math.abs(overshoot);
  return sign * ((distance * dimension * constant) / (dimension + constant * distance));
}

/** Finger speed in px/s from the last ~100ms of moves. */
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  reset() {
    this.samples = [];
  }

  add(event: PointerEvent) {
    const t = event.timeStamp || performance.now();
    this.samples.push({ t, x: event.clientX, y: event.clientY });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }

  velocity() {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last.t - first.t < 8) return { x: 0, y: 0 };
    const seconds = (last.t - first.t) / 1000;
    return { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds };
  }
}
