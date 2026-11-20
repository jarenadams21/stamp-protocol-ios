# Web identity and API contract

How the web page knows which diner tapped when they have no app and no account, and the
`/v1/web` routes the shared backend needs to add. This extends `docs/backend-spec.md` in
`stamp-protocol-ios`; field names match its section 3.1 card configuration.

## Who is tapping

The stand can't tell who is holding the phone. Every tap opens the same kind of link:

```
https://<your domain>/t?picc=<encrypted tag ID + counter>&cmac=<signature>
```

The page posts `picc` and `cmac` to the server. The **server** identifies the diner from a
cookie it set itself. The page never sends a customer ID.

| Step | What happens |
| --- | --- |
| First tap, no cookie | The server verifies the tag, creates an anonymous `Customer` row, and sets a cookie holding a random 128-bit ID. The stamp goes on that customer's card. |
| Later taps, same browser | The cookie comes back automatically. Same customer, same card. |
| Signs in (Apple, Google or a phone number) | Apple or Google proves the account, or an SMS code proves the number. If it's new to JOEYY, the anonymous customer is upgraded in place, with nothing to merge. |
| New phone or cleared browser | No cookie, so a new anonymous card starts. Signing in the same way as before merges it back into their existing customer. |
| Adds the card to Wallet | The pass serial is linked to the customer. It shows progress, but a tap still identifies the diner through the cookie (see below). |
| Installs the app | Signs in with the same Apple ID, Google account or number, and the server moves the anonymous cards to the app account. |

### Cookie settings

```
Set-Cookie: jy_customer=<random id>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000
```

- **Server-set and HttpOnly.** Safari's tracking prevention caps cookies written by JavaScript at
  7 days. Cookies set by the server in an HTTP response on the site's own domain last much
  longer, so the cookie must come from the API's `Set-Cookie`, not `document.cookie`.
- **Host the page and the API on the same site** (for example `example.com` and `api.example.com`).
  A cookie on a third-party API domain would be blocked.
- **Store only a random ID.** The cookie maps to a `Customer` row; it holds no personal data.
- **Private browsing** starts fresh every time, which is why the page offers "Save cards" (sign in).

### Why a Wallet pass can't identify a tap

Tapping a stand opens a **link in the browser**, not the Wallet app. The pass never takes part
in a tap, so it can't say who tapped. It shows the card on the lock screen and updates after
each stamp. Identity always comes from the cookie, or from the account once the diner signs in.
(A pass could identify a diner only in the other hardware model, where the phone is held to a
powered reader. See "Tap model" below.)

### Limits to agree as a team

- A shared phone or browser means shared stamps. That's acceptable; paper cards work the same way.
- Merging two customers on sign-in: add their open cards' punches up to each card's
  `requiredPunches`, and keep all rewards.
- Rate-limit `phone/start` per IP and per number (SMS costs money and attracts abuse).

## Routes

All JSON, credentials included (`fetch(..., { credentials: 'include' })`), UTC ISO 8601 times.
Routes with nothing to return (cancel, sign out, reorder) answer `204 No Content`. The demo
backend in `server/demo` answers every route below except the three Apple and Google routes
(`auth/{provider}/start`, `auth/{provider}/callback`, `auth/result`); see
[The demo backend](#the-demo-backend).
The cookie is the only identity. Like the rest of the API, never trust a customer or business ID
sent by the client.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/web/taps` | Verify `picc` + `cmac`, find or create the customer, apply the card lifecycle (backend-spec §4) or an open redeem window |
| GET | `/v1/web/me/cards` | `{ identity, cards: CardState[] }` |
| GET | `/v1/web/me/cards/{businessId}` | One `CardState`; `404` if this diner has no card there |
| PUT | `/v1/web/me/cards/order` | Body `{ businessIds: string[] }`, the diner's chosen card order. `204`. Saved on the account, so it follows sign-in; unknown or missing IDs fall back to most recent visit |
| POST | `/v1/web/redeem-intents` | `{ rewardId }` → `RedeemIntent` (2-minute window) |
| GET | `/v1/web/redeem-intents/{id}` | `{ intent, redemption? }`; the waiting page polls this |
| DELETE | `/v1/web/redeem-intents/{id}` | Cancel |
| POST | `/v1/web/phone/start` | `{ phone }` → `{ maskedPhone }`; sends the SMS |
| POST | `/v1/web/phone/verify` | `{ code }` → `SignInResult`; signs in to that number's account (or creates one) and merges this browser's anonymous cards |
| GET | `/v1/web/auth/{provider}/start` | `provider` is `apple` or `google`; query `return_to` (a card path, `/c` or `/c/{businessId}`). Redirects to the provider. See [Sign in with Apple and Google](#sign-in-with-apple-and-google) |
| GET, POST | `/v1/web/auth/{provider}/callback` | The provider's return. Verifies the ID token, signs this browser in with the same merge as `phone/verify`, then redirects to the page's `/signed-in` |
| GET | `/v1/web/auth/result` | The `SignInResult` of this browser's last Apple or Google sign-in, readable once; `404` after |
| POST | `/v1/web/pass-links/{token}` | The "Open my JOEYY card" link on a Wallet pass → `SignInResult` with `businessId`; rotate the token on use |
| POST | `/v1/web/sign-out` | Ends this browser's session; the account keeps everything |
| PUT | `/v1/web/me/profile` | Body `{ displayName }`: what the diner wants to be called, 1–40 letters (spaces, `'`, `.` and `-` allowed); `""` clears it. Returns the `Identity`. `404` for an anonymous browser (no account to keep it on), `400 invalidName` otherwise. **Only the diner's own routes return it**: never a business endpoint, the partner app, a redemption or a staff screen |
| DELETE | `/v1/web/me` | Deletes the account and everything on it: cards, stamps, rewards, sign-ins (phone, Apple, Google), Wallet passes (their pass links and update tokens stop working) and open redemptions. Signs out every browser on it. `204`; `404` for an anonymous browser. Visit counts a business already saw for its own reporting may stay, with no link back to the diner |
| GET | `/v1/places` | Participating businesses for the Discover tab (`PlaceSummary[]`, already in backend-spec §8.2) |
| GET | `/v1/places?query=` | **Built in the shared backend** (`backend/src/routes/places.ts`), no sign-in. Places whose name contains the query (any case, names starting with it first) or whose ID is exactly it; at most 20, live places only. Answers `{ places: Place[] }` (`src/api/types.ts`); `searchPlaces()` maps each to a `PlaceSummary`. `400` for an empty or over-40-character query |
| POST | `/v1/web/cards/{cardId}/wallet` | `{ platform: 'apple' \| 'google' }` → `{ url }` for a signed `.pkpass` or a Save to Google Wallet link |

`CardState.recentVisits` (newest first, up to 10) feeds "Your visits". `Business` gains optional
`category`, `address`, `hoursToday` and `website`, which the partner app would collect.

The TypeScript types in `src/api/types.ts` are the contract: `TapResult`, `CardState`,
`Reward`, `RedeemIntent`, `Redemption`, `Identity` and `SignInResult`. Errors return
`{ "code": "offline" | "server" | "invalidPhone" | "invalidCode" | "expired" | "notFound" }`.

### `POST /v1/web/taps` outcomes

| `outcome` | When | Page shows |
| --- | --- | --- |
| `stamped` | Valid tap, stamp added (`startedNewCard` when it rolled over a full card) | "Stamp 4 added" with the punch animation |
| `completed` | This stamp filled the card; one reward earned | "Card complete" with the reward ticket |
| `cooldown` | Only if the business set `minMinutesBetweenStamps`: a tap sooner than that after this diner's last stamp there. `nextStampAt` says when the next one counts | "Already stamped" |
| `redeemed` | A redeem window was open for this business | Staff screen |
| `replayed` | Signature valid but the counter isn't higher than the last one seen | "This link was already used" |
| `invalidTag` | Signature or tag unknown | "We couldn't read that stand" |
| `tagNotActive` | Tag allocated but not activated by the business | "This stand isn't set up yet" |
| `tagDisabled` | Tag disabled (lost, stolen, replaced) | "This stand is no longer in use" |

Server rules (same as the reader path in backend-spec §5):

- Verify the AES-CMAC and **atomically** accept the counter only if it's higher than the
  tag's `last_counter`. That one SQL `UPDATE … WHERE last_counter < $counter` is what stops replays.
- Write the punch, any rollover card and any reward in one transaction.
- **No built-in limit on repeat taps** (team decision, 2026-11-11). Every new tap stamps, even
  seconds after the last one: how many stamps a diner gets is the business's call. A business can
  set `ProgramVersion.minMinutesBetweenStamps`; then a tap sooner than that after the diner's last
  stamp there returns `cooldown` and adds nothing. Absent means no limit. This replaces the 60 s
  default in backend-spec §5. **The real backend needs this per-business setting** (stored with the
  program version, set in the partner app, sent in `CardState.program`).
- Replay protection is separate and always on: a reloaded or shared tap link has an old counter
  and gets `replayed`, never a stamp.
- A tap with an open redeem window for that business redeems instead of stamping. The window is
  single-use and expires after 2 minutes.

## Tap model: a conflict with backend-spec.md

`backend-spec.md` §5 describes a **powered reader at the till that reads the diner's phone or
Wallet pass** (`POST /v1/punches`, authenticated as a reader). This web page exists for the
other model, where a **passive NFC tag in a stand is read by the diner's phone**. The two need
different hardware, security and onboarding. The team should pick one before the backend is built.

## Signing in on a new phone (v3.5, ways in changed in v3.13)

The server can't recognise a diner from a tap on a fresh phone: the tap carries only the stand's
signature and whatever this browser stores. So the page lets the stamp land, then offers
"Already have cards?". Its Sign in opens three ways in, agreed at the Nov 11 team meeting:

1. **Sign in with Apple.**
2. **Sign in with Google.**
3. **Mobile number plus text code**, with `autocomplete="one-time-code"`.

The **Wallet pass link** (`/w/{token}`) still opens the card for diners who added the pass but
never signed in. Passes move to a new iPhone through iCloud.

Email and password is left out on purpose: throwaway addresses would make it easy to fill the
servers with fake accounts. Face ID / passkeys (v3.5 to v3.12) are gone too.

An `Identity` is `anonymous`, `pass` or `account`. An account has `method` (how this browser
signed in: `phone`, `apple` or `google`), `maskedPhone` if the account has a number, and
`maskedEmail` for Apple and Google. One account can have all three; they all lead to the same
cards.

Merge rules (`SignInResult`):

- Each anonymous stamp counts once. It moves onto the account's card for that business.
- A card that fills issues its reward, and extra stamps start the next card.
- Every reward from both sides is kept.
- Visit limits still apply across devices.
- The response lists what moved and how many cards and rewards came back, which drives the
  "Welcome back. Stamp 8 added" screen.

The same rules apply whichever way the diner signs in. If the Apple ID, Google account or number
is new to JOEYY and this browser isn't signed in yet, this browser's customer simply becomes the
account (nothing to merge).

A pass-link sign-in can only open stamp cards: it never changes the number or other account
settings, and the token rotates each time it's used.

## Sign in with Apple and Google

Both are OAuth 2.0 / OpenID Connect authorization-code flows, run by the backend. The page never
sees a token; it only follows redirects, and the session cookie does the rest.

1. The page calls `api.signInWithProvider('apple' | 'google')`, which goes to
   `GET /v1/web/auth/{provider}/start?return_to=/c/norema`. `return_to` is the card page the diner
   was on (a tap link can't be opened twice), else `/c`.
2. `start` checks `return_to` is a path on the page's own site (starts with `/c`, never `//` or a
   full URL), stores it with a random `state` and `nonce` (and a PKCE verifier for Google) in a
   short-lived HttpOnly cookie, and redirects to the provider:
   - Apple: `https://appleid.apple.com/auth/authorize?response_type=code&response_mode=form_post&scope=name%20email&client_id=<Services ID>&redirect_uri=…&state=…&nonce=…`
   - Google: `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&scope=openid%20email%20profile&client_id=<client ID>&redirect_uri=…&state=…&nonce=…&code_challenge=…&code_challenge_method=S256`
3. The provider sends the diner to `/v1/web/auth/{provider}/callback`. Apple **POSTs** a form
   (`code`, `state`, and `user` with the name on the very first sign-in only); Google uses a `GET`.
   Apple's POST comes from another site, so `SameSite=Lax` cookies (the customer cookie) don't come
   with it: make the `state` cookie `SameSite=None; Secure`, keep the `code` server-side under its
   `state`, and answer the POST with a `303` to `GET …/callback?state=…`, where the customer cookie
   is sent. Then the backend:
   - checks `state` against the cookie;
   - exchanges `code` at the token endpoint (Apple: `https://appleid.apple.com/auth/token` with a
     client secret JWT, ES256, signed with the Sign in with Apple key; Google:
     `https://oauth2.googleapis.com/token` with the client secret and PKCE verifier);
   - verifies the ID token: signature against the provider's JWKS
     (`https://appleid.apple.com/auth/keys`, `https://www.googleapis.com/oauth2/v3/certs`), `iss`,
     `aud` = the Services ID or client ID, `exp`, and `nonce`;
   - finds the account by the provider and `sub` (never by email: Apple may give a private relay
     address, and emails can change), or creates one. It stores the email to show the diner, masked;
   - applies the merge rules above, exactly as `phone/verify` does, and keeps the `SignInResult`
     for this browser's session;
   - redirects to `<page origin>/signed-in?next=<return_to>`, or
     `/signed-in?next=<return_to>&error=cancelled` if the diner cancelled (`error=access_denied` from
     Google, `user_cancelled_authorize` from Apple), or `&error=failed` for anything else.
4. The page's `/signed-in` route calls `GET /v1/web/auth/result` (`api.providerSignInResult()`) and
   shows the same "Welcome back. Stamp 8 added" screen as a phone sign-in, or a "Signed in" toast if
   nothing moved. It only ever goes on to a `/c` path, whatever `next` says.

Rate-limit `start` per IP like `phone/start`. Apple's `name` arrives only once, so save it on the
first sign-in if it's ever needed (the page doesn't use it).

### What the team needs from Apple and Google

**Apple** (developer account, Team ID `LJP4V355WT`), under Certificates, Identifiers & Profiles:

- An **App ID** with the Sign in with Apple capability (the iOS app's, so web and app share accounts).
- A **Services ID** for the web (for example `com.joeyy.web`): this is the `client_id`. Turn on
  Sign in with Apple for it, group it with the App ID, and add:
  - **Domains:** the API's domain (for example `api.joeyy.app`);
  - **Return URL:** `https://<api domain>/v1/web/auth/apple/callback` (HTTPS only; no `localhost`).
- A **Sign in with Apple key** (`.p8`) and its **Key ID**. The backend signs the client secret JWT
  with it (`iss` = Team ID, `sub` = Services ID, `aud` = `https://appleid.apple.com`, up to 6
  months; regenerate before it expires).
- To email diners who use Hide My Email, register the sending domain under **Sign in with Apple
  for Email Communication**. JOEYY doesn't email anyone today, so this can wait.

**Google** (Google Cloud console, APIs & Services):

- An **OAuth consent screen**: app name JOEYY, support email, the page's domain as an authorised
  domain, privacy policy and terms links (`/privacy`, `/terms`), scopes `openid`, `email`, `profile`.
  Publish it to production so it isn't limited to test users.
- An **OAuth client ID** of type *Web application*, with the authorised redirect URI
  `https://<api domain>/v1/web/auth/google/callback` (and `http://localhost:<port>/…` for local
  testing if wanted). The backend keeps the client secret.

The buttons follow each brand's rules: Apple's white "Continue with Apple" button for dark
backgrounds with Apple's logo, and Google's light-theme "Continue with Google" button with the
standard "G" (Roboto Medium, `#747775` outline), both pill-shaped. Don't restyle them in the theme.


## Rewards from the Wallet pass (v3.8)

The stand can't read a Wallet pass: Apple's NFC passes need a powered reader and an NFC pass
certificate from Apple. So the pass gets people to the web redeem flow instead:

- **When a card fills,** the pass updates itself. The header reads "Reward: Ready" (the only part
  visible while the pass sits in the Wallet stack), the front shows "Ready to use: A free espresso",
  and a back field with `changeMessage` makes Wallet post a notification. That field is only set while
  a reward is ready and doesn't change until it's used, so later stamps don't notify.
- **"Use my reward"** on the back of the pass is the pass link with `?use=reward`
  (`/w/{token}?use=reward`). It signs the browser in like "Open my JOEYY card", then opens the usual
  "Use your reward now?" sheet. The diner still taps the stand inside the 2-minute window and shows
  the staff screen, so the reward is used at the counter and only once.
- **After a redemption,** the pass updates again to clear the reward.

What the backend needs for this:

| Piece | What it does |
| --- | --- |
| `webServiceURL` + `authenticationToken` in each pass | Lets Wallet register the device for updates (HTTPS only) |
| Apple's pass web service routes | `POST/DELETE /v1/devices/{device}/registrations/{passType}/{serial}`, `GET /v1/devices/{device}/registrations/{passType}`, `GET /v1/passes/{passType}/{serial}`, `POST /v1/log` |
| APNs push with the Pass Type ID certificate | An empty push after every stamp and redemption; Wallet then fetches the new pass |
| Pass-link token rotation | Because the token rotates on use, the update also carries the new link |

`CardState.walletPass` (`{ outOfDate, autoUpdates }`) says whether this diner added the card to
Wallet. `autoUpdates` means Wallet registered the pass, so it changes by itself and is never out of
date. A pass that never registered (Wallet couldn't reach the service) falls back to **Update
Wallet card**, which downloads the pass again under the same serial number so Wallet replaces it.

### Live updates (v3.10)

The demo backend runs the whole loop, so the real backend can copy it (`server/demo/passkit.ts`,
`server/apns.ts`):

1. Each pass carries `webServiceURL` (`<origin>/passkit`) and its own `authenticationToken`.
2. When the pass is added, Wallet calls `POST /passkit/v1/devices/{device}/registrations/{passType}/{serial}`
   with its push token. Requests need `Authorization: ApplePass <token>`; anything else gets `401`.
3. After any request that changes a card (a stamp, a redemption, a sign-in merge, a Preview state),
   the server compares each registered pass with what it last announced, and pushes the changed
   ones: an empty `{}` to `api.push.apple.com`, topic = the Pass Type ID, signed in with the Pass
   Type ID certificate. Each change is pushed once.
4. Wallet asks `GET .../registrations/{passType}?passesUpdatedSince=<tag>` for the changed serials,
   then downloads each from `GET /passkit/v1/passes/{passType}/{serial}` (`Last-Modified`, `304` when unchanged).
5. A push answered `410` means the pass was removed, so that registration is dropped.
   `POST /passkit/v1/log` prints Wallet's own error reports to the server log as `[wallet]` lines.

Tested against Apple's push service with the JOEYY certificate: it accepts the certificate and
topic, and rejects only an invalid device token. **`webServiceURL` must be HTTPS:** iOS refuses to
add a pass that names an `http://` service ("Safari cannot download this file"), unless the phone
has Settings → Developer → Allow HTTP Services on. The demo therefore includes it only over HTTPS,
or over `http://` when started with `WALLET_HTTP_SERVICES=1`. Production must serve it over HTTPS.

Not done yet: a QR code on the pass for staff to scan, and lock-screen suggestions near the
restaurant (`locations` in the pass; they need each business's coordinates).

## The demo backend

`npm run dev` (demo mode) runs `server/demo` inside the Vite server, so the page, its API and Wallet
passes share one address. Production builds (`--mode prod`) leave it out and call `VITE_API_BASE`;
see "Demo vs production" in the README.
It's a stand-in for the real backend, built to the same contract:

| Piece | Where |
| --- | --- |
| Sample places and stands | `server/demo/data.ts` |
| Customers, devices, passes, redeem windows, stand counters | `server/demo/store.ts`, saved to `.demo/state.json` |
| The rules (stamps, rollover, each business's repeat-stamp limit, redemption, the sign-in merge) | `server/demo/service.ts` |
| The routes in the table above | `server/demo/routes.ts` |
| Preview states | `server/demo/scenarios.ts`, under `/api/demo/scenarios/{name}` |

Data model, the same shape the real backend needs: a **customer** owns cards, rewards, visits,
the card order and Wallet passes; a **device** (one browser, one HttpOnly `joeyy_device` cookie)
points at a customer. A new browser gets an anonymous customer. Signing in merges it into the
account and points the device there.

Where the demo is simpler than production:

- **Stands:** `picc` is `<stand>.<counter>` in plain text, with no AES decryption or CMAC check.
  The counter rule (each tap must beat the last) is real.
- **Repeat-stamp limits:** only Sunday Ramen sets one (`minMinutesBetweenStamps: 30`), so
  Preview states > "Tapped again too soon" can show the `cooldown` screen. Every other sample
  place stamps on every tap.
- **Text codes:** nothing is sent. The code is always `123456`.
- **Apple and Google:** the demo can't run OAuth, so the page shows its own consent sheet, marked
  as a preview ("Sign in to JOEYY with Apple?" with the sample email), and calls
  `POST /api/demo/auth/{provider}` instead of `/v1/web/auth/{provider}/start`. That signs in as the
  sample Apple ID (`sample.diner@icloud.com`) or Google account (`sample.diner@gmail.com`), with the
  same merge as a text code. The sample account in Preview states has the number, the Apple ID and
  the Google account. None of the three `/v1/web/auth/...` routes exist in the demo.
- **Demo-only routes,** which only exist in demo mode: `/api/demo/scenarios/{name}` (Preview
  states), `/api/demo/stamp` (Add a stamp), `/api/demo/info` and `/api/demo/settings` (the Preview
  bar's switches), `/api/demo/auth/{provider}`, and `/api/wallet/apple/status`,
  `/api/wallet/apple/strip.png` (a quick look at the pass art) and
  `/api/wallet/apple/{serial}.pkpass`.
- **Google Wallet:** not set up in the demo (it needs a Google Cloud issuer account), so
  `POST /v1/web/cards/{cardId}/wallet` with `google` answers `{ "url": "" }` and the page explains.
- **Pass links** don't rotate.
- **Wallet passes** download from `/api/wallet/apple/{serial}.pkpass`, built from the server's copy
  of the card. Anyone with the serial can download that pass, as with Apple's own pass URLs.

