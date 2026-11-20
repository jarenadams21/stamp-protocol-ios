import { transitionPage } from './ui/page-transition';

type Render = (params: Record<string, string>, query: URLSearchParams) => void | Promise<void>;

const routes: { pattern: RegExp; keys: string[]; render: Render }[] = [];

export function route(path: string, render: Render) {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:(\w+)/g, (_match, key: string) => {
      keys.push(key);
      return '([^/]+)';
    })}/?$`,
  );
  routes.push({ pattern, keys, render });
}

export async function resolve() {
  const { pathname, search } = window.location;
  for (const entry of routes) {
    const match = entry.pattern.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    entry.keys.forEach((key, index) => (params[key] = decodeURIComponent(match[index + 1])));
    await entry.render(params, new URLSearchParams(search));
    return;
  }
  navigate('/', { replace: true });
}

// How deep in this tab's history we are, so the page transition knows back from forward.
let depth: number = history.state?.depth ?? 0;

export function navigate(path: string, options: { replace?: boolean } = {}) {
  if (options.replace) history.replaceState({ depth }, '', path);
  else history.pushState({ depth: (depth += 1) }, '', path);
  transitionPage('forward', () => {
    window.scrollTo(0, 0);
    return resolve();
  });
}

/** Same-origin links go through the router instead of a full page load. */
export function interceptLinks() {
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest('a');
    if (!anchor || anchor.target || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  });
  window.addEventListener('popstate', (event) => {
    const to: number = (event.state as { depth?: number } | null)?.depth ?? 0;
    const direction = to < depth ? 'back' : 'forward';
    depth = to;
    transitionPage(direction, resolve);
  });
}
