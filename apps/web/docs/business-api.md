# Business site: backend contract

The business site (`/business`, code in `src/business/`) is where a restaurant owner signs up,
makes their card, links their stands and sees each day's visits. It calls `/v1/partner/*`, which
`server/demo/partner.ts` answers in the demo. The types are in `src/business/types.ts`; any change
updates that file, `src/business/api.ts`, `server/demo/partner.ts`, `server/demo/routes.ts` and this
page together.

The session is an HttpOnly cookie, as for diners. A browser can be signed in as a diner and as an
owner at the same time; the two never mix.

## Routes

| Route | Body | Answer |
| --- | --- | --- |
| `GET /v1/partner/me` | | `PartnerAccount`, or **204** when this browser isn't signed in |
| `POST /v1/partner/email/start` | `{ email }` | `{ maskedEmail }`. Sends a 6-digit code (the demo's is 123456). `invalidEmail` (400) |
| `POST /v1/partner/email/verify` | `{ code }` | `PartnerAccount`. Makes the account on first sign-in. `invalidCode` (400), `expired` (410) |
| `POST /v1/partner/sign-out` | | 204 |
| `PUT /v1/partner/business` | `{ name, category, location, address? }` | `PartnerAccount`. `invalidName` (400) without a name and location |
| `PUT /v1/partner/card` | `{ requiredPunches, rewardDescription, theme }` | `PartnerAccount`. Publishes a new program version. `invalidCard` (400) |
| `POST /v1/partner/stands/pairing` | | `PartnerAccount` with `pairing.expiresAt`, 2 minutes from now. Needs a published card |
| `DELETE /v1/partner/stands/pairing` | | `PartnerAccount` |
| `POST /v1/partner/stands/:standId/turn-off` | | `PartnerAccount`. The stand's taps stop stamping |
| `GET /v1/partner/today` | | `Today`: stamps, rewards used, new diners and the day's activity |

Every route except `me` answers `signedOut` (401) without a session.

## Rules the server applies

- **A card must be readable.** `requiredPunches` is a whole number from 3 to 20, the reward 2 to 50
  characters, and the light and dark paper/ink pairs at least 4.5:1 (`src/ui/contrast.ts`, the same
  check the diner page re-runs). The site only offers papers that pass, but the server decides.
- **Publishing makes a new version.** Diners get it from their next tap. A card already started
  keeps the number of stamps it began with.
- **Diners only find a live place.** A business is listed on `/v1/places` once it has a published
  card and at least one working stand.
- **Linking a stand** follows flow C in [docs/tag-registration.md](../../../docs/tag-registration.md):
  pairing opens a 2-minute window; the owner's phone, signed in to the business site, taps a stand
  allocated to their business; the tap arrives at `POST /v1/web/taps` like any other, and the server
  links that stand instead of stamping. The window closes when used. A stand allocated to another
  business is never linked. The demo stands in for the tap with `POST /api/demo/partner/link-stand`.
- **Diners stay anonymous.** `Today` counts visits and lists them by time and stamp number, never
  who. No route here returns a diner's name, number, email or ID.

## Not built yet

- Kit claim codes (the welcome card's QR, `merchant-kit.md`) to allocate stands at sign-up.
- Staff accounts and the staff app (another teammate's repo).
- Opening hours, a cover photo, and more than one location per business.
- Renaming a stand, and turning one back on (support does it for now).
