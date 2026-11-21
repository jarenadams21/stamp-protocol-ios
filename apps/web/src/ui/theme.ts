import type { MerchantTheme, Typeface } from '../api';
import { readable } from './contrast';

// Same typeface choices as MerchantTheme.Typeface in the iOS app. The ui-* generic families
// resolve to SF Pro Rounded, New York and SF Mono on Apple devices, matching the app exactly.
const FONT_STACKS: Record<Typeface, string> = {
  standard: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, "New York", "Iowan Old Style", Georgia, "Times New Roman", serif',
  monospaced: 'ui-monospace, "SF Mono", Menlo, "Roboto Mono", Consolas, monospace',
};

const FALLBACK = { lightPaper: '#FFFFFF', lightInk: '#191B18', darkPaper: '#1C1F1E', darkInk: '#F2F3EF' };

/** Applies a business's published card theme to the page (card, wash, staff screen). */
export function applyMerchantTheme(theme: MerchantTheme | undefined, root: HTMLElement = document.documentElement) {
  let colors = FALLBACK;
  if (theme) {
    const candidate = {
      lightPaper: theme.lightPaper, lightInk: theme.lightInk,
      darkPaper: theme.darkPaper, darkInk: theme.darkInk,
    };
    // The server validates 4.5:1 on publish (backend-spec §3.1); re-check so a bad theme never ships unreadable text.
    if (readable(candidate)) colors = candidate;
  }
  root.style.setProperty('--m-light-paper', colors.lightPaper);
  root.style.setProperty('--m-light-ink', colors.lightInk);
  root.style.setProperty('--m-dark-paper', colors.darkPaper);
  root.style.setProperty('--m-dark-ink', colors.darkInk);
  root.style.setProperty('--m-font', FONT_STACKS[theme?.typeface ?? 'standard']);
  root.dataset.merchant = theme ? 'on' : 'off';

  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#111522');
}

/** Back to the JOEYY passport: the cream page and ink from tokens.css, not a restaurant's. */
export function clearMerchantTheme(root: HTMLElement = document.documentElement) {
  for (const name of ['--m-light-paper', '--m-light-ink', '--m-dark-paper', '--m-dark-ink', '--m-font']) root.style.removeProperty(name);
  root.dataset.merchant = 'off';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#111522');
}

export const fontFor = (typeface: Typeface) => FONT_STACKS[typeface];
