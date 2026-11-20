# JOEYY web: rules for this repo

The page a diner sees after tapping a JOEYY stand: their stamp card, rewards, Wallet pass and
sign-in, with no app. Mobile first. Read README.md for the tour and docs/identity-and-api.md for
the backend contract.

## Run and check

- `npm run dev`: demo mode on port 5180, with the demo backend (server/demo) and sample data.
- `npm run typecheck`: both tsconfigs (src/ and server/). Must pass before a commit.
- `npm run build:demo` and `VITE_API_BASE=https://api.example.test npm run build`: both must pass.
  A prod build without VITE_API_BASE must fail. The prod bundle must contain no demo code.
- Check UI changes in a browser at 390px and 320px wide, with no console errors.

## How the code is laid out

- `src/api/types.ts` is the contract (StampApi). `src/api/http.ts` calls the real backend;
  `src/api/demo.ts` adds demo-only calls. Any route change updates types.ts, http.ts,
  server/demo/routes.ts and docs/identity-and-api.md together.
- `src/screens/` are pages, `src/ui/` are pieces. A card looks the same everywhere because the tap
  page and an opened card both use `cardSections()` in src/screens/shared.ts. Keep it that way.
- `server/demo/` stands in for the real backend and must follow the same rules (replay protection,
  merge rules, single-use redemption). Demo-only routes live under /api/demo and only exist in demo mode.
- `server/apple-pass.ts`, `server/pass-art.ts`, `server/apns.ts`: Wallet passes and their updates.

## Rules

- **Colours only from theme tokens** in src/styles/tokens.css (navy `--paper`, `--surface`, `--text`,
  `--muted`, `--rule`, `--accent`, `--accent-fill`, `--ok`, `--ok-solid`) and the restaurant's own
  `--card-paper` / `--page-paper` / `--page-ink`. No new hex colours in components.
- **Type:** Instrument Serif for headings, Oswald for figures and stamps, the system font for UI text.
- **Copy:** plain words from the diner's side, sentence case, short. Buttons say what happens.
- **Security:** never trust the browser. Every tap is checked on the server, counters must go up,
  rewards are used once, pass links only open stamp cards. Never log or commit secrets: `.wallet/`
  (signing key, certificates) and `.demo/` stay git-ignored.
- **Wallet:** a pass's webServiceURL must be HTTPS, or iOS refuses the pass. Keep the http check in
  server/demo/service.ts.
- **No dead code:** when you replace something, delete the old code, its CSS and its docs.
- **Design changes** get a DESIGN_LOG.md entry with phone screenshots in docs/iterations/ and a
  `design-vX.Y` tag.
