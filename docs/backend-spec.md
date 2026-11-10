# JOEYY backend specification (MVP)

Status: **specification only — not implemented.** Both apps run on local sample data today.
This document defines what the shared backend must do so the customer app and the business
(partner) app can move off sample data. It follows the agreed partner MVP request-flow diagram
(sign in → authenticated route → handler → database) and extends it to the customer and NFC
flows that the diagram marks as external.

## 1. Scope

In scope for the MVP:

- One backend application: a single deployable API with logical modules, not separate services.
- One relational database (Postgres) and private object storage for images.
- Business owner sign-in, business profile, card program versions, card design, and dashboard.
- Customer sign-in, discovery and search, enrollment, cards, rewards (coupons), favorites, and groups.
- NFC punch intake with validation, full-card rollover, and reward stacking.
- Apple Wallet pass issuance and updates.
- Partner notifications for new cards and rewards waiting to be redeemed.

Out of scope (per the diagram's boundaries): POS integration, employee roles, more than one
business per owner, more than one active program per business, campaigns, a manual punch
authorization UI, and analytics workers or caches.

## 2. Architecture

```
Customer iOS app ─┐                        ┌─ Business handler ──────┐
Partner iOS app ──┤                        ├─ Program handler ───────┤
NFC reader ───────┼─ HTTPS ─ API routes ───┼─ Dashboard handler ─────┼─ Loyalty DB (Postgres)
Apple Wallet ─────┘   verify token,        ├─ Customer handler ──────┤
                      resolve caller,      ├─ Punch handler ─────────┼─ Image storage (private)
                      authorize, validate  ├─ Wallet handler ────────┤
                                           └─ Notification handler ──┴─ APNs (Wallet and app push)
```

- **Auth provider**: an OIDC provider issues access tokens (Entra External ID was prototyped).
  The API verifies signature, issuer, audience, and expiry using the provider's published keys.
  There is no separate auth service.
- **API routes**: every request is authenticated and the caller is resolved
  (`ownerSubject → businessId` for partners, `subject → customerId` for customers). Every read
  and write is authorized against that identity, and input is validated. Failures return `401`,
  `403`, or `400`. **Never trust a `businessId` or `customerId` sent by a client.**
- **Image storage**: private object storage. The backend validates and uploads images and returns
  keys; apps display images through short-lived URLs that the backend returns.
- **Loyalty DB**: Postgres, the single source of truth for both apps.

## 3. Shared resources

These records are shared by both apps. Once the backend exists, neither app keeps its own copy.

| Resource | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Business | Partner app | Customer app (search, card header) | Name, location, logo, client ID |
| Program version (card configuration) | Partner app (publish) | Customer app, punch handler, Wallet | `requiredPunches`, reward, `MerchantTheme`, cover |
| Card | Punch handler, customer enrollment | Both apps, Wallet | Progress toward one reward |
| Punch event | Punch handler | Both apps (history, dashboard) | Deduplicated by `eventId` |
| Reward (coupon) | Punch handler | Both apps | One per full card; rewards stack |
| Images | Partner app | Both apps | Logo, cover photo |
| Partner notification | Punch and redemption handlers | Partner app | New card started, reward waiting |

### 3.1 Card configuration contract

The card configuration is the published **program version**. The customer app's `Place` and
`MerchantTheme`, and the partner app's `ProgramVersion` and `CardDesign`, must map one-to-one
to this contract, so the card designer preview is exactly what customers see.

```json
{
  "versionId": "uuid",
  "version": 2,
  "requiredPunches": 10,
  "rewardDescription": "One handcrafted drink",
  "theme": {
    "lightPaper": "#F7EFD9", "lightInk": "#2F241E",
    "darkPaper": "#2F241E", "darkInk": "#F7EFD9",
    "typeface": "serif",
    "artwork": "cloud",
    "coverURL": "https://example.invalid/signed-url",
    "allowsMotion": true
  },
  "publishedAt": "2026-11-09T18:00:00Z"
}
```

Rules (identical to the apps):

- `requiredPunches` is an integer from **3 to 12** (`Place.punchRange`).
- `rewardDescription` is trimmed and 1–60 characters (`ProgramDraft.rewardLimit`).
- `typeface` is `standard`, `rounded`, `serif`, or `monospaced` (`MerchantTheme.Typeface`).
- `artwork` is `rail`, `cloud`, or `stone` (Clipped, Rounded, or Square card stock).
- The light and dark ink/paper pairs must each meet a **4.5:1** contrast ratio
  (`MerchantTheme.validate()`). The server re-validates and rejects failures with `400`.
- Business name is 1–40 characters and location is at most 120 characters.
- Versions are **immutable**. Publishing inserts a new version and moves the business's live
  pointer in one transaction. Publishing identical settings is rejected (`409 unchangedProgram`).

## 4. Card lifecycle and full-card rollover

This is the agreed behavior. It replaces the earlier "claim before collecting again" rule.

1. **Enroll**: a customer adds a business's card in the app. This creates a card on the live
   version with 0 punches. Enrollment is idempotent: one open card per customer per business.
2. **Punch**: each validated NFC tap adds one punch to the customer's open card.
3. **Full**: when `punches == requiredPunches`, the card becomes `completed` and **one reward is
   earned** (`earnedAt` is the time of the completing punch). The card stays full; nothing resets.
4. **Rollover**: the next validated punch on a completed card **automatically creates a new card**
   on the live version, with that punch as its first (`punches = 1`). No claim or redemption is
   needed. The full card's reward stays available.
5. **Stacking**: rewards accumulate. A customer can hold any number of unredeemed rewards for
   the same business.
6. **Optional claim**: the customer app can close a full card early ("Claim reward"). This
   starts the next card at 0 punches. It does not redeem the reward.
7. **Redeem**: a reward is redeemed once (`redeemedAt` is set). Redeeming never changes punches.

Version rules when a new version is published:

- Cards with punches keep their version's rules and look until they are complete.
- Open cards with 0 punches move to the new live version, since no progress is lost.
- New enrollments and rollover cards always use the live version.
- Version usage is **Live** (current), **Finishing** (older, with cards still in progress), or
  **Retired** (older, with none in progress).

Example: v1 needs 10 punches and v2 needs 8. Card A (v1, 4 punches) still needs 10. A new
card B, or a rollover card, uses v2 and needs 8.

## 5. NFC punch intake

The diagram treats NFC as external: **NFC does not write directly to the database.** Readers
send events to the punch handler, which validates and records them.

Flow: after a purchase, the customer taps their Wallet pass (or the app) on the business's
reader. The reader reads the pass's NFC payload and sends a punch event. The backend validates
the event, applies rollover, records it, updates the Wallet pass, and notifies the business.

`POST /v1/punches` (authenticated as a reader)

```json
{
  "eventId": "nfc-6c1f…",
  "readerId": "reader-uuid",
  "passPayload": "<signed NFC payload from the Wallet pass>",
  "occurredAt": "2026-11-09T18:04:11Z"
}
```

`eventId` is unique per tap and generated by the reader.

Validation requirements:

- Each reader is registered to exactly one business and authenticates with its own revocable
  credential, not a user token. Unknown or revoked readers get `401`.
- The pass payload is signed and verified server-side and must identify the customer's pass for
  **that** business. A pass for another business gets `403`.
- `eventId` is unique. A duplicate returns the original result (`200`, idempotent) and never
  adds a second punch.
- `occurredAt` must be within a small window of server time (for example ±5 minutes).
- Cooldown: at most one punch per pass per business within a configurable window (default
  60 seconds) to absorb double taps.
- A tap from a customer with no open card for that business enrolls them first.

Response:

```json
{
  "cardId": "uuid",
  "punches": 1,
  "requiredPunches": 10,
  "startedNewCard": true,
  "rewardsAvailable": 2
}
```

The punch event, any rollover card, and any reward are written in **one transaction**.

## 6. Apple Wallet

- `POST /v1/customer/cards/{cardId}/pass` returns a signed `.pkpass`. The Pass Type ID
  certificate is held only by the backend, never in the apps. Pass images are rendered from the
  program version's theme, logo, and cover, within Apple's native pass layout.
- Implement Apple's **PassKit web service**: register and unregister devices, list updatable
  passes, return the latest pass, and accept logs.
- After every punch, rollover, or redemption, the backend sends an APNs Wallet update push so
  the pass shows current progress and available rewards.
- The pass carries the NFC payload used in section 5 and a barcode fallback.

## 7. Partner notifications

Customers usually see progress only in Wallet, so the business needs to know when rewards are
waiting.

- Events: `card.rolledOver` (a new card started from a full card) and `reward.waiting` (the
  number of unredeemed rewards changed).
- Delivery: an in-app notification list, plus optional APNs push to the partner app. Pushes are
  batched (for example, at most one per business every 15 minutes) to avoid noise.
- `GET /v1/partner/notifications?after=<cursor>` returns notifications, newest first.
- The dashboard returns `rewardsWaiting` (all-time unredeemed) and `customersWithStackedRewards`
  (customers with more than one unredeemed reward). The partner app's Overview already shows
  both from sample data.

## 8. API

All routes are versioned under `/v1` and use JSON over HTTPS with UTC ISO 8601 timestamps.

### 8.1 Partner (owner token)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/partner/business` | The owner's business, or `404` before setup |
| PUT | `/v1/partner/business` | Create or update name, location, and logo key (upsert on `ownerSubject`) |
| POST | `/v1/partner/images` | Upload a logo or cover, validate type and size, return its key |
| GET | `/v1/partner/program` | The live version |
| GET | `/v1/partner/program/versions` | All versions, with usage (Live, Finishing, Retired) and counts |
| GET | `/v1/partner/program/publish-impact` | `{ keepRules, switchToNew }` |
| POST | `/v1/partner/program/versions` | Publish a new immutable version |
| GET | `/v1/partner/dashboard?from&to` | Counts (see 8.4) |
| GET | `/v1/partner/notifications` | New cards started and rewards waiting |
| POST | `/v1/partner/rewards/{rewardId}/redeem` | Mark a presented reward redeemed (see open decision 1) |

### 8.2 Customer (customer token)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/places?query=` | Search by business name or exact client ID (not location) |
| GET | `/v1/places/{placeId}` | A business and its live card configuration |
| POST | `/v1/customer/cards` | Enroll in a business (idempotent) |
| GET | `/v1/customer/cards` | Open cards with progress, archived state, and favorites |
| POST | `/v1/customer/cards/{cardId}/claim` | Optionally close a full card early |
| PATCH | `/v1/customer/cards/{cardId}` | Archive or restore; favorite or unfavorite |
| GET | `/v1/customer/rewards` | Available and used rewards (the Redeemed tab) |
| GET, PUT, DELETE | `/v1/customer/groups[/{id}]` | Groups (unique names, 1–40 characters) |
| POST | `/v1/customer/cards/{cardId}/pass` | A signed Wallet pass |

### 8.3 Devices

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/punches` | NFC punch intake (section 5) |
| Various | `/v1/wallet/…` | Apple PassKit web service (section 6) |

### 8.4 Dashboard semantics

- `enrolledCardholders` is lifetime **unique customers** (`COUNT DISTINCT customerId`), not cards,
  because cards roll over.
- Activity counts use the half-open range `from <= timestamp < to`.
- `punches` uses `PunchEvent.occurredAt`, `rewardsEarned` uses `Reward.earnedAt`, and
  `rewardsRedeemed` uses `Reward.redeemedAt`.
- `rewardsWaiting` and `customersWithStackedRewards` are all-time.
- Apps choose periods in the business's time zone and send UTC instants.
- Counts are read-only SQL aggregates scoped to the business, indexed by `businessId` and timestamp.

## 9. Data model

| Table | Key fields |
| --- | --- |
| Business | `id` PK, `ownerSubject` UNIQUE, `clientId` UNIQUE, `name`, `location`, `logoKey`, `timeZone`, `currentProgramVersionId` FK |
| ProgramVersion | `id` PK, `businessId` FK, `version`, `requiredPunches`, `rewardDescription`, `theme` (JSON per 3.1), `coverKey`, `publishedAt`; UNIQUE(`businessId`, `version`) |
| Customer | `id` PK, `subject` UNIQUE, `createdAt` |
| Card | `id` PK, `businessId` FK, `customerId` FK, `programVersionId` FK, `punches`, `status` (`active`, `completed`, `closed`), `archived`, `favorite`, `createdAt`, `completedAt`; at most one `active` card per (`customerId`, `businessId`) |
| PunchEvent | `id` PK, `businessId` FK, `cardId` FK, `readerId` FK, `eventId` UNIQUE, `occurredAt`, `receivedAt` |
| Reward | `id` PK, `businessId` FK, `cardId` FK UNIQUE, `customerId` FK, `earnedAt`, `redeemedAt` (nullable) |
| Reader | `id` PK, `businessId` FK, credential hash, `revokedAt` |
| WalletRegistration | Device library ID, push token, pass serial, `cardId` |
| Notification | `id` PK, `businessId` FK, `kind`, `payload`, `createdAt`, `readAt` |
| Group, GroupMember | Customer groups and their cards |

Constraints: one reward per completed card; `punches` between 0 and the card's version's
`requiredPunches`; `redeemedAt` after `earnedAt`; and every business-owned row carries
`businessId` for scoping.

## 10. Security and non-functional requirements

- Tokens are verified on every request, and authorization is scoped to the resolved business or customer.
- Readers use separate, revocable credentials; NFC payloads are signed; punch events are idempotent.
- The Wallet signing certificate and APNs keys live in a secrets store, never in the apps or the repository.
- Images: PNG, JPEG, or HEIC only, with a size cap (for example 5 MB), metadata stripped, and private storage.
- Location search stays on the device through Apple Maps; the backend stores only the chosen text.
- No personal data beyond the auth subject; customers are pseudonymous to businesses.
- Structured logs with request IDs; no tokens or pass payloads in logs.
- MVP targets: p95 punch intake under 500 ms; Wallet update push sent within 10 seconds of a punch.
- Development environment only until a production review; no production data in development.
- Infrastructure as code; deploys from CI through OIDC, with no stored cloud secrets.

## 11. Open decisions

1. **Redemption**: how a reward is presented and verified at checkout (for example, an NFC tap
   of a reward pass, or the business confirming it in the partner app). The diagram leaves this
   out of the partner screens; `POST /v1/partner/rewards/{id}/redeem` is a placeholder.
2. **When the customer app shows a coupon**: the backend earns the reward when the card fills,
   while the customer prototype adds the coupon to Redeemed on claim or rollover. Decide whether
   to show it as soon as the card is full.
3. **Reward expiry**: none in the MVP; confirm.
4. **Reader hardware** and how readers are provisioned to a business.
5. **Hosting**: Azure was prototyped and then removed to keep cost at $0; choose before building.

## 12. Exit criteria

The backend MVP is done when every item below is met in a development environment.

Auth and tenancy

- [ ] Partner and customer apps sign in; the API rejects missing, expired, or foreign tokens (`401`).
- [ ] Cross-business and cross-customer access is rejected (`403`), with automated tests.

Business and card configuration

- [ ] A business can be created and edited; its logo and cover upload and display through signed URLs.
- [ ] Publishing validates the 3.1 rules server-side, creates an immutable version, and moves
      the live pointer in one transaction; identical settings return `409`.
- [ ] Publish impact and version usage (Live, Finishing, Retired) match the partner app's local rules.
- [ ] The customer app renders a published card identically to the partner app's preview.

Cards, punches, and rollover

- [ ] Enrollment is idempotent.
- [ ] A punch on a full card creates a new card with 1 punch and keeps the earlier reward
      available, in one transaction, with tests.
- [ ] Rewards stack, there is one reward per completed card, and redeeming never changes punches.
- [ ] Duplicate `eventId`s, revoked readers, wrong-business passes, stale timestamps, and taps
      inside the cooldown add no punches, with tests.

Wallet and notifications

- [ ] A signed pass installs on a device and updates within 10 seconds of a punch or rollover.
- [ ] The partner app shows "new card started" and "rewards to redeem" from the backend.

Dashboard

- [ ] Dashboard counts match section 8.4 against a seeded dataset, including half-open ranges
      and unique-customer enrollment.

Quality

- [ ] API contract tests and the iOS CI (`.github/workflows/ios.yml`) pass on `main`.
- [ ] Both apps switch from sample data to the API behind a launch argument, keeping sample data
      for UI tests.
- [ ] Load test: 50 punches per second sustained with p95 under 500 ms.
- [ ] Security review is complete, secrets are only in the secrets store, and a monthly cost
      estimate is approved.
