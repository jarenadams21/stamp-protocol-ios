# JOEYY backend

The shared API for the customer and partner apps, built to [docs/backend-spec.md](../docs/backend-spec.md).
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
| `POST /v1/partner/program/versions` | Publish: validates, inserts an immutable version (with its cover), moves the live pointer and zero-punch cards in one transaction; `409 unchangedProgram` |
| `GET /v1/partner/dashboard?from&to` | Section 8.4 counts, including `rewardsWaiting` and `customersWithStackedRewards` |
| `GET /v1/partner/notifications?after&limit` | Newest first, cursor paged |
| `GET /healthz` | Checks the database connection; no token needed |
| `/v1/auth/…` | Sign-in with Google, Apple, or a one-time code by email or text (see [Sign-in](#sign-in)) |

Not yet implemented: customer routes, NFC punch intake, Apple Wallet, push notifications, and
redemption (open decision 1). The schema already has the tables for punches, readers, rewards, and
notifications.

## Run it locally

You need Node 22.18 or later and the Azure CLI signed in to the JOEYY directory
(`az login --tenant 939f4731-d4d0-4cc5-b75e-decd2df66d0a`). Teammates are guests in the
`joeyy-devs` Entra group and set `PGUSER=joeyy-devs`; the group has the same table rights as
`joeyyadmin`.

```sh
cd backend
cp .env.example .env     # already filled in for the dev server
npm install
npm run migrate          # applies any new migrations
npm run dev              # http://localhost:8080
```

Call it with a development token (`AUTH_MODE=dev` signs tokens with a key in `.dev/`, which git ignores):

```sh
TOKEN=$(npm run -s token -- partner my-test-owner)
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/partner/business
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
- **In CI** (`.github/workflows/backend.yml`), tests run against a Postgres 17 service container
  with a password and `PGSSLMODE=disable`.

TLS with certificate verification is on for every connection except `PGSSLMODE=disable`.

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
  `phone:<keyed hash>`. Email addresses are trimmed and lowercased first. Neither email addresses
  nor phone numbers are stored or put in tokens.
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

The API signs in to Communication Services with `DefaultAzureCredential`, as it does for the
database, so there is no access key or connection string.

### Setting up email codes in Azure

1. **Email Communication Services resource**: in the Azure portal, create an *Email Communication
   Services* resource (for example `joeyy-dev-email`) in `joeyy-dev-rg`, data location United States.
2. **Azure-managed domain**: open it, go to **Provision domains**, and choose **Add domain** →
   **Azure managed domain**. This gives a domain like `<id>.azurecomm.net` that's verified and can
   send right away, with no DNS work. Its default sender is `DoNotReply@<id>.azurecomm.net`; that's
   `EMAIL_FROM`. You can rename the sender's display name to JOEYY under **MailFrom addresses**.
3. **Communication Services resource**: create a *Communication Services* resource (for example
   `joeyy-dev-acs`) in the same resource group and data location. Its **Endpoint** on the Overview
   page is `ACS_EMAIL_ENDPOINT` (and later `ACS_ENDPOINT` for texts).
4. **Connect them**: in the Communication Services resource, go to **Email** → **Domains** →
   **Connect domain**, and pick the Azure managed domain from step 2.
5. **Let the API send**: on the Communication Services resource, **Access control (IAM)** → **Add
   role assignment**, and give the API's managed identity a custom role with
   `Microsoft.Communication/CommunicationServices/Read` and
   `Microsoft.Communication/CommunicationServices/Write` (Microsoft documents *Contributor* or that
   custom role for Entra sign-in; the custom role is narrower). For local runs against Azure, assign
   it to the `joeyy-devs` group too.
6. **Turn it on**: set `ACS_EMAIL_ENDPOINT`, `EMAIL_FROM`, and `SIGN_IN_METHODS=google,email`.

Azure managed domains are for development only: they're limited to about 5 emails a minute and
10 an hour per subscription. Before the pilot, add your own domain under **Provision domains**,
verify it with the DNS records Azure shows (TXT, SPF, DKIM, and DKIM2), connect it in step 4, and
use a sender on it. A custom domain starts at 30 a minute and 100 an hour, and higher limits can be
requested through a support ticket. When Azure throttles, the API answers `503 emailUnavailable`. Email sign-in codes can land in spam from an `azurecomm.net` sender; your
own domain helps.

For texts later: buy a toll-free number on the Communication Services resource (**Phone numbers**),
submit toll-free verification (it can take several weeks), then set `ACS_ENDPOINT`, `SMS_FROM`, and
add `phone` to `SIGN_IN_METHODS`. For Apple, enable Sign in with Apple for `com.joeyy.customer` in
the Apple Developer account, set `APPLE_AUDIENCES`, and add `apple`.
## Production identity

Tokens are issued by this API (see [Sign-in](#sign-in)). Every request is checked for signature,
issuer, audience, and expiry, and the business or customer comes from the token's `sub`, never from
the request body.
