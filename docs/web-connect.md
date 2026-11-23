# Connecting the website to the shared API

*2026-11-22. Plan for taking `apps/web` off its demo backend and onto `services/api`. Decisions
marked **Team** need a yes from the group; the rest are implementation choices made to unblock work
and easy to change.*

## Where things stand

| Website needs | API today |
| --- | --- |
| Diner: tap a stand, cards, rewards, redeem, sign-in, profile, delete (`/v1/web/*`, [apps/web/docs/identity-and-api.md](../apps/web/docs/identity-and-api.md)) | **Missing.** No customer routes at all yet |
| Discover: list places, search, place detail | Search and detail exist (`/v1/places`). **Listing without a query is refused** (`400 invalidQuery`) |
| Business site: sign in, place, card, stands, today | Sign-in (`/v1/auth`, email code, `role: "partner"`), business, program versions, dashboard, notifications exist. **Stands and a day's activity are missing**; the website still calls its own demo routes |
| Apple Wallet passes and live updates | **Missing** (spec §6). Only the web demo server can sign passes |

## Decisions

1. **The tap model: decided, a stand tag (2026-11-22).** The stand holds an **NXP NTAG 424 DNA**
   tag that the diner's phone reads; there is no powered reader at the till. This replaces the
   reader model in the spec's §5. A stand is a row in `readers` with `kind = 'stand'`, so punches,
   dashboards and notifications work unchanged.
2. **Diner sessions on the web use a cookie, not bearer tokens.** A diner's first tap must work with
   no account, and a page shouldn't hold a refresh token in JavaScript. The API sets an HttpOnly
   cookie `joeyy_web` (random 32 bytes, stored only as a SHA-256 hash in `web_sessions`) that points
   at a customer. An anonymous browser gets a customer with subject `web:<uuid>`. Signing in with a
   phone code moves the browser to that account's customer and merges the anonymous one into it
   (rules in identity-and-api.md). The iOS app keeps using bearer tokens.
3. **Same site, so cookies just work.** In production the website and the API share a site (for
   example `joeyy.app` and `api.joeyy.app`), so the cookie is `SameSite=Lax; Secure`. The API
   answers CORS only for origins in `WEB_ORIGINS`, with credentials. Locally the Vite dev server
   proxies `/v1` to the API on port 8080, so the page and the API are one origin.
4. **Stand tags.** A stand row has `tag_uid` (unique), `status` (`allocated`, `active`,
   `disabled`) and `last_counter`. Real stands send NTAG 424 DNA SUN messages (`picc`, `cmac`);
   `TAG_MODE=sun` verifies them with keys from the environment. `TAG_MODE=dev` (default outside
   production) also accepts `picc = "<tag_uid>.<counter>"`, so the site can be tested with no
   hardware. Counters must always go up (replay protection), exactly as in the demo.
5. **Linking a stand.** A stand is allocated to a business when it's packed (or by the dev route
   below). The owner opens a 2-minute pairing window; the first tap on that business's
   `allocated` stand while the window is open activates it instead of stamping. A stand allocated to
   another business never links. Allocation at packing is what stops a stranger claiming a stand.
6. **Card numbers.** `requiredPunches` is 3 to 12 everywhere (spec §3.1). The business site's
   stepper changes from 20 to 12.
7. **Repeat taps.** No built-in limit; a business may set `minMinutesBetweenStamps` (team decision,
   Nov 11). The spec's 60-second default cooldown in §5 applies to readers, not stands.

## New API surface

### Diner (`/v1/web/*`, cookie session)

Everything in identity-and-api.md's route table **except** the Apple and Google redirect routes
and the Wallet routes, which come in phase 2. Phone and email sign-in reuse the code senders and
limits in `src/signIn.ts`. Response shapes are the TypeScript types in `apps/web/src/api/types.ts`.

### Places

- `GET /v1/places` with no `query`: live places (published card and at least one active stand),
  newest first, at most 50. Same `{ places }` shape as search.

### Partner (owner bearer token)

| Method | Route | Answer |
| --- | --- | --- |
| GET | `/v1/partner/stands` | `{ stands: Stand[], pairing: { expiresAt } \| null }` |
| POST | `/v1/partner/stands/pairing` | Opens a 2-minute window. Same shape. `409 noLiveProgram` before a card is published |
| DELETE | `/v1/partner/stands/pairing` | Closes it. Same shape |
| POST | `/v1/partner/stands/{standId}/turn-off` | Same shape. Taps on it answer `tagDisabled` |
| GET | `/v1/partner/activity?from&to` | `{ activity: Activity[] }`, newest first, at most 50, half-open range |

```ts
interface Stand { standId: string; label: string; status: 'active' | 'disabled'; linkedAt: string; lastTapAt: string | null }
interface Activity { kind: 'first' | 'stamp' | 'earned' | 'used'; at: string; punches: number | null }
```

Activity never names or identifies a customer.

### Development only (`AUTH_MODE=dev`; the routes don't exist otherwise)

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/dev/stands` | Partner token. Allocates a new stand to the owner's business; answers `{ tagUid }` |
| POST | `/v1/dev/stands/touch` | Partner token. Stands in for the owner's phone touching a new stand while pairing is open: allocates and activates one |
| POST | `/v1/dev/taps/{tagUid}` | No token. Answers `{ next: "/t?picc=<tagUid>.<counter>&cmac=dev" }` with a counter newer than any seen, like the demo's "Add a stamp" |

## Work split

| Branch | Owner | Scope |
| --- | --- | --- |
| `web-connect/api` | agent | Migration `0007_web.sql`; `src/routes/web.ts`, `src/routes/stands.ts`, dev routes; CORS; places listing; tests |
| `web-connect/business` | agent | `apps/web/src/business` on the real partner routes and `/v1/auth`; `server/demo/partner.ts` mirrors the same routes so demo mode keeps working |
| `web/connect` | lead | Web "api" mode (proxy to the local API), diner client fixes, docs, merging, end-to-end check |

## Phase 2

- Apple Wallet: move pass signing and the PassKit web service into the API (spec §6), with the
  certificate in Key Vault rather than on a laptop.
- Sign in with Apple and Google on the web (redirect flow).
- Real SUN keys and stand allocation at packing.
- Hosting for the API and the website on one site, with HTTPS.
