// The stamp look shared by the web passport page (src/ui/passport.ts) and the Wallet pass artwork
// (server/pass-art.ts), so a place's stamps have the same inks, angles and dates everywhere.
// No DOM in here: the server imports it too.

export const INKS = ['#2E4A8A', '#A0302A', '#3B6B4A', '#6A3D8A'];
export const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** A small stable number from a business ID, so each place's stamps sit the same way every time. */
export function seedOf(text: string) {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 997;
  return value;
}

/** Each stamp's tilt in degrees, between -17 and 16. */
export const rotationOf = (index: number, seed: number) => (((index + seed) * 29) % 34) - 17;

/** "Norema Cafe" → "NC", "Tallow & Rye" → "TR". */
export function initials(name: string) {
  const words = name.replace(/&/g, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

/**
 * A visit time as a Date. A bare date (2026-11-11) means that calendar day: it's read as local noon,
 * because as UTC midnight it would land on the day before in the Americas.
 */
export function visitDate(iso: string): Date | undefined {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The date printed on a stamp, "NOV 11", or JOEYY when there's no date. */
export function stampLabel(iso?: string) {
  const date = iso ? visitDate(iso) : undefined;
  return date ? `${MONTHS[date.getMonth()]} ${date.getDate()}` : 'JOEYY';
}
