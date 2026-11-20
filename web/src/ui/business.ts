import type { Artwork, Business, MerchantTheme } from '../api';
import { initials } from './stamp-style';
import { platform } from './components';
import { el, svg } from './dom';

// The restaurant's header: cover art in their colours, a logo badge, today's hours and
// directions. Uses theme.coverURL when the business uploaded a photo; otherwise original
// artwork per card stock, like the Discoverable posters in the iOS app.

function hash(text: string) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

/** Original cover artwork: espresso rails (rail), soft steam clouds (cloud), laid tiles (stone). */
export function coverArt(artwork: Artwork, seedText: string, className = 'cover-art') {
  const seed = hash(seedText);
  const shapes: SVGElement[] = [];
  if (artwork === 'rail') {
    for (let index = -6; index < 34; index += 1) {
      const x = index * 16 + (seed % 16);
      const weight = index % 5 === 0 ? 5 : 1.4;
      shapes.push(svg('line', { x1: x, y1: 160, x2: x + 92, y2: -20, 'stroke-width': weight, opacity: index % 5 === 0 ? 0.28 : 0.16 }));
    }
  } else if (artwork === 'cloud') {
    for (let index = 0; index < 14; index += 1) {
      const r = 18 + ((seed >>> index) % 46);
      const cx = ((seed * (index + 3)) % 460) - 20;
      const cy = 20 + ((seed >>> (index + 2)) % 110);
      shapes.push(svg('circle', { cx, cy, r, fill: 'currentColor', stroke: 'none', opacity: index % 3 === 0 ? 0.16 : 0.08 }));
    }
  } else {
    for (let row = 0; row < 6; row += 1) {
      for (let col = -1; col < 10; col += 1) {
        const w = 52;
        const x = col * (w + 6) + (row % 2 ? w / 2 : 0) + (seed % 20);
        shapes.push(svg('rect', { x, y: row * 26 - 6, width: w, height: 20, rx: 2, 'stroke-width': 1.2, opacity: ((row + col + seed) % 4 === 0) ? 0.3 : 0.14 }));
      }
    }
  }
  // A row of printed punch targets along the bottom ties every cover to the card.
  for (let index = 0; index < 12; index += 1) {
    shapes.push(svg('circle', { cx: 24 + index * 34, cy: 128, r: 9, 'stroke-width': 1.2, fill: 'none', opacity: 0.35 }));
  }
  return svg(
    'svg',
    { class: className, viewBox: '0 0 400 140', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor' },
    ...shapes,
  );
}

function clock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: m ? '2-digit' : undefined }).format(date);
}

/** "Open until 6 PM", "Opens at 7 AM", or "Closed for today". Uses the phone's clock. */
export function hoursLine(business: Business) {
  if (!business.hoursToday) return null;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const { opens, closes } = business.hoursToday;
  if (minutes < toMinutes(opens)) return { open: false, text: `Opens at ${clock(opens)}` };
  if (minutes < toMinutes(closes)) return { open: true, text: `Open until ${clock(closes)}` };
  return { open: false, text: 'Closed for today' };
}

export function directionsUrl(business: Business) {
  const query = encodeURIComponent(business.address ?? `${business.name}, ${business.location}`);
  return platform() === 'ios'
    ? `https://maps.apple.com/?q=${query}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

export function businessMark(business: Business, theme: MerchantTheme, className = 'biz-mark') {
  return el('span', { class: className, 'aria-hidden': 'true', 'data-type': theme.typeface }, initials(business.name));
}

export function businessHeader(business: Business, theme: MerchantTheme) {
  const hours = hoursLine(business);
  const cover = theme.coverURL
    ? el('img', { class: 'cover-photo', src: theme.coverURL, alt: '', width: 400, height: 112, loading: 'lazy', decoding: 'async' })
    : coverArt(theme.artwork, business.id);

  return el(
    'section',
    { class: 'biz', 'aria-label': business.name },
    el('div', { class: 'biz-cover' }, cover),
    el(
      'div',
      { class: 'biz-row' },
      businessMark(business, theme),
      el(
        'div',
        { class: 'biz-text' },
        el('p', { class: 'biz-name' }, business.name),
        el('p', { class: 'biz-meta' }, [business.category, business.location].filter(Boolean).join(' in ')),
        business.address ? el('p', { class: 'biz-meta' }, business.address) : null,
      ),
    ),
    el(
      'div',
      { class: 'biz-facts' },
      hours ? el('p', { class: `biz-hours${hours.open ? ' is-open' : ''}` }, hours.text) : null,
      el('a', {
        class: 'biz-directions', href: directionsUrl(business), target: '_blank', rel: 'noopener',
        'aria-label': `Directions to ${business.name}, opens Maps`,
      }, 'Directions'),
    ),
  );
}
