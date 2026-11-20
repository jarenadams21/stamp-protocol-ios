import { el, svg } from './dom';

// Line icons for panel titles and the tab bar: one 24px grid, 1.6 stroke, round ends, drawn in
// currentColor so they take the theme's ink wherever they sit.

const PATHS = {
  cards: ['M4 9.5h16v10H4z', 'M6 6.5h12', 'M8 3.5h8'],
  compass: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'm15.5 8.5-2 5-5 2 2-5 5-2Z'],
  passport: ['M6 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6z', 'M12 8.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z', 'M9.5 17h5'],
  flag: ['M5 21V4', 'M5 4.5h11l-2 3.5 2 3.5H5'],
  gift: ['M4 10h16v3H4z', 'M5.5 13h13v7h-13z', 'M12 10v10', 'M12 10c-1.5-3.5-5-3.5-5-1.5S10 10 12 10Zm0 0c1.5-3.5 5-3.5 5-1.5S14 10 12 10Z'],
  bookmark: ['M7 3.5h10v17l-5-3.5-5 3.5z'],
  pin: ['M12 21s6.5-6 6.5-11a6.5 6.5 0 1 0-13 0c0 5 6.5 11 6.5 11Z', 'M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3.5v4', 'M16 3.5v4'],
  stamp: ['M9 4h6l-1 7h-4z', 'M5 14h14v3H5z', 'M7 20h10'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7.5V12l3 2'],
  person: ['M12 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z', 'M5 20c.8-3.8 3.6-6 7-6s6.2 2.2 7 6'],
  question: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.4', 'M12 16.8v.2'],
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 20) {
  return svg(
    'svg',
    { class: 'icon', width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    ...PATHS[name].map((d) => svg('path', { d })),
  );
}

/** A panel's title: the icon in a small ring, then the words in the passport serif. */
export function panelTitle(name: IconName, text: string, id?: string) {
  return el('h2', { class: 'section-title panel-title', id }, el('span', { class: 'panel-icon' }, icon(name, 18)), text);
}
