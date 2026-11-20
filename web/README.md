# JOEYY web

The page a diner sees when they tap a JOEYY stand without the app: the stamp lands on their card,
and they can save it to Wallet, get the app, or keep it by signing in with Apple, Google or a
phone number. Built for phones.

Every design iteration, with screenshots, is in [DESIGN_LOG.md](DESIGN_LOG.md).

## Run it

```bash
npm install
npm run dev
```

Open the URL it prints on your phone (same Wi-Fi) or in a mobile-sized browser window.

`npm run dev` also runs a **demo backend** (`server/demo`) on the same address. It answers the
same `/v1/web` routes the real backend will, with eight sample places, and keeps its data in
`.demo/state.json`, so every phone and laptop on the Wi-Fi shares one set of cards, accounts and
Wallet passes. Each browser is a separate "phone", identified by a cookie, as in production.

The bar at the top has two demo tools:
- **Preview states** jumps to any moment: first tap, a full card, a new phone with an account,
  a Wallet pass link, using a reward, every error, the card styles. "Start over on this phone"
  gives this browser a fresh, empty identity.
- **Add a stamp** taps the stand of the card on screen, so a card (and its Wallet pass) can
  fill up one visit at a time.

There's no built-in limit on repeat taps: each new tap stamps. A business can set its own minimum
gap (`minMinutesBetweenStamps` on its program); in the sample data only Sunday Ramen does (30
minutes), so a second tap there shows "Already stamped". Reopening an old tap link never stamps.

## Demo vs production

There are two builds, picked with Vite's `--mode` (the scripts below pass it). The page reads it
as `import.meta.env.VITE_MODE`.

| | Demo (`--mode demo`) | Production (`--mode prod`) |
| --- | --- | --- |
| Backend | The demo backend in `server/demo`, inside the Vite server | The real one at `VITE_API_BASE` (required) |
| Data | Sample places and cards in `.demo/state.json` | Real diners |
| Sample data bar, Preview states, Add a stamp, "Preview: tap the stand" | Yes | Not in the bundle |
| Stand-in Apple / Google consent sheet (marked as a preview), `123456` code hint | Yes | No: the real Apple and Google pages |
| Apple Wallet signing (`/api/wallet/apple/*`) | In the Vite server, with `.wallet/` certificates | The backend signs (`POST /v1/web/cards/{cardId}/wallet`) |
| `VITE_API_BASE` | Ignored, with a warning | Build fails without it |

| Command | What it does |
| --- | --- |
| `npm run dev` | Demo on your network, for pitches on phones (e.g. http://10.0.0.184:5180) |
| `npm run build:demo` | Demo build in `dist/` |
| `npm run preview:demo` | Builds the demo, then serves it with the demo backend |
| `VITE_API_BASE=https://api.example.com npm run dev:prod` | The page against the real backend, with hot reload |
| `VITE_API_BASE=https://api.example.com npm run build` | Production build in `dist/` |
| `VITE_API_BASE=https://api.example.com npm run preview` | Builds production, then serves it (no demo backend) |

Nothing falls back to the demo by accident. Plain `vite build` counts as production, so a build
with no API base stops with an error and never ships sample data. Demo-only code sits behind
`import.meta.env.VITE_MODE === 'demo'` (or `isDemo`) with dynamic imports (`src/main.ts`,
`src/api/index.ts`, `src/screens/redeem.ts`, `src/ui/components.ts`), so Vite drops it from the
production bundle. To check, grep `dist/assets`
for `Preview states`: it should be there after `build:demo` and missing after `build`.

## What's on the card page

The page is a **passport in a Wallet stack** (the direction picked on the design canvas, 2026-11-11):

- A card looks the same wherever it opens (a tap, the Wallet link, Your cards): **All cards** above
  it, the page itself (outlined with a **Just stamped** badge after a tap), its sections, then
  **Your other cards**.
- Each visit is its own **rubber-stamp impression** with the visit's real date (from
  `recentVisits`), in rotating ink colours and stamp shapes. A new stamp lands with a press
  animation (it drops, squashes and splashes ink) and a **New** tag under it. Empty slots are dashed, the last one reads "Free".
- Under the page (`cardSections()` in `src/screens/shared.ts`): the next reward drawn as the reward
  filling up (a cup, bowl, teapot, loaf or cone), rewards ready (tickets that print out when a card
  fills), **Keep this card** as three tiles (Wallet, Save cards with Apple, Google or a mobile
  number, and the app), "About this place" (cover art, logo badge, type of place, address, today's
  hours, directions), visits as a row of date stamps, "How this card works" as three stamps,
  "How JOEYY works", and the diner's other cards. New places live in the Discover tab.
- **Your cards** (`/c`) behaves like Apple Wallet: the cards sit in an overlapping list; tap one
  and it slides up and opens while the rest slide down and fade away, so only that card shows;
  "All cards" (or Escape) slides the list back. An opened card shows the same sections as the
  card page (both use `cardSections()`), then **Your other cards**. Cards deal in one after another
  on arrival, the opened card lifts on a spring, and the rest cascade away and back. Swipe sideways
  on an open card to go to the next one: it follows your finger, the next card slides in alongside,
  and a flick or a pull past a third of the way switches (the first and last cards resist). Rewards ready sit above the list while no card is open. Opening a card puts it in the
  address (`/c?open=<businessId>`), so a reload or shared link opens straight to it; after a tap
  the address becomes the same.
- **The app frame:** a blurred header that stays at the top, and a tab bar along the bottom
  (Cards, Discover, Passport) on every page except the staff screen, a reward being used and a tap
  being checked (`src/ui/tabbar.ts`). Each section under a card is its own panel with a line icon
  in its title (`src/ui/icons.ts`), so a long page scans in blocks.
- **Things that change over time** (`src/ui/progress.ts`), worked out from `recentVisits`,
  punches and rewards with no extra API: milestones under a card's progress ("5th visit this
  month", "2 stamps to go", "3 weeks in a row"), the card closest to its reward on Your cards, and
  **Recent stamps** across places on the passport page.
- **Waiting and empty moments** (`src/ui/placeholders.ts`): card-shaped skeletons while cards load
  (only if it takes long enough to notice), and a small drawing with one action when there's
  nothing yet. When a tap fills a card, it pulses, throws ink flecks and a ring of
  orange runs round the page before the reward ticket prints (`celebrate()` in `src/ui/passport.ts`).

## Pages

| Path | What it is |
| --- | --- |
| `/` | Getting started, for someone with no cards: a Try a tap sample card, Find a place, sign in |
| `/t?picc=…&cmac=…` | Where every stand tap lands. Verifies the tap and shows the result. |
| `/c` | Your cards on this browser; `?open=<place>` opens one card, with its rewards, history and save options |
| `/c/:businessId` | Old card links: opens that card in Your cards (`/c?open=…`) |
| `/r/:intentId` | Using a reward: "Tap the stand" countdown, then the staff screen |
| `/w/:token` | The "Open my JOEYY card" link on a Wallet pass: signs this browser in and shows the card |
| `/w/:token?use=reward` | "Use my reward" on a Wallet pass: signs in, then opens the redeem sheet |
| `/signed-in?next=/c/…` | Where the backend sends the diner back after Sign in with Apple or Google: shows what came over |
| `/discover` | Every place using JOEYY, filtered by All, New to you and Your cards, with a search box (`?q=` keeps the search) that asks the backend's Places API |
| `/me` | Profile: your name (only you see it), a stamp for every place, how you're signed in, save, sign out, delete your account |
| `/privacy`, `/terms` | Placeholders until the real policies exist |
| `/business` | The business site for owners: what JOEYY is, then sign in with an email code |
| `/business/setup` | Four steps with a live card: place, reward, look, then link a stand (`?step=`) |
| `/business/today` | Today's stamps, rewards used and new diners, with each tap as it lands |
| `/business/card` | Edit and republish the card, with the preview beside the form |
| `/business/stands` | Linked stands, when each was last tapped, turn one off, link another |

The business pages load on their own, so diners never download them. Their backend routes are in
[docs/business-api.md](docs/business-api.md).

Any host must serve `index.html` for these paths (SPA fallback). Vercel, Netlify and
Cloudflare Pages do this with a one-line rewrite.

## Apple Wallet passes

**Add to Apple Wallet** builds a real signed pass in the passport look:
- The restaurant's paper and ink colours
- A strip of the card's stamps
- The reward, and how many visits to go
- An **Open my JOEYY card** link on the back, which signs a new phone in through `/w/:token`
- Once a reward is ready: "Reward: Ready" up top, the reward on the front, and **Use my reward**
  first on the back (see [rewards from the Wallet pass](docs/identity-and-api.md#rewards-from-the-wallet-pass-v38))

The demo backend builds each pass from the card as it is on the server, at
`/api/wallet/apple/<serial>.pkpass` (see `server/apple-pass.ts`). A card keeps one serial for
good, so **Update Wallet card** replaces the pass instead of adding a second one. Signing needs
your Apple Pass Type ID certificate in `web/.wallet/`; [the README there](.wallet/README.md) has
the steps. Without it, the button explains what's missing. In production, this moves to the backend.

**Passes update themselves.** Each pass registers with the demo backend's Wallet web service
(`/passkit/v1`), and every stamp or redemption sends Apple's push, so the pass in Wallet changes on
its own, with a notification when a reward is ready. iOS refuses passes whose update address is
plain `http://` ("Safari cannot download this file"), so on `http://` the demo leaves it out unless
you start it with `WALLET_HTTP_SERVICES=1` and turn on **Settings → Developer → Allow HTTP Services**
on the iPhone (see [.wallet/README.md](.wallet/README.md)). Over HTTPS it's always included.
The server log shows each step as `[wallet]` lines. If Wallet can't reach the service, the card
page falls back to **Update Wallet card**.

## How it identifies diners

There's no account to start with. The server sets an HttpOnly cookie with a random ID on the
first tap. To keep the stamps, the diner signs in with Apple, Google or a mobile number and a text
code (the Nov 11 team decision; no email and password, so the servers can't be flooded with fake
accounts). Full design, cookie settings and the API
routes: [docs/identity-and-api.md](docs/identity-and-api.md).

## Design

- **Passport theme:** a navy cover (`#111522`) with each business's pages in its own light paper
  and ink from its published `MerchantTheme`. Orange stays the JOEYY accent, as in the iOS app.
- **Type:** Instrument Serif for headlines and page names, Oswald for stamp lettering and counts
  (both Google Fonts, `display=swap`), and the system font for everything else.
- **Motion** (springs in `src/ui/spring.ts`, Apple's response and damping): each page arrives as
  one wave (headline, then the line under it, then the card), the frosted header lets the page
  scroll under it, buttons give the moment a finger lands, sheets rise on a spring and drag down to
  close (a flick counts, and you can catch one mid-way), a new stamp drops, hits the page and
  rolls the counts over on impact, and a full card pulses, throws ink flecks and prints its reward
  ticket. Reduce Motion keeps only short fades; a business can turn motion off.

Standards it follows: [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
(44 pt touch targets, sheets), [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/) (text contrast,
visible focus, live announcements, reduced motion), and 17 px inputs so iOS Safari doesn't zoom.
The SMS code field uses `autocomplete="one-time-code"` so iPhones offer the code from Messages.

## Before launch

- [ ] **Wallet badges:** the Wallet tile under each card is our own design. Apple's and Google's
      brand rules ask for their official "Add to Apple Wallet" and "Save to Google Wallet" artwork,
      so check them and put the official badge in or next to the tile.
- [ ] **App Store link:** set `APP_STORE_URL` in `src/ui/components.ts` once the app is listed.
- [ ] **Backend:** build the `/v1/web` routes (see the docs), SUN verification, SMS provider,
      Sign in with Apple and Google, and Wallet pass signing.
- [ ] **Apple and Google sign-in setup:** a Services ID, return URL and Sign in with Apple key
      (Team ID LJP4V355WT), and a Google OAuth client ID. The list is in
      [docs/identity-and-api.md](docs/identity-and-api.md#what-the-team-needs-from-apple-and-google).
- [ ] **Policies:** real privacy policy and terms at `/privacy` and `/terms`.
- [ ] **Decide the tap model:** this page assumes stands with passive tags. `backend-spec.md`
      assumes a powered reader at the till. See the docs.
- [ ] **Test on real phones:** iPhone Safari (background NFC tag reading) and Android Chrome,
      light and dark mode, VoiceOver and TalkBack.

## Structure

```
src/                The page
  api/              types.ts (the contract), http.ts (talks to any backend), demo.ts (demo extras)
  screens/          tap, cards, redeem, staff, shared
  ui/               passport (page, stamps, stack), stamp-style (shared with the pass art), components
                    (sheets, Keep this card tiles, sign-in), details, vessel (the reward drawing),
                    business, sections, discover, motion, spring, theme, dom
  styles/           tokens, base, card, screens
  demo/             The Preview states bar and the sample sign-in accounts (demo build only)
server/             Runs inside the Vite dev and preview servers, demo mode only
  demo/             The demo backend: data (places, stands), store (state), service (the rules),
                    scenarios (Preview states), routes (/v1/web, /api/demo, /api/wallet),
                    passkit (Apple's pass web service at /passkit/v1, for live pass updates)
  apple-pass.ts     Builds and signs Apple Wallet passes
  pass-art.ts       Draws the pass's stamp strip, logo and icon
  apns.ts           Sends Apple's "this pass changed" push
```

The page only ever talks to a backend over HTTP, through `http.ts`. The demo backend and the real
one answer the same routes, so whatever works in the demo exercises the real client too. The
only demo-only calls are Apple and Google sign-in (the demo can't run OAuth, so it shows a stand-in
consent sheet and calls `/api/demo/auth/{provider}`) and the Preview bar (`/api/demo/scenarios`,
`/api/demo/stamp`, `/api/demo/info`, `/api/demo/settings`).

The eight sample businesses (Norema Cafe, Ferrous Coffee, Little Fog Tea, Tallow & Rye, Pho Lune,
Marrow Bakehouse, Sunday Ramen, Bluestem Creamery) are fictional. **Preview states > Full wallet**
loads all eight at different stages with two rewards waiting.
