# JOEYY backend

The shared API for the customer and partner apps, built to [docs/backend-spec.md](../../docs/backend-spec.md).
It is one Node.js application (Fastify, TypeScript run directly by Node 22.18+) backed by
**Azure Database for PostgreSQL**, with images in a private **Azure Blob Storage** container.

| | |
| --- | --- |
| Server | `joeyy-dev-pg.postgres.database.azure.com` (resource group `joeyy-dev-rg`, West US, PostgreSQL 17, Burstable B1ms) |
| Database | `joeyyRewards` |
| Sign-in | Microsoft Entra ID. No database password is stored in the app or this repository. |
| Schema owner | `joeyyadmin`. Migrations run as this role through `SET ROLE` |
| Images | Blob container `images` in the storage account named by `AZURE_STORAGE_ACCOUNT`. Private; Microsoft Entra sign-in only |

## What's implemented

The partner MVP diagram's three flows, plus images and notifications:

| Route | |
| --- | --- |
| `GET`, `PUT /v1/partner/business` | Business profile (one per owner, upsert on the token's subject), with its logo |
| `POST /v1/partner/images?kind=logo\|cover` | Upload a logo or cover photo; returns its key and a short-lived URL |
| `GET /v1/partner/program` | Live card configuration (spec section 3.1 contract) |
| `GET /v1/partner/program/versions` | All versions with usage: live, finishing, or retired |
| `GET /v1/partner/program/publish-impact` | `{ keepRules, switchToNew }` |
| `POST /v1/partner/program/versions` | Publish: validates, inserts an immutable version (with its cover), moves the live pointer and zero-punch cards in one transaction; `409 unchangedProgram`. Optional `minMinutesBetweenStamps` (1–1440), the business's own repeat-stamp limit |
| `GET /v1/partner/dashboard?from&to` | Section 8.4 counts, including `rewardsWaiting` and `customersWithStackedRewards` |
| `GET /v1/partner/notifications?after&limit` | Newest first, cursor paged. Stand taps write `card.rolledOver` and `reward.waiting` (`{ rewardsWaiting }`) |
| `GET /v1/partner/stands` | `{ stands, pairing }`: linked stands (`standId`, `label`, `status`, `linkedAt`, `lastTapAt`) and the open pairing window (`{ expiresAt }` or `null`) |
| `POST`, `DELETE /v1/partner/stands/pairing` | Opens a 2-minute window (`409 noLiveProgram` before a card is published) or closes it. Same shape |
| `POST /v1/partner/stands/{standId}/turn-off` | For good: its taps answer `tagDisabled`. Same shape; `404 standNotFound` |
| `GET /v1/partner/activity?from&to` | `{ activity: [{ kind, at, punches }] }`: `first`, `stamp`, `earned`, `used`; newest first, at most 50, half-open range. Never says who |
| `GET /v1/places` | No sign-in needed. The Discover list: businesses with a published card and at least one linked stand, newest first, at most 50. `{ places }`, as search |
| `GET /v1/places?query=` | No sign-in needed. Search places by name (case-insensitive, names starting with the query first) or exact client ID; at most 20, only businesses with a published card |
| `GET /v1/places/{placeId}` | No sign-in needed. A place: its business fields plus `program`, the live card (section 3.1); `404 placeNotFound` for unknown or unpublished |
| `/v1/web/…` | The website's diner routes, with a cookie session (see [The website](#the-website)) |
| `/v1/dev/…` | `AUTH_MODE=dev` only: allocate and link stands, make tap links (see [The website](#the-website)) |
| `GET /healthz` | Checks the database connection; no token needed |
| `/v1/auth/…` | Sign-in with Google, Apple, or a one-time code by email or text (see [Sign-in](#sign-in)) |

Not yet implemented: the app's customer routes (cards, rewards, groups), reader punch intake
(`POST /v1/punches`), Apple Wallet, push notifications, and partner-side redemption (open decision 1).

## The website

The website (`apps/web`) calls `/v1/web/*` with `fetch(..., { credentials: 'include' })`; the plan is
[docs/web-connect.md](../../docs/web-connect.md) and the contract is
[apps/web/docs/identity-and-api.md](../../apps/web/docs/identity-and-api.md), with response shapes in
`apps/web/src/api/types.ts`. Errors are `{ error, code, message }`; the website reads `code`.

A browser is an HttpOnly cookie, `joeyy_web` (`SameSite=Lax`, `Path=/v1/web`, `Secure` unless
`AUTH_MODE=dev`, 400 days), that points at a customer through `web_sessions`, where only its SHA-256
is stored. A browser's first tap creates an anonymous customer (`web:<uuid>`). Signing in with a
code moves the browser to the same customer the iOS app gets for that number or address
(`phone:<keyed hash>`, `email:<keyed hash>`) and merges the anonymous cards into it.

| Route | |
| --- | --- |
| `POST /v1/web/taps` | `{ picc, cmac }` → `TapResult`: `stamped`, `completed`, `cooldown`, `redeemed`, `replayed`, `invalidTag`, `tagNotActive`, `tagDisabled`, or `standLinked` (the owner's pairing tap). Always `200` |
| `GET /v1/web/me/cards` | `{ identity, cards }`: the diner's order first, then most recent visit |
| `GET /v1/web/me/cards/{businessId}` | One `CardState`; `404 notFound` |
| `PUT /v1/web/me/cards/order` | `{ businessIds }` → `204` |
| `POST /v1/web/redeem-intents` | `{ rewardId }` → `RedeemIntent`, open 2 minutes; the next tap at that business redeems |
| `GET`, `DELETE /v1/web/redeem-intents/{id}` | `{ intent, redemption? }` for this browser only; cancel → `204` |
| `POST /v1/web/phone/start`, `/email/start` | `{ phone }` → `{ maskedPhone }`, `{ email }` → `{ maskedEmail }`. Same codes and limits as `/v1/auth` |
| `POST /v1/web/phone/verify`, `/email/verify` | `{ code }` → `SignInResult`; `400 invalidCode`, `400 expired` with no code started |
| `POST /v1/web/sign-out` | `204`; ends this browser's session |
| `PUT /v1/web/me/profile` | `{ displayName }` → `Identity`; `404` for an anonymous browser, `400 invalidName` |
| `DELETE /v1/web/me` | `204`; deletes the account and everything on it, signs out every browser and the app |

Taps: the tag's counter is accepted with one `UPDATE readers … WHERE last_counter < $counter`, so a
reloaded or shared link answers `replayed`. The punch (reader = the stand, event ID
`tag:<uid>:<counter>`), any rollover card, any reward, and the notifications are one transaction.
There is no built-in limit on repeat taps; a business can publish `minMinutesBetweenStamps`.

Stand links are checked by `TAG_MODE`. `sun` verifies NTAG 424 DNA SUN messages (AES-CMAC, NXP
AN12196) with `SUN_META_READ_KEY` and `SUN_FILE_READ_KEY`; `dev` (the default outside production)
also accepts `picc=<tag uid>.<counter>` with any `cmac`.

Development only (`AUTH_MODE=dev`; the routes don't exist otherwise):

| Route | |
| --- | --- |
| `POST /v1/dev/stands` | Owner token. Allocates a new stand to the owner's business → `201 { tagUid }` |
| `POST /v1/dev/stands/touch` | Owner token. The owner's phone touching a new stand while pairing is open: allocates and links one. `409 pairingClosed` |
| `POST /v1/dev/taps/{tagUid}` | No token. `{ next: "/t?picc=<tagUid>.<counter>&cmac=dev" }` with a counter newer than any seen |

```sh
TOKEN=$(npm run -s token -- partner my-test-owner)
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:8080/v1/partner/stands/pairing
TAG=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" localhost:8080/v1/dev/stands | jq -r .tagUid)
curl -X POST localhost:8080/v1/web/taps -H 'content-type: application/json' -d "{\"picc\":\"$TAG.1\",\"cmac\":\"dev\"}"   # links it
curl -c jar -b jar -X POST localhost:8080/v1/web/taps -H 'content-type: application/json' -d "{\"picc\":\"$TAG.2\",\"cmac\":\"dev\"}" # stamps
```

## Run it locally

You need Node 22.18 or later and the Azure CLI signed in to the JOEYY directory
(`az login --tenant 939f4731-d4d0-4cc5-b75e-decd2df66d0a`). Teammates are guests in the
`joeyy-devs` Entra group and set `PGUSER=joeyy-devs`; the group has the same table rights as
`joeyyadmin`.

```sh
cd services/api
cp .env.example .env     # already filled in for the dev server
npm install
npm run migrate          # applies any new migrations
npm run dev              # http://localhost:8080
```

Call it with a development token (`AUTH_MODE=dev` signs tokens with a key in `.dev/`, which git ignores):

```sh
TOKEN=$(npm run -s token -- partner my-test-owner)
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/partner/business

# Find places and read one (no token needed)
curl "localhost:8080/v1/places?query=cafe"
```

The dev server accepts connections from any IP (firewall rule `allow-all`) but only Microsoft Entra
sign-ins; password sign-in is off. Before real customer data, move it to private networking.

## How the database connection works

[`src/db.ts`](src/db.ts) builds a `pg` pool from the standard `PG*` variables. When `PGPASSWORD` is
unset, the pool's password is a Microsoft Entra access token for
`https://ossrdbms-aad.database.windows.net/.default`, from `DefaultAzureCredential`, cached until
shortly before it expires. It works like this:

- **On your Mac**, the token comes from `az login`. `AZURE_TOKEN_CREDENTIALS=dev` in `.env` skips
  the slow managed-identity probe.
- **In Azure** (once hosting is chosen), give the app a managed identity, add it as a Postgres
  Entra principal, and set `PGUSER` to its name. The code doesn't change.
- **In CI** (`.github/workflows/api.yml`), tests run against a Postgres 17 service container
  with a password and `PGSSLMODE=disable`.

TLS with certificate verification is on for every connection except `PGSSLMODE=disable`.

## Container image

[`Dockerfile`](Dockerfile) builds the API on `node:22-slim`: production dependencies only, run as
the non-root `node` user, listening on port 8080. Settings come from environment variables (as in
`.env.example`); `.dockerignore` keeps `.env`, `.dev/`, and `node_modules` out of the build, so the
image holds no secrets. Every pull request that changes the API builds it and checks that (the
`Container image builds` job in `.github/workflows/api.yml`).

```sh
cd services/api
docker build -t joeyy-api .
# or build in Azure Container Registry, without Docker locally:
az acr build --registry <registry> --image joeyy-api:$(git rev-parse --short HEAD) .
```

## See who signed up

[docs/setup/see-signed-up-users.sql](../../docs/setup/see-signed-up-users.sql) lists every customer
and business owner with their email, sign-in method, first and last sign-in, signed-in devices, and
business. Run it with the `psql` command under [Migrations](#migrations): `psql "…" -f ../../docs/setup/see-signed-up-users.sql`.

### Sample places for development

`npm run seed:places` adds the website demo's eight sample places (from
`apps/web/server/demo/data.ts`) through the API's own routes, each with a published card and a
working stand, so Discover and taps have something to show. `AUTH_MODE=dev` only; running it again
skips places that exist. `POST /v1/dev/places/{businessId}/tap` then makes a fresh tap link for any
place's first stand.

## Migrations

`db/migrations/NNNN_name.sql` files are applied in order by `npm run migrate`. Each one runs in a
transaction and records itself in `schema_migrations`. **Never edit an applied migration**; add the
next number instead.

| Migration | |
| --- | --- |
| `0001_initial_schema` | Copied unchanged from the standalone partner prototype (`joeyy-partner-ios/backend`), where it was first applied |
| `0002_align_with_backend_spec` | OIDC subjects, one business per owner with a single location, the section 3.1 theme JSON, `closed`/archived/favorite cards, punches from readers, notifications, and a trigger that keeps punches within the card's version |
| `0003_images` | The `images` table (one row per upload), foreign keys so a logo or cover must be an image the same business uploaded, and the `image_deletions` queue with the trigger that fills it |
| `0004_sign_in` | Hashed refresh tokens grouped into sessions, and hashed phone codes with their send limits |
| `0006_account_email` | `email` and `last_sign_in_at` on `customers` and `business_owners`. Numbered after the dev database's `0005_native_prototype`, which isn't in this repository |
| `0007_web` | Stands as `readers` with `kind = 'stand'` (`tag_uid`, `status`, `last_counter`, `activated_at`, `last_tap_at`), a business's pairing window, `program_versions.min_minutes_between_stamps`, `customers.display_name` and `card_order`, `web_sessions`, and `redeem_intents` |

To check what's applied:

```sh
export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
psql "host=joeyy-dev-pg.postgres.database.azure.com dbname=joeyyRewards user=$(az account show --query user.name -o tsv) sslmode=require" \
  -c "select * from schema_migrations order by version"
```

## Images

Logos and cover photos are stored in a private blob container and reached only through short-lived
links. The flow is upload, then attach:

```sh
# 1. Upload. The body is the image itself; kind is logo or cover.
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/png" \
  --data-binary @logo.png "localhost:8080/v1/partner/images?kind=logo"
# => { "key": "businesses/<id>/logo/<uuid>.png", "url": "https://…", "width": 512, … }

# 2. Attach the key. A logo goes on the business; a cover goes in the theme when publishing.
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "My Cafe", "logoKey": "businesses/<id>/logo/<uuid>.png" }' localhost:8080/v1/partner/business
```

- **Accepted**: PNG and JPEG up to 5 MB. The apps convert photos to one of these before uploading.
  The API reads the real format from the bytes and ignores a wrong `Content-Type`.
- **Stored**: a re-encoded copy with the camera's rotation applied, colors converted to sRGB, all
  metadata removed (including GPS location), and scaled down to fit 1024 px (logo) or 2048 px (cover).
- **Ownership**: a key works only for the business that uploaded it and only for its kind. Anything
  else is `400 unknownImage`, whether the key is made up or belongs to another business.
- **`PUT /business`**: `logoKey` sets the logo, `null` removes it, and leaving it out keeps it. A
  business must exist before it can upload, so a first save can't carry a logo.
- **Publishing**: send `theme.coverKey`, or leave it out for no cover. Changing only the cover counts
  as a change. Older versions keep the cover they were published with.
- **Reading**: responses include `logoURL` and `theme.coverURL`, which stop working after 15 minutes
  (`IMAGE_URL_TTL_SECONDS`). Blob Storage is the only place an image is kept; apps store keys and
  treat any copy on the phone as a disposable cache (spec section 3.2).
- **Errors**: `413 imageTooLarge`, `415 unsupportedImageType`, `400 invalidImage`,
  `400 invalidImageKind`, and `503 imageStorageUnavailable`.

[`src/images.ts`](src/images.ts) signs in to Blob Storage with `DefaultAzureCredential`, exactly as
the database does, so there is no account key or connection string. The links are user delegation
SAS tokens: Entra gives the API a temporary signing key, and the API signs each link itself. Shared
key access and public access are both turned off on the storage account.

Set `IMAGE_STORE=local` to work without Azure. Images are then kept in `.dev/images/` (git-ignored)
and served by the API through signed links that expire the same way. It refuses to start when
`NODE_ENV=production`.

### Cleanup

The API deletes images nothing uses anymore, once an hour (spec section 3.2):

| Image | What happens |
| --- | --- |
| The business's current logo | Kept |
| A cover on **any** version, including older ones | Kept, because version history shows it |
| An upload attached to nothing, younger than 24 hours | Kept, so an app can upload and then save |
| A replaced logo, or an upload never saved, older than 24 hours | Deleted |
| Every image of a deleted business | Deleted on the next run |

It works in two steps, so no file is forgotten. First it deletes unused rows from `images`; the
database refuses to delete a row that's in use, and a trigger queues each deleted row's file in
`image_deletions`. Then it deletes each queued file from storage, and its queue row. A file that
can't be deleted stays queued, with `attempts` and `last_error`, and is retried on the next run.
A business deleted any other way (for example, account deletion later) is queued by the same trigger.

- **Settings**: `IMAGE_CLEANUP=on|off` (on for Azure and off for the local folder unless set) and
  `IMAGE_UNUSED_HOURS` (24 unless set). Only one cleanup runs at a time, even with several servers.
- **Run it now**: `npm run images:cleanup -- --dry-run` lists what would be deleted;
  `npm run images:cleanup` deletes it. The script prints which database and storage it's using first.
- **Recovery**: soft delete is on for the storage account, so a deleted file or container can be
  restored for 7 days (Azure portal: the container, then **Show deleted blobs**).
- An app that saves a key cleanup already removed gets `400 unknownImage` and uploads again.

## Tests

```sh
npm run typecheck
npm test
```

Each test file creates its own schema (`test_<timestamp>`), applies every migration to it, and drops
it at the end, so tests never touch real data. Locally that schema is on the Azure dev database;
in CI it's in the service container. Image tests store files in a temporary folder.

One test talks to the real storage account and is skipped unless you name it:

```sh
AZURE_STORAGE_TEST_ACCOUNT=<the storage account's name> npm test
```

## Sign-in

There is one sign-in system for the apps and the website: **Sign in with Apple**, **Google**, or a
**one-time code by email or text message**. There are no passwords anywhere. The API checks the
provider's proof or the code itself and then issues its own tokens (spec section 8.5), so there is
no separate auth service or vendor. For the first version only Google and email are on; Apple and
phone are built and turn on with `SIGN_IN_METHODS` once they're set up.

| Route | |
| --- | --- |
| `GET /v1/auth/methods` | `{ methods }`: the methods that are on, so apps show only those |
| `POST /v1/auth/google` | `{ role, idToken, nonce }`. Google's token must carry `nonce` |
| `POST /v1/auth/email/start` | `{ email }` → `202 { expiresIn, resendAfter }`, and a 6-digit code by email |
| `POST /v1/auth/email/verify` | `{ role, email, code }` |
| `POST /v1/auth/apple` | `{ role, identityToken, nonce }`. Apple's token must carry SHA-256(`nonce`) |
| `POST /v1/auth/phone/start` | `{ phoneNumber }` → `202 { expiresIn, resendAfter }`, and a 6-digit code by text |
| `POST /v1/auth/phone/verify` | `{ role, phoneNumber, code }` |
| `POST /v1/auth/refresh` | `{ refreshToken }` → a new session; the old refresh token stops working |
| `POST /v1/auth/sign-out` | `{ refreshToken }` → `204`; ends that session on the server |
| `GET /.well-known/jwks.json` | The public key that signs access tokens |

Sign-in returns `{ accessToken, tokenType: "Bearer", expiresIn, refreshToken }`.

- **Two sides, two accounts.** `role` is `customer` or `partner`. The access token's audience is
  `joeyy-customer` or `joeyy-partner`, and every route checks it, so a customer token gets `401` on
  partner routes and the other way around. The same Google account, email address, Apple ID, or
  phone number used on both sides is two separate accounts. Accounts aren't linked across methods.
- **Tokens.** Access tokens are RS256 JWTs that last 15 minutes. Refresh tokens last 60 days from
  their last use and rotate on every refresh. If an old one comes back, the whole session is revoked.
  Only their SHA-256 hashes are stored.
- **Subjects** are `google:<Google user ID>`, `email:<keyed hash>`, `apple:<Apple user ID>`, or
  `phone:<keyed hash>`. Email addresses are trimmed and lowercased first. Subjects and tokens never
  contain an email address or phone number.
- **Who signed up.** `customers` and `business_owners` also keep `email` and `last_sign_in_at`,
  updated on every sign-in: the address from a Google (or Apple) token with `email_verified`, or the
  address an email code was just verified for. A sign-in without one keeps the saved address. Phone
  numbers are never stored. [docs/setup/see-signed-up-users.sql](../../docs/setup/see-signed-up-users.sql)
  lists everyone.
- **Codes** (email and text work the same way) expire in 10 minutes and allow 5 guesses. An address
  or number can get one code every 30 seconds and 5 an hour. Each IP address gets 10 code requests
  and 60 sign-in calls an hour. Only countries in `PHONE_COUNTRY_CODES` (the US and Canada by
  default) can get texts, to limit SMS fraud.
- **Errors**: `401 signInFailed` for a bad Apple or Google token, `400 invalidCode`, `400 invalidEmail`,
  `400 invalidPhoneNumber`, `400 unsupportedPhoneNumber`, `429 tooManyRequests` (with
  `Retry-After`), `503 emailUnavailable` or `503 smsUnavailable` when a code can't be sent, and
  `503 signInUnavailable` for a method that's off.

### Settings

`AUTH_MODE=dev` (the `.env.example` default) signs with a key in `.dev/`, turns on every method,
and writes email and text codes to the server log instead of sending them (unless the Azure
settings are present). It still checks real Apple and Google tokens. `npm run token` mints tokens
with the same key. Dev mode refuses to start when `NODE_ENV=production`.

`AUTH_MODE=live` (the default when unset) needs:

| Setting | |
| --- | --- |
| `AUTH_ISSUER` | This API's public `https://` URL |
| `AUTH_SIGNING_KEY`, `SIGN_IN_HASH_PEPPER` | Secrets from `npm run auth:key`. Keep them in the secrets store. Changing the pepper turns every email and phone account into a new one |
| `SIGN_IN_METHODS` | Which methods are on, for example `google,email`. Unset, every method whose settings are present is on. The API won't start with a method on but not set up |
| `GOOGLE_CLIENT_IDS` | The Google OAuth iOS client ID and, for the website, the web client ID |
| `ACS_EMAIL_ENDPOINT`, `EMAIL_FROM` | An Azure Communication Services resource with a connected email domain, and a sender address on it (see below) |
| `APPLE_AUDIENCES` | The app's bundle ID (`com.joeyy.customer`) and, for the website, its Services ID |
| `ACS_ENDPOINT`, `SMS_FROM`, `PHONE_COUNTRY_CODES` | The Communication Services resource and its toll-free number for texts |
| `TRUST_PROXY` | `true` behind a load balancer, so rate limits see the client's IP |

The website adds:

| Setting | |
| --- | --- |
| `WEB_ORIGINS` | The website's origins, comma-separated (for example `https://joeyy.app`). Only these get CORS with credentials, and only on `/v1/web` and `/v1/places`. Unset: none (the Vite dev server proxies `/v1`, so local work needs none) |
| `TAG_MODE` | `sun` (the default when `NODE_ENV=production`, where `dev` is refused) or `dev` |
| `SUN_META_READ_KEY`, `SUN_FILE_READ_KEY` | The stands' AES-128 keys as 32 hex characters, the same for every stand for now. Required with `TAG_MODE=sun`; with `dev`, optional and lets real stands work too |

The API signs in to Communication Services with `DefaultAzureCredential`, as it does for the
database, so there is no access key or connection string.

### Google

- **Project**: Google Cloud project `joeyy-515223`, owned by `joeyy.dev@gmail.com`.
- **iOS client** "JOEYY iOS" for bundle ID `com.joeyy.customer`:
  `461007702405-0fe1j629n2a79j3n0ss2mkoso67l9gqq.apps.googleusercontent.com`. Client IDs aren't
  secrets. The app has it in `AppConfiguration.googleIOSClientID`, and the backend needs it in
  `GOOGLE_CLIENT_IDS`. The website will need a separate web client ID added there too.
- **How the app signs in**: authorization code with PKCE in `ASWebAuthenticationSession`, redirecting
  to the reversed client ID (`com.googleusercontent.apps.461007702405-…:/oauth2redirect`). The
  session catches that redirect itself, so the app registers no URL scheme. iOS clients have no
  client secret.
- **Consent screen**: External, in **Testing** mode. Only the test users can sign in:
  `joeyy.dev@gmail.com` and `elshiekh.a7@gmail.com`. Add pilot testers under **Audience** → **Test
  users** (up to 100), or publish the app before the pilot. Only the `openid` scope is requested,
    so publishing doesn't need Google's sensitive-scope verification.

### Email codes in Azure

**The dev resources exist** in `joeyy-dev-rg` (the `Microsoft.Communication` provider is registered
on the subscription):

| | |
| --- | --- |
| Email Communication Services | `joeyy-dev-email`, with an Azure managed domain |
| Communication Services | `joeyy-dev-acs`, data location United States, connected to that domain |
| `ACS_EMAIL_ENDPOINT` | `https://joeyy-dev-acs.unitedstates.communication.azure.com` |
| `EMAIL_FROM` | `DoNotReply@9aa68052-30df-47a1-98ee-71efb451688c.azurecomm.net` |
| Who can send | The `joeyy-devs` group is Owner of `joeyy-dev-rg`, so `az login` as a member is enough locally |

Both values are in `.env.example`, so `AUTH_MODE=dev` really emails codes through
`DefaultAzureCredential` once you're signed in. Remove either one to write codes to the log instead.
To try the flow locally:

```sh
curl -X POST localhost:8080/v1/auth/email/start -H "Content-Type: application/json" -d '{ "email": "you@example.com" }'
curl -X POST localhost:8080/v1/auth/email/verify -H "Content-Type: application/json" \
  -d '{ "role": "customer", "email": "you@example.com", "code": "<the 6 digits>" }'
```

**Rate limits.** The managed domain is for development only: about 5 emails a minute and 10 an hour
**per subscription**, shared by everyone testing. Past that, Azure throttles and the API answers
`503 emailUnavailable`. The API's own limits (one code per address every 30 seconds, 5 an hour)
apply first. Codes from an `azurecomm.net` sender can also land in spam.

**Before the pilot:** add your own domain to `joeyy-dev-email` (or a production resource) under
**Provision domains**, verify it with the DNS records Azure shows (TXT, SPF, DKIM, and DKIM2),
connect it under the Communication Services resource's **Email** → **Domains**, and set `EMAIL_FROM`
to a sender on it. A custom domain starts at 30 emails a minute and 100 an hour; higher limits can
be requested through a support ticket.

**In Azure hosting**, give the API's managed identity a role on `joeyy-dev-acs` (or the production
resource): *Contributor*, or a narrower custom role with
`Microsoft.Communication/CommunicationServices/Read` and `.../Write`, which is what Microsoft
documents for Entra sign-in. Then set `ACS_EMAIL_ENDPOINT`, `EMAIL_FROM`, and
`SIGN_IN_METHODS=google,email`.

To create the resources again elsewhere: create an *Email Communication Services* resource, add an
**Azure managed domain** under **Provision domains** (its sender `DoNotReply@<id>.azurecomm.net` is
`EMAIL_FROM`), create a *Communication Services* resource in the same data location (its
**Endpoint** is `ACS_EMAIL_ENDPOINT`), and connect the domain under **Email** → **Domains**.

For texts later: buy a toll-free number on the Communication Services resource (**Phone numbers**),
submit toll-free verification (it can take several weeks), then set `ACS_ENDPOINT`, `SMS_FROM`, and
add `phone` to `SIGN_IN_METHODS`. For Apple, enable Sign in with Apple for `com.joeyy.customer` in
the Apple Developer account, set `APPLE_AUDIENCES`, and add `apple`.

## Production identity

Tokens are issued by this API (see [Sign-in](#sign-in)). Every request is checked for signature,
issuer, audience, and expiry, and the business or customer comes from the token's `sub`, never from
the request body.
