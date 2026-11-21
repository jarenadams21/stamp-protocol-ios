import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import { INKS, rotationOf, seedOf, stampLabel } from '../src/ui/stamp-style';

// Wallet pass artwork, drawn as SVG and rendered to PNG. It uses the same stamp shapes,
// angles, ink colours and fonts as the web passport page (src/ui/passport.ts), so the pass
// in Wallet looks like the page the diner just saw.

const require = createRequire(import.meta.url);
const FONT_FILES = [
  require.resolve('@expo-google-fonts/oswald/500Medium/Oswald_500Medium.ttf'),
  require.resolve('@expo-google-fonts/oswald/600SemiBold/Oswald_600SemiBold.ttf'),
  require.resolve('@expo-google-fonts/instrument-serif/400Regular/InstrumentSerif_400Regular.ttf'),
];


const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function render(svg: string, width: number) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Oswald' },
  })
    .render()
    .asPng();
}

interface StripCard {
  businessId: string;
  punches: number;
  required: number;
  paper: string;
  ink: string;
  /** Visit dates for the stamps on this card, oldest first (ISO). */
  dates: string[];
}

/** The passport page as a 375 × 123 pt strip: dated ink stamps, then dashed empty slots. */
export function strip(card: StripCard, scale: number) {
  const W = 375;
  const H = 123;
  const seed = seedOf(card.businessId);
  const perRow = card.required <= 6 ? card.required : Math.ceil(card.required / 2);
  const rows = Math.ceil(card.required / perRow);
  // Wallet trims the strip's sides on narrower cards, so keep the stamps clear of the edges.
  const padX = 34;
  const cellW = (W - padX * 2) / perRow;
  const cellH = (H - 10) / rows;
  const unit = Math.min(cellW, cellH);

  const slots: string[] = [];
  for (let index = 0; index < card.required; index += 1) {
    const cx = padX + cellW * (index % perRow) + cellW / 2;
    const cy = 5 + cellH * Math.floor(index / perRow) + cellH / 2;
    if (index < card.punches) {
      const ink = INKS[(index + seed) % INKS.length];
      const shape = (index + seed) % 3;
      const label = stampLabel(card.dates[index]);
      let outer = '';
      let inner = '';
      if (shape === 0) {
        const r = unit * 0.43;
        outer = `<circle r="${r}"/>`;
        inner = `<circle r="${r - 3.4}"/>`;
      } else if (shape === 1) {
        const w = Math.min(cellW * 0.9, unit * 1.05);
        const h = unit * 0.66;
        outer = `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="4"/>`;
        inner = `<rect x="${-w / 2 + 3.4}" y="${-h / 2 + 3.4}" width="${w - 6.8}" height="${h - 6.8}" rx="2.5"/>`;
      } else {
        const rx = Math.min(cellW * 0.47, unit * 0.54);
        const ry = unit * 0.35;
        outer = `<ellipse rx="${rx}" ry="${ry}"/>`;
        inner = `<ellipse rx="${rx - 3.4}" ry="${ry - 3.4}"/>`;
      }
      slots.push(`
        <g transform="translate(${cx} ${cy}) rotate(${rotationOf(index, seed)})" opacity="0.88" style="mix-blend-mode:multiply">
          <g fill="${ink}" fill-opacity="0.06" stroke="${ink}" stroke-width="2.2">${outer}</g>
          <g fill="none" stroke="${ink}" stroke-width="0.9">${inner}</g>
          <text y="${unit * 0.04}" text-anchor="middle" font-family="Oswald" font-weight="600" font-size="${unit * 0.22}" fill="${ink}">${label}</text>
          <text y="${unit * 0.2}" text-anchor="middle" font-family="Oswald" font-weight="500" font-size="${unit * 0.11}" letter-spacing="0.8" fill="${ink}">NO. ${index + 1}</text>
        </g>`);
    } else {
      const r = unit * 0.3;
      const isLast = index === card.required - 1;
      slots.push(`
        <g transform="translate(${cx} ${cy})">
          <circle r="${r}" fill="none" stroke="${card.ink}" stroke-opacity="0.42" stroke-width="1.2" stroke-dasharray="3.2 2.6"/>
          <text y="${unit * 0.06}" text-anchor="middle" font-family="Oswald" font-weight="500" font-size="${unit * (isLast ? 0.15 : 0.17)}" fill="${card.ink}" fill-opacity="0.6">${isLast ? 'FREE' : index + 1}</text>
        </g>`);
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <pattern id="lines" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(25)">
        <line x1="0" y1="0" x2="0" y2="7" stroke="#2E4A8A" stroke-opacity="0.07" stroke-width="0.6"/>
      </pattern>
      <pattern id="lines2" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(-25)">
        <line x1="0" y1="0" x2="0" y2="9" stroke="#A0302A" stroke-opacity="0.05" stroke-width="0.6"/>
      </pattern>
    </defs>
    <rect width="${W}" height="${H}" fill="${card.paper}"/>
    <rect width="${W}" height="${H}" fill="url(#lines)"/>
    <rect width="${W}" height="${H}" fill="url(#lines2)"/>
    ${slots.join('')}
  </svg>`;
  return render(svg, W * scale);
}

/** The logo slot: the restaurant's initials in a thin ring, like the passport page's header. */
export function monogram(initials: string, ink: string, scale: number) {
  const S = 50;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    <circle cx="25" cy="25" r="23.5" fill="none" stroke="${ink}" stroke-opacity="0.5" stroke-width="1.2"/>
    <text x="25" y="31.5" text-anchor="middle" font-family="Instrument Serif" font-size="20" fill="${ink}">${escape(initials)}</text>
  </svg>`;
  return render(svg, S * scale);
}

/** The app icon Wallet shows on the lock screen and in notifications: the JOEYY tile. */
export function joeyyIcon(size: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="29" height="29" viewBox="0 0 29 29">
    <rect width="29" height="29" rx="7" fill="#F47B35"/>
    <circle cx="14.5" cy="14.5" r="5.8" fill="#111522"/>
  </svg>`;
  return render(svg, size);
}
