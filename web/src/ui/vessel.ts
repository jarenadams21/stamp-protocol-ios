import { svg } from './dom';

// The reward, drawn as the thing you'll get, filling up visit by visit: a cup fills with coffee,
// a bowl with broth, a cone with its scoop. Drawn in the card's own paper colour on the navy page.

interface Vessel {
  /** Closed shapes that fill up. */
  body: string[];
  /** Open strokes drawn on top: handles, steam, chopsticks. */
  lines: string[];
}

const VESSELS: Record<string, Vessel> = {
  cup: {
    body: ['M14 24h32v16a14 14 0 0 1-14 14h-4a14 14 0 0 1-14-14z'],
    lines: ['M46 29h3a6 6 0 0 1 0 12h-3', 'M9 58h42', 'M24 9c-2 3 2 6 0 9', 'M32 7c-2 3 2 6 0 9', 'M40 9c-2 3 2 6 0 9'],
  },
  teapot: {
    body: ['M15 33a17 15 0 0 1 34 0v7a10 10 0 0 1-10 10H25a10 10 0 0 1-10-10z'],
    lines: ['M49 36c5-1 8-5 9-10', 'M15 31c-6 0-9 8-3 13', 'M25 18h14', 'M32 13v5', 'M20 56h24'],
  },
  bowl: {
    body: ['M8 32h48c0 12-10 21-24 21S8 44 8 32z'],
    lines: ['M24 57h16', 'M44 6L33 32', 'M52 9L38 32', 'M20 14c-2 3 2 6 0 9', 'M27 12c-2 3 2 6 0 9'],
  },
  cone: {
    body: ['M19 27a13 13 0 0 1 26 0z', 'M19 29h26L32 59z'],
    lines: ['M24 36l12 8', 'M27 46l7-5'],
  },
  loaf: {
    body: ['M10 46c0-15 10-25 22-25s22 10 22 25v6H10z'],
    lines: ['M21 31l5 6', 'M30 28l5 6', 'M39 31l5 6', 'M6 56h52'],
  },
};

/** Which drawing suits a place, from its category. */
function vesselFor(category = ''): Vessel {
  const kind = category.toLowerCase();
  if (/tea/.test(kind)) return VESSELS.teapot;
  if (/noodle|ramen|pho|soup/.test(kind)) return VESSELS.bowl;
  if (/ice cream|creamery|gelato/.test(kind)) return VESSELS.cone;
  if (/bakery|bake|bread|pastry/.test(kind)) return VESSELS.loaf;
  return VESSELS.cup;
}

let clipCount = 0;

/** The drawing, filled to `progress` (0 to 1). It draws on, then the fill rises and settles. */
export function rewardVessel(category: string | undefined, progress: number) {
  const vessel = vesselFor(category);
  const id = `vessel-fill-${(clipCount += 1)}`;
  const level = Math.max(0, Math.min(1, progress));
  return svg(
    'svg',
    { class: 'vessel', viewBox: '0 0 64 64', 'aria-hidden': 'true' },
    svg('clipPath', { id }, ...vessel.body.map((d) => svg('path', { d }))),
    svg(
      'g',
      { 'clip-path': `url(#${id})` },
      // A gently waved surface, raised from the bottom to the fill level.
      svg('path', {
        class: 'vessel-fill',
        // One wave longer than the vessel, so the surface can slosh sideways a wave's width.
        d: 'M-8 2q8-3 16 0t16 0 16 0 16 0 16 0 16 0V72H-8z',
        style: `--level:${(1 - level) * 60 + 2}px`,
      }),
    ),
    // The outline draws itself on, stroke by stroke, before the fill rises.
    ...[...vessel.body, ...vessel.lines].map((d, index) =>
      svg('path', { class: 'vessel-line', d, pathLength: 1, style: `--i:${index}` })),
  );
}
