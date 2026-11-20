// The 4.5:1 rule for a card's paper and ink (WCAG AA for body text). Shared by the page, which
// re-checks a published theme, and the demo backend, which refuses a card that fails it.

function luminance(hex: string) {
  const value = parseInt(hex.replace('#', ''), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const isHex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** True when both the light and dark pairs are valid colours that read at 4.5:1. */
export const readable = (theme: { lightPaper: string; lightInk: string; darkPaper: string; darkInk: string }) =>
  [theme.lightPaper, theme.lightInk, theme.darkPaper, theme.darkInk].every(isHex)
  && contrast(theme.lightPaper, theme.lightInk) >= 4.5
  && contrast(theme.darkPaper, theme.darkInk) >= 4.5;
