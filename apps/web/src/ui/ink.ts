// Paper and ink drawn on canvas, because CSS shapes read as a picture of a stamp, not ink on paper.
// Three things live here: a business's paper (mottled colour, tooth, fibres, a security print and
// rosette in its own ink), a rubber-stamp impression (heavy, patchy ink with a rocked double edge
// and stray specks), and the rubber stamp itself seen from above, for the stamp page. Each is drawn
// once and cached; the card and the stamp page show the same images, so a stamp looks the same
// wherever it appears. Nothing here draws per frame except the stamp page's animation.

export type StampShape = 'round' | 'rect' | 'oval';

const DPR = () => Math.min(2, window.devicePixelRatio || 1);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1 over a grid of `cell`-sized squares, wrapping at the edges. */
function valueNoise(w: number, h: number, cell: number, seed: number) {
  const random = rng(seed);
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = Float32Array.from({ length: gw * gh }, random);
  const at = (i: number, j: number) => grid[(((j % gh) + gh) % gh) * gw + (((i % gw) + gw) % gw)];
  return (x: number, y: number) => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

function canvas(width: number, height: number) {
  const ratio = DPR();
  const node = document.createElement('canvas');
  node.width = Math.round(width * ratio);
  node.height = Math.round(height * ratio);
  const g = node.getContext('2d')!;
  g.scale(ratio, ratio);
  return { node, g, ratio };
}

// ---------- Paper ----------

const PAPER_SIZE = 420;
const papers = new Map<string, { node: HTMLCanvasElement; url: string }>();

/** A business's paper as a canvas (for the stamp page) and an image URL (for the card's CSS). */
export function paper(base: string, ink: string) {
  const key = `${base}${ink}`;
  const cached = papers.get(key);
  if (cached) return cached;
  const size = PAPER_SIZE;
  // Drawn at 1x: grain is meant to be soft, and a card list may draw several papers on load.
  const node = document.createElement('canvas');
  node.width = size;
  node.height = size;
  const g = node.getContext('2d')!;
  const ratio = 1;
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  // Mottling (big soft blotches) and tooth (fine grain), pixel by pixel.
  const seed = parseInt(base.slice(1), 16) || 7;
  const blotch = valueNoise(size, size, 52, seed);
  const fleck = valueNoise(size, size, 14, seed + 5);
  const random = rng(seed + 3);
  const image = g.getImageData(0, 0, node.width, node.height);
  const px = image.data;
  for (let y = 0; y < node.height; y += 1) {
    for (let x = 0; x < node.width; x += 1) {
      const i = (y * node.width + x) * 4;
      const ux = x / ratio;
      const uy = y / ratio;
      const v = (blotch(ux, uy) - 0.5) * 24 + (fleck(ux, uy) - 0.5) * 10 + (random() - 0.5) * 26;
      px[i] = Math.max(0, Math.min(255, px[i] + v));
      px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + v));
      px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + v * 0.9));
    }
  }
  g.putImageData(image, 0, 0);
  // Fibres: short curved strands, mostly lighter than the paper, a few darker.
  for (let k = 0; k < 440; k += 1) {
    const x = random() * size;
    const y = random() * size;
    const length = 6 + random() * 24;
    const angle = random() * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(
      x + Math.cos(angle + 0.6) * length * 0.5, y + Math.sin(angle + 0.6) * length * 0.5,
      x + Math.cos(angle) * length, y + Math.sin(angle) * length,
    );
    g.lineWidth = 0.4 + random() * 0.7;
    g.strokeStyle = random() < 0.62 ? `rgba(255,255,255,${0.14 + random() * 0.2})` : `rgba(60,40,20,${0.05 + random() * 0.08})`;
    g.stroke();
  }
  // The security print and a rosette, in the business's own ink, spread slightly into the paper.
  g.save();
  g.globalAlpha = 0.08;
  g.strokeStyle = ink;
  g.lineWidth = 0.7;
  g.filter = 'blur(0.35px)';
  for (let row = -1; row < size / 26 + 1; row += 1) {
    for (const phase of [0, Math.PI]) {
      g.beginPath();
      for (let x = 0; x <= size; x += 4) {
        const y = row * 26 + 13 + Math.sin(x / 22 + phase) * 6;
        if (x) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
    }
  }
  g.globalAlpha = 0.06;
  g.translate(size - 30, size - 30);
  for (let k = 0; k < 36; k += 1) {
    g.rotate(Math.PI / 18);
    g.beginPath();
    g.ellipse(0, 76, 28, 76, 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
  const made = { node, url: node.toDataURL('image/png') };
  papers.set(key, made);
  return made;
}

// ---------- Ink ----------

export interface ImpressionSpec {
  ink: string;
  shape: StampShape;
  /** The big line: a date ("NOV 22") or initials. */
  label: string;
  /** The small line under it ("NO. 4"), or none. */
  sub?: string;
  seed: number;
}

const impressions = new Map<string, HTMLCanvasElement>();
const urls = new Map<string, string>();
const fontsReady = () => !('fonts' in document) || document.fonts.check('600 16px Oswald');

/**
 * A rubber-stamp impression, unrotated (callers turn it), on a transparent square with room for
 * stray specks. `size` is the stamp's width in CSS pixels.
 */
export function impression(spec: ImpressionSpec, size: number): HTMLCanvasElement {
  const key = `${spec.ink}|${spec.shape}|${spec.label}|${spec.sub ?? ''}|${spec.seed}|${size}|${fontsReady()}`;
  const cached = impressions.get(key);
  if (cached) return cached;
  const pad = size * 0.14;
  const side = size + pad * 2;
  const { node, g, ratio } = canvas(side, side);
  const [r, gr, b] = rgb(spec.ink);
  const colour = (alpha: number) => `rgba(${r},${gr},${b},${alpha})`;
  g.translate(side / 2, side / 2);
  const rx = spec.shape === 'rect' ? size * 0.48 : size * (spec.shape === 'oval' ? 0.5 : 0.46);
  const ry = spec.shape === 'rect' ? size * 0.33 : size * (spec.shape === 'oval' ? 0.35 : 0.46);
  const drawFace = (line: number, alpha: number) => {
    g.strokeStyle = colour(alpha);
    g.fillStyle = colour(alpha);
    for (const [inset, width] of [[0, line * 1.6], [line * 2.7, line * 0.8]]) {
      g.lineWidth = width;
      g.beginPath();
      if (spec.shape === 'rect') g.roundRect(-rx + inset, -ry + inset, (rx - inset) * 2, (ry - inset) * 2, size * 0.05);
      else g.ellipse(0, 0, rx - inset, ry - inset, 0, 0, Math.PI * 2);
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${size * (spec.sub ? 0.22 : 0.3)}px Oswald, 'Arial Narrow', sans-serif`;
    g.fillText(spec.label, 0, spec.sub ? -size * 0.03 : 0);
    if (spec.sub) {
      g.font = `600 ${size * 0.09}px Oswald, 'Arial Narrow', sans-serif`;
      g.fillText(spec.sub, 0, size * 0.15);
    }
  };
  // Ink pools at the rubber's edges (a soft, wider pass), then the crisp face.
  g.save();
  g.filter = `blur(${size * 0.012}px)`;
  drawFace(size * 0.03, 0.45);
  g.restore();
  drawFace(size * 0.024, 0.95);
  // The faint second edge of a stamp that rocked as it was pressed.
  g.save();
  g.translate(size * 0.012, -size * 0.008);
  g.globalAlpha = 0.18;
  drawFace(size * 0.02, 1);
  g.restore();
  // Erode: rubber never inks evenly. Gaps follow a noise field; the rest is a little uneven.
  const image = g.getImageData(0, 0, node.width, node.height);
  const px = image.data;
  const random = rng(spec.seed);
  const coarse = valueNoise(node.width, node.height, 9 * ratio * (size / 150), spec.seed);
  const fine = valueNoise(node.width, node.height, 2.2 * ratio, spec.seed + 11);
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const p = i / 4;
    const x = p % node.width;
    const y = (p / node.width) | 0;
    const k = coarse(x, y) * 0.65 + fine(x, y) * 0.55 + (random() - 0.5) * 0.25;
    const keep = k < 0.42 ? 0 : k < 0.52 ? (k - 0.42) * 10 : 1;
    px[i + 3] = px[i + 3] * keep * (0.82 + fine(x, y) * 0.3);
  }
  g.putImageData(image, 0, 0);
  // Stray specks of ink around the rim.
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  for (let k = 0; k < 24; k += 1) {
    const angle = random() * Math.PI * 2;
    const distance = size * (0.44 + random() * 0.18);
    g.fillStyle = colour(0.25 + random() * 0.5);
    g.beginPath();
    g.arc(side / 2 + Math.cos(angle) * distance, side / 2 + Math.sin(angle) * distance * 0.8, (0.4 + random() * 1.3) * (size / 120), 0, Math.PI * 2);
    g.fill();
  }
  impressions.set(key, node);
  return node;
}

/** The impression as an image URL, for an <img> on the card. Redrawn once Oswald has loaded. */
export function impressionURL(spec: ImpressionSpec, size: number) {
  const key = `${spec.ink}|${spec.shape}|${spec.label}|${spec.sub ?? ''}|${spec.seed}|${size}|${fontsReady()}`;
  let url = urls.get(key);
  if (!url) {
    url = impression(spec, size).toDataURL('image/png');
    urls.set(key, url);
  }
  return url;
}

/** The share of an impression's square taken by the stamp itself (the rest is room for specks). */
export const IMPRESSION_SCALE = 1 / 1.28;

// ---------- The rubber stamp, seen from above ----------

/**
 * The stamp as the diner would see it looking down at the paper: a square wooden block with a
 * round knob on top, lit from the top left, turned to the angle its impression will land at. The
 * caller sets `size` larger while it's lifted, since nearer the eye looks bigger.
 */
export function drawStampFromAbove(g: CanvasRenderingContext2D, x: number, y: number, size: number, angle: number, ink: string) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  const half = size * 0.52;
  // The inked rubber just showing beyond the block's edge.
  g.fillStyle = ink;
  g.globalAlpha = 0.9;
  g.beginPath();
  g.roundRect(-half - 2, -half - 2, half * 2 + 4, half * 2 + 4, size * 0.09);
  g.fill();
  g.globalAlpha = 1;
  // The block's top face: warm wood, lighter at the top left, with grain running across.
  const wood = g.createLinearGradient(-half, -half, half, half);
  wood.addColorStop(0, '#c48a52');
  wood.addColorStop(0.5, '#a06a38');
  wood.addColorStop(1, '#6e4524');
  g.fillStyle = wood;
  g.beginPath();
  g.roundRect(-half, -half, half * 2, half * 2, size * 0.08);
  g.fill();
  g.save();
  g.clip();
  g.strokeStyle = 'rgba(60, 32, 12, 0.22)';
  g.lineWidth = 1;
  for (let k = -8; k <= 8; k += 1) {
    g.beginPath();
    g.moveTo(-half, k * half * 0.13);
    g.bezierCurveTo(-half * 0.3, k * half * 0.13 - 6, half * 0.3, k * half * 0.13 + 6, half, k * half * 0.13);
    g.stroke();
  }
  g.restore();
  // A bevel: light catches the top-left edges, shadow the bottom-right.
  g.lineWidth = Math.max(2, size * 0.025);
  g.strokeStyle = 'rgba(255, 230, 200, 0.45)';
  g.beginPath();
  g.moveTo(-half + 4, half - 6);
  g.lineTo(-half + 4, -half + 4);
  g.lineTo(half - 6, -half + 4);
  g.stroke();
  g.strokeStyle = 'rgba(40, 20, 6, 0.4)';
  g.beginPath();
  g.moveTo(half - 4, -half + 6);
  g.lineTo(half - 4, half - 4);
  g.lineTo(-half + 6, half - 4);
  g.stroke();
  // The knob: a turned wooden dome with rings and a highlight.
  const knob = size * 0.27;
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = size * 0.06;
  g.shadowOffsetX = size * 0.02;
  g.shadowOffsetY = size * 0.03;
  const dome = g.createRadialGradient(-knob * 0.35, -knob * 0.35, knob * 0.1, 0, 0, knob);
  dome.addColorStop(0, '#e8b27a');
  dome.addColorStop(0.6, '#a8713c');
  dome.addColorStop(1, '#5e3b1d');
  g.fillStyle = dome;
  g.beginPath();
  g.arc(0, 0, knob, 0, Math.PI * 2);
  g.fill();
  g.shadowColor = 'transparent';
  g.strokeStyle = 'rgba(70, 38, 14, 0.25)';
  g.lineWidth = 1;
  for (const ring of [0.45, 0.7, 0.88]) {
    g.beginPath();
    g.arc(0, 0, knob * ring, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = 'rgba(255, 245, 230, 0.35)';
  g.beginPath();
  g.ellipse(-knob * 0.35, -knob * 0.4, knob * 0.28, knob * 0.16, -0.6, 0, Math.PI * 2);
  g.fill();
  g.restore();
}
