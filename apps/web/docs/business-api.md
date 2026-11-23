# Business site: backend contract

The business site (`/business`, code in `src/business/`) is where a restaurant owner signs in, makes
their card, links their stands and sees each day's visits. It calls the shared API in
`services/api`, as the partner app does. The full route list and rules are in
[services/api/README.md](../../../services/api/README.md) and
[docs/backend-spec.md](../../../docs/backend-spec.md) §3.1, §8.1, §8.4 and §8.5; stands and activity
are new in [docs/web-connect.md](../../../docs/web-connect.md). This page lists only what the site
uses and how.

The types are in `src/business/types.ts`, the client in `src/business/api.ts`, and the demo backend
that answers the same routes in `server/demo/partner.ts`. A route change updates all three and this
page together.

## Sign-in and session

- `POST /v1/auth/email/start` `{ email }` answers 202 `{ expiresIn, resendAfter }` and emails a
  6-digit code (the demo's is always 123456 and sends nothing).
- `POST /v1/auth/email/verify` `{ role: "partner", email, code }` answers
  `{ accessToken, tokenType, expiresIn, refreshToken }`.
- The access token stays in memory; the refresh token is kept in `localStorage`
  (`joeyy-partner-refresh`). After a reload, or on any 401, the client calls
  `POST /v1/auth/refresh` `{ refreshToken }` once and retries. Refresh tokens rotate and a reused
  one ends the session, so a refresh is shared within the page and serialized across tabs with a
  Web Lock.
- Signing out calls `POST /v1/auth/sign-out` `{ refreshToken }` and forgets both tokens.
- Every partner call sends `Authorization: Bearer <accessToken>`. Errors are `{ error, message }`;
  the site shows `message` for a refused change (4xx) and a connection hint otherwise.

## Screens

| Screen | Route |
| --- | --- |
| Any signed-in page | `GET /v1/partner/business` (404 `businessNotFound` means setup hasn't started), then `GET /v1/partner/program` (404 `programNotFound`) and `GET /v1/partner/stands` |
| Setup: place, Card page | `PUT /v1/partner/business` `{ name, location, timeZone }`. The time zone is the browser's on first save and kept after that, since leaving it out resets it to UTC |
| Setup: look (publish), Card page | `POST /v1/partner/program/versions` `{ requiredPunches, rewardDescription, theme }`. `theme.coverKey` carries the live cover forward. `409 unchangedProgram` reads as "nothing changed" |
| Setup: stand, Stands page | `POST` / `DELETE /v1/partner/stands/pairing`, then `GET /v1/partner/stands` every 2 seconds until a new stand shows up. `POST /v1/partner/stands/{standId}/turn-off` |
| Today | `GET /v1/partner/dashboard?from&to` for stamps, rewards earned and rewards used, and `GET /v1/partner/activity?from&to` for the list. The range is today in the browser's time zone, sent as UTC instants |

## Preview buttons

- **Preview: touch the stand** calls `POST /v1/dev/stands/touch`, which only the development API
  (`AUTH_MODE=dev`) and the demo answer. Shown in the demo build and the Vite dev server, never in a
  prod build.
- **Preview: a diner taps** calls the demo-only `POST /api/demo/stamp` with the business ID, because
  the partner API doesn't reveal a stand's tag UID. Demo build only.

## Rules worth knowing

- **A card must be readable.** `requiredPunches` 3 to 12, the reward 1 to 60 characters, the name 1
  to 40, the location at most 120, and the light and dark paper/ink pairs at least 4.5:1. The site
  only offers papers that pass, but the server decides.
- **Publishing makes a new version.** Cards with stamps keep their version until they're full; empty
  cards move to the new one.
- **Diners stay anonymous.** Activity lists visits by time and stamp number, never who.

## Not built yet

- Logo and cover uploads (`POST /v1/partner/images`) and notifications on the web.
- Kit claim codes, staff accounts, opening hours, more than one location, renaming a stand and
  turning one back on.
