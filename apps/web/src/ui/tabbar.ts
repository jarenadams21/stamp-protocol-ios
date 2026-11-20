import { el, haptic } from './dom';
import { icon, type IconName } from './icons';

// The app frame: three tabs along the bottom, like the iOS app. It lives outside #app so it
// stays put while pages change, and hides on screens that take the whole phone (the staff
// screen, a reward being used, a tap being checked).

const TABS: { href: string; label: string; icon: IconName; matches: RegExp }[] = [
  { href: '/c', label: 'Cards', icon: 'cards', matches: /^\/(c(\/.*)?|t|[wr]\/.*)?$/ },
  { href: '/discover', label: 'Discover', icon: 'compass', matches: /^\/discover$/ },
  { href: '/me', label: 'Passport', icon: 'passport', matches: /^\/me$/ },
];

// The business site (src/business) has its own navigation in its header.
const FULL_SCREEN = ['page-staff', 'page-redeem', 'page-verifying', 'page-business'];

let bar: HTMLElement | undefined;

function build() {
  return el(
    'nav',
    { class: 'tabbar', 'aria-label': 'Main' },
    ...TABS.map((tab) =>
      el(
        'a',
        { class: 'tab', href: tab.href, onclick: () => haptic(8) },
        el('span', { class: 'tab-icon' }, icon(tab.icon, 24)),
        el('span', { class: 'tab-label' }, tab.label),
      )),
  );
}

/** Call after every page change: shows the bar (or not) and marks the current tab. */
export function syncTabBar(page: Element | null) {
  bar ??= document.body.appendChild(build());
  const hidden = !page || FULL_SCREEN.some((name) => page.classList.contains(name));
  bar.hidden = hidden;
  document.body.classList.toggle('has-tabbar', !hidden);
  const path = window.location.pathname;
  bar.querySelectorAll<HTMLAnchorElement>('.tab').forEach((link, index) => {
    if (TABS[index].matches.test(path)) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}
