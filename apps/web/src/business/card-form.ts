import type { Artwork, CardState, MerchantTheme, Typeface } from '../api/types';
import { coverArt } from '../ui/business';
import { el, haptic } from '../ui/dom';
import { passportPage } from '../ui/passport';
import { fontFor } from '../ui/theme';
import type { LiveProgram } from './api';
import type { PartnerBusiness, ProgramInput } from './types';

// The card an owner is making, and the controls that change it. Setup asks for it one step at a
// time; the Card page shows it all at once. Both draw the preview with the diner's own
// passportPage, so what the owner sees is exactly what a diner gets.

export interface Draft {
  name: string;
  location: string;
  reward: string;
  punches: number;
  theme: MerchantTheme;
  /** The live card's cover, set in the partner app. Publishing from here keeps it. */
  coverKey: string | null;
}

/** The API's limits (backend-spec §3.1). */
export const LIMITS = { name: 40, location: 120, reward: 60, punches: { min: 3, max: 12 } };

/** Paper and ink pairs that pass 4.5:1 in light and dark, so an owner can't pick an unreadable card. */
export const PAPERS: { name: string; theme: Pick<MerchantTheme, 'lightPaper' | 'lightInk' | 'darkPaper' | 'darkInk'> }[] = [
  { name: 'Oat', theme: { lightPaper: '#F7EFD9', lightInk: '#2F241E', darkPaper: '#2F241E', darkInk: '#F7EFD9' } },
  { name: 'Apricot', theme: { lightPaper: '#F5A174', lightInk: '#351B13', darkPaper: '#5C2C20', darkInk: '#FFE6D5' } },
  { name: 'Mist', theme: { lightPaper: '#DDE9F2', lightInk: '#213849', darkPaper: '#223844', darkInk: '#DCE8F2' } },
  { name: 'Rye', theme: { lightPaper: '#E8DFC8', lightInk: '#353E2D', darkPaper: '#31382D', darkInk: '#F0E7D2' } },
  { name: 'Blush', theme: { lightPaper: '#F3D9C9', lightInk: '#4A1F1A', darkPaper: '#4A1F1A', darkInk: '#F3D9C9' } },
  { name: 'Lilac', theme: { lightPaper: '#E9E2F4', lightInk: '#2E2346', darkPaper: '#2E2346', darkInk: '#E9E2F4' } },
  { name: 'Butter', theme: { lightPaper: '#F6E7A8', lightInk: '#3B2E07', darkPaper: '#3B2E07', darkInk: '#F6E7A8' } },
  { name: 'Sage', theme: { lightPaper: '#CFE7DF', lightInk: '#123B33', darkPaper: '#123B33', darkInk: '#CFE7DF' } },
];

const TYPEFACES: { value: Typeface; name: string }[] = [
  { value: 'standard', name: 'Plain' },
  { value: 'rounded', name: 'Rounded' },
  { value: 'serif', name: 'Serif' },
  { value: 'monospaced', name: 'Typewriter' },
];

const ARTWORK: { value: Artwork; name: string }[] = [
  { value: 'rail', name: 'Rails' },
  { value: 'cloud', name: 'Clouds' },
  { value: 'stone', name: 'Stones' },
];

export const REWARD_IDEAS = ['A free coffee', 'A free pastry', 'Any drink on the menu', 'A free bowl'];

export function draftFrom(business: PartnerBusiness | null, program: LiveProgram | null): Draft {
  return {
    name: business?.name ?? '',
    location: business?.location ?? '',
    reward: program?.rewardDescription ?? '',
    punches: program?.requiredPunches ?? 8,
    theme: program?.theme ?? { ...PAPERS[0].theme, typeface: 'serif', artwork: 'cloud', allowsMotion: true },
    coverKey: program?.coverKey ?? null,
  };
}

/** The draft's card as POST /v1/partner/program/versions takes it. */
export function programInput(draft: Draft): ProgramInput {
  const { coverURL: _shownOnly, ...theme } = draft.theme;
  return { requiredPunches: draft.punches, rewardDescription: draft.reward.trim(), theme: { ...theme, coverKey: draft.coverKey } };
}

/** The draft as a diner's card a few visits in, for the preview. */
function previewState(draft: Draft): CardState {
  const shown = Math.min(3, draft.punches - 1);
  const day = 86_400_000;
  return {
    business: { id: draft.name || 'preview', name: draft.name || 'Your place', location: draft.location || 'Your neighbourhood' },
    program: { versionId: 'preview', version: 0, requiredPunches: draft.punches, rewardDescription: draft.reward || 'Your reward', theme: draft.theme },
    card: { cardId: 'preview', punches: shown, requiredPunches: draft.punches, status: 'active' },
    rewardsAvailable: [],
    recentVisits: Array.from({ length: shown }, (_, index) => new Date(Date.now() - index * 4 * day).toISOString()),
  };
}

/** The live card. `update()` redraws it from the draft. */
export function preview(draft: Draft) {
  const root = el('figure', { class: 'preview', 'aria-label': 'Your card as diners see it' });
  const update = () => root.replaceChildren(passportPage(previewState(draft)).root);
  update();
  return { root, update };
}

let fieldCount = 0;

export function textField(label: string, value: string, onInput: (value: string) => void, options: { help?: string; max?: number; autocomplete?: string; placeholder?: string } = {}) {
  const id = `f${(fieldCount += 1)}`;
  const input = el('input', {
    class: 'field-input', id, value, maxlength: options.max ?? 40, autocomplete: options.autocomplete ?? 'off',
    placeholder: options.placeholder ?? '',
    'aria-describedby': options.help ? `${id}-help` : undefined,
  });
  input.addEventListener('input', () => onInput(input.value));
  return el(
    'div',
    { class: 'biz-field' },
    el('label', { class: 'field-label', for: id }, label),
    input,
    options.help ? el('p', { class: 'field-help', id: `${id}-help` }, options.help) : null,
  );
}

/** Suggested rewards under the reward field: a tap fills it in. */
export function ideas(input: () => HTMLInputElement | null, onPick: (value: string) => void) {
  return el('div', { class: 'idea-row', role: 'group', 'aria-label': 'Ideas' },
    ...REWARD_IDEAS.map((idea) => el('button', {
      class: 'idea', type: 'button',
      onclick: () => {
        const field = input();
        if (field) field.value = idea;
        onPick(idea);
      },
    }, idea)));
}

export function stepper(label: string, value: number, onChange: (value: number) => void) {
  const out = el('output', { class: 'stepper-value', 'aria-live': 'polite' }, String(value));
  const { min, max } = LIMITS.punches;
  let current = value;
  const set = (next: number) => {
    current = Math.min(max, Math.max(min, next));
    out.textContent = String(current);
    less.disabled = current <= min;
    more.disabled = current >= max;
    haptic(6);
    onChange(current);
  };
  const less = el('button', { class: 'stepper-button', type: 'button', 'aria-label': 'Fewer stamps', onclick: () => set(current - 1) }, '−');
  const more = el('button', { class: 'stepper-button', type: 'button', 'aria-label': 'More stamps', onclick: () => set(current + 1) }, '+');
  less.disabled = current <= min;
  more.disabled = current >= max;
  return el('div', { class: 'biz-field' },
    el('span', { class: 'field-label' }, label),
    el('div', { class: 'stepper', role: 'group', 'aria-label': label }, less, out, more),
    el('p', { class: 'field-help' }, 'Most places pick 6 to 10. Fewer stamps bring people back sooner.'));
}

/** A row of radio buttons drawn as swatches or chips. */
function choices<T>(label: string, items: { value: T; name: string; face: Node }[], selected: (value: T) => boolean, onPick: (value: T) => void, kind: string) {
  const name = `c${(fieldCount += 1)}`;
  return el('fieldset', { class: `biz-field choice-set is-${kind}` },
    el('legend', { class: 'field-label' }, label),
    el('div', { class: 'choice-row' }, ...items.map((item) => {
      const input = el('input', { type: 'radio', name, class: 'choice-input', checked: selected(item.value) });
      input.addEventListener('change', () => {
        haptic(6);
        onPick(item.value);
      });
      return el('label', { class: 'choice' }, input, item.face, el('span', { class: 'choice-name' }, item.name));
    })));
}

export function lookFields(draft: Draft, onChange: () => void) {
  const paper = choices('Paper',
    PAPERS.map((item) => ({ value: item, name: item.name, face: el('span', { class: 'swatch', style: `--swatch:${item.theme.lightPaper};--swatch-ink:${item.theme.lightInk}` }) })),
    (item) => item.theme.lightPaper === draft.theme.lightPaper,
    (item) => { draft.theme = { ...draft.theme, ...item.theme }; onChange(); },
    'paper');
  const type = choices('Lettering',
    TYPEFACES.map((item) => ({ value: item.value, name: item.name, face: el('span', { class: 'type-face', style: `font-family:${fontFor(item.value)}` }, 'Aa') })),
    (value) => value === draft.theme.typeface,
    (value) => { draft.theme = { ...draft.theme, typeface: value }; onChange(); },
    'type');
  const art = choices('Cover pattern',
    ARTWORK.map((item) => ({ value: item.value, name: item.name, face: el('span', { class: 'art-face', 'data-stock': item.value }, coverArt(item.value, 'preview')) })),
    (value) => value === draft.theme.artwork,
    (value) => { draft.theme = { ...draft.theme, artwork: value }; onChange(); },
    'art');
  return [paper, type, art];
}
