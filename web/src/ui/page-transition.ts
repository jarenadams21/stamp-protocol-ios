// Moving between pages: the old page drifts out and the new one drifts in from the side you're
// heading (back goes the other way), while the frosted header stays put. Built on the View
// Transitions API; browsers without it just swap the page. Reduce Motion gets a short fade (CSS).

let settle: (() => void) | undefined;

/** Longest the old page is held on screen while the next one loads. After that it swaps plainly. */
const HOLD_MS = 280;

export function transitionPage(direction: 'forward' | 'back', render: () => Promise<void>) {
  if (!document.startViewTransition || document.visibilityState === 'hidden') {
    void render();
    return;
  }
  let rendering: Promise<void> | undefined;
  const run = () => (rendering ??= render());
  const root = document.documentElement;
  root.dataset.nav = direction;
  const transition = document.startViewTransition(
    () =>
      new Promise<void>((done) => {
        // The page renders inside the update, after the old page is captured, so screens can
        // measure themselves as usual. pageMounted() ends the hold as soon as the new page is in.
        settle = done;
        window.setTimeout(done, HOLD_MS);
        void run().finally(done);
      }),
  );
  // A page that isn't getting frames (a throttled or hidden view) never captures the old page,
  // so the update never runs. Don't let that hold the page hostage: skip the effect and render.
  window.setTimeout(() => {
    if (rendering) return;
    transition.skipTransition();
    void run();
  }, HOLD_MS);
  transition.ready.catch(() => undefined);
  transition.updateCallbackDone.catch(() => undefined);
  void transition.finished.finally(() => {
    if (root.dataset.nav === direction) delete root.dataset.nav;
  });
}

/** Called by mount(): the new page is in the DOM, so the transition can capture it. */
export function pageMounted() {
  settle?.();
  settle = undefined;
}
