// Tiny DOM builder. Text is always set as text, never parsed as HTML, so business
// names and reward text from the API can't inject markup.

type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | EventListener | undefined> & {
  class?: string;
  style?: string;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  append(node, children);
  return node;
}

function append(node: Node, children: Child[]) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function announce(message: string) {
  const region = document.getElementById('announcer');
  if (!region) return;
  region.textContent = '';
  // A fresh text node after a tick makes screen readers read repeated messages too.
  setTimeout(() => (region.textContent = message), 30);
}

/**
 * A button's request is running: disabled, a spinner (CSS, from aria-busy) and words like
 * "Sending code…". Returns a function that puts the button back.
 */
export function busy(button: HTMLButtonElement, label: string) {
  const original = button.textContent ?? '';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  };
}

export function haptic(pattern: number | number[] = 12) {
  // Browsers only allow vibration after the person has interacted with the page.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* iOS Safari has no vibration API. */
  }
}

/** "A free espresso" → "a free espresso", for reward names in the middle of a sentence. */
export const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Milliseconds left as "1:05". Never negative. */
export function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
