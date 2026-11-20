import { el, svg } from './dom';

// Waiting and empty moments: grey card shapes while cards load, and a small drawing with one
// action when there's nothing to show yet.

/** Card-shaped placeholders in the shape of the page that's coming. */
export function skeletonCards(count = 3) {
  return el(
    'div',
    { class: 'skeleton', 'aria-hidden': 'true' },
    el('span', { class: 'skeleton-line is-title' }),
    el('span', { class: 'skeleton-line is-short' }),
    el('div', { class: 'skeleton-stack' }, ...Array.from({ length: count }, () => el('span', { class: 'skeleton-card' }))),
  );
}

export type Drawing = 'stand' | 'signal' | 'page';

/** The line drawing for an empty or message panel: a stand, a phone with no signal, or a page. */
export function drawing(kind: Drawing = 'stand') {
  if (kind === 'signal') return signalDrawing();
  if (kind === 'page') return pageDrawing();
  return tapDrawing();
}

/** A phone tapping a stand, with one stamp mark: the first thing a diner does. */
function tapDrawing() {
  return svg(
    'svg',
    { class: 'empty-art', viewBox: '0 0 160 112', width: 160, height: 112, 'aria-hidden': 'true' },
    // The stand.
    svg('path', { class: 'empty-line', d: 'M58 104h52M68 104l6-46h20l6 46' }),
    svg('rect', { class: 'empty-line', x: 64, y: 46, width: 40, height: 14, rx: 4 }),
    // The phone, tilted toward the stand.
    svg('g', { transform: 'rotate(-14 104 40)' },
      svg('rect', { class: 'empty-line', x: 90, y: 6, width: 30, height: 52, rx: 6 }),
      svg('path', { class: 'empty-line', d: 'M101 12h8' })),
    // Signal arcs.
    svg('path', { class: 'empty-accent', d: 'M80 38a8 8 0 0 1 8-8M74 36a15 15 0 0 1 15-15' }),
    // A stamp, landed.
    svg('circle', { class: 'empty-stamp', cx: 32, cy: 70, r: 17 }),
    svg('circle', { class: 'empty-stamp is-inner', cx: 32, cy: 70, r: 11 }),
  );
}

/** A phone whose signal arcs are cut: no connection. */
function signalDrawing() {
  return svg(
    'svg',
    { class: 'empty-art', viewBox: '0 0 160 112', width: 160, height: 112, 'aria-hidden': 'true' },
    svg('rect', { class: 'empty-line', x: 62, y: 18, width: 36, height: 64, rx: 7 }),
    svg('path', { class: 'empty-line', d: 'M75 25h10M74 74h12' }),
    svg('path', { class: 'empty-accent', d: 'M108 44a14 14 0 0 1 0 20M116 36a26 26 0 0 1 0 36' }),
    svg('path', { class: 'empty-line', d: 'M104 30l20 48' }),
    svg('path', { class: 'empty-line', d: 'M40 104h80' }),
  );
}

/** A printed page with a stamp in the corner: rules, terms, a closed screen. */
function pageDrawing() {
  return svg(
    'svg',
    { class: 'empty-art', viewBox: '0 0 160 112', width: 160, height: 112, 'aria-hidden': 'true' },
    svg('path', { class: 'empty-line', d: 'M52 8h46l14 14v82H52z' }),
    svg('path', { class: 'empty-line', d: 'M98 8v14h14M62 36h40M62 48h40M62 60h28' }),
    svg('circle', { class: 'empty-stamp', cx: 32, cy: 70, r: 17 }),
    svg('circle', { class: 'empty-stamp is-inner', cx: 32, cy: 70, r: 11 }),
  );
}

export function emptyState(options: { title: string; text: string; action: { label: string; href: string } }) {
  return el(
    'section',
    { class: 'empty' },
    tapDrawing(),
    el('h2', { class: 'empty-title' }, options.title),
    el('p', { class: 'empty-text' }, options.text),
    el('a', { class: 'button button-primary', href: options.action.href }, options.action.label),
  );
}
