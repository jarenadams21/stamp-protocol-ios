# JOEYY shared backend

One Fastify/TypeScript application on Node **24+**, using PostgreSQL 17 and private Azure
Blob images. `npm start` runs `src/server.ts`, not the retained SQLite prototype server.
The partner API and OIDC/RS256 authentication are unchanged. Native NFC/password accounts
and Apple Wallet are an **opt-in compatibility domain in the same PostgreSQL database**.

## Shared partner service

| Route | Behavior |
| --- | --- |
| `GET`, `PUT /v1/partner/business` | Owner-subject business profile and logo |
| `POST /v1/partner/images?kind=logo\|cover` | Private image upload and short-lived URL |
| `GET /v1/partner/program` | Live program |
| `GET /v1/partner/program/versions` | Immutable version history and usage |
| `GET /v1/partner/program/publish-impact` | Keep-rules/switch-to-new impact |
| `POST /v1/partner/program/versions` | Publish an immutable version |
| `GET /v1/partner/dashboard?from&to` | Dashboard and accumulated reward counts |
| `GET /v1/partner/notifications?after&limit` | Cursor-paged notifications |
| `GET /healthz` | Database health; separate native enabled/factory-test status |

Copy `.env.example` to ignored `.env` and configure the shared service. `npm ci`,
`npm run migrate`, then `npm run dev`. The latter loads `.env`; `npm start` expects
environment variables supplied by the host. `HOST`/`PORT` default to `0.0.0.0:8080`.

`src/db.ts` uses standard `PG*` settings. With no `PGPASSWORD`, its password callback
uses `DefaultAzureCredential` for `https://ossrdbms-aad.database.windows.net/.default`,
caching tokens until near expiry. Locally use the team's Azure CLI sign-in and
`AZURE_TOKEN_CREDENTIALS=dev`; hosting uses its managed identity. TLS verifies the
server certificate unless `PGSSLMODE=disable` (local/CI only). Shared development uses
`joeyy-dev-pg.postgres.database.azure.com`, database `joeyyRewards`, owner `joeyyadmin`.
Teammates can use the `joeyy-devs` Entra group. Network/identity/deployment changes are
operator responsibilities, not startup behavior.

`AUTH_MODE=dev` uses a private, ignored `.dev/signing-key.json`; generate a **partner**
token with `npm run token -- partner OWNER_SUBJECT`. This is not a native customer
login mechanism and no signing key belongs in an app. Production rejects dev mode.
`AUTH_MODE=oidc` requires `OIDC_ISSUER`, `OIDC_JWKS_URI`, `PARTNER_AUDIENCE`, and
`CUSTOMER_AUDIENCE`; signatures, RS256 algorithm, issuer, audience, expiry and subject
are checked. Native bearer sessions cannot authorize partner operations, or vice versa.

### Images

`IMAGE_STORE=azure` uses `AZURE_STORAGE_ACCOUNT` and a private container
(`AZURE_STORAGE_CONTAINER=images` by default), signing in through
`DefaultAzureCredential`, without account keys. Upload PNG/JPEG bytes (up to 5 MB) with
the image content type, then attach the returned key as business `logoKey` or published
theme `coverKey`. Ownership and kind are checked. Images are rotated, re-encoded,
metadata-stripped and scaled to 1024 px for logos / 2048 px for covers. Returned links
expire after `IMAGE_URL_TTL_SECONDS` (900; allowed 60–3600).

`IMAGE_STORE=local` stores ignored `.dev/images` and requires `PUBLIC_BASE_URL`; it is
for development only and refuses production. Cleanup is hourly by default for Azure,
off for local: `IMAGE_CLEANUP=on|off`, `IMAGE_UNUSED_HOURS=24`. Current business logos
and covers in **any** published version are retained; old unattached uploads are
removed using the durable `image_deletions` queue. `npm run images:cleanup -- --dry-run`
previews; omit `--dry-run` to apply. Deleted Blob data is subject to the storage
account's configured soft-delete retention (shared dev currently seven days).

## Explicit migrations

`npm run migrate` applies unapplied files, one transaction per migration, recording
`schema_migrations`. `MIGRATION_ROLE=joeyyadmin` uses **SET LOCAL ROLE** inside each
transaction so new objects share the team's owner. Runtime needs table/sequence
permissions through the team's existing grants/default privileges. Startup does
**not** migrate, create cafes, seed chips, import customer data, or write Azure resources.

| Migration | Purpose |
| --- | --- |
| `0001_initial_schema` | Original partner domain |
| `0002_align_with_backend_spec` | OIDC identities, immutable published rules, cards/rewards/notifications |
| `0003_images` | Private image ownership and durable deletion queue |
| `0004_native_nfc` | Additive `native_*` compatibility tables and Wallet change sequence |

Never edit an already applied migration. Back up the database before a cutover.

## Enable native NFC + Wallet

Default `NATIVE_NFC_ENABLED=0` leaves `/api/v1` and `/wallet/v1` absent and does not
require native secrets. Set **all** the following when opting in:

```dotenv
NATIVE_NFC_ENABLED=1
PUBLIC_BASE_URL=https://YOUR-STABLE-HTTPS-ORIGIN
SDM_BACKEND_URL=http://PRIVATE-SDM-SERVICE:5005
NATIVE_NFC_KEY_MODE=provisioned
PASS_TYPE_ID=pass.com.yourcafe.loyalty
TEAM_ID=YOURTEAMID
SIGNER_CERT_PATH=/private/path/to/signerCert.pem
SIGNER_KEY_PATH=/private/path/to/signerKey.pem
WWDR_CERT_PATH=/private/path/to/wwdr.pem
# SIGNER_KEY_PASSPHRASE=   # only if the existing external key is encrypted
```

The public origin must be HTTPS, without a path. Missing/invalid settings, unreadable
certificates, an expired or mismatched signing key, or an unapplied native migration
fail explicitly before listening. Certificates remain external paths, never copied
into the repository. Pass bytes are durable PostgreSQL `bytea`, not local disk or Blob.

The private verifier is the existing independent
[`nfc-developer/sdm-backend`](https://github.com/nfc-developer/sdm-backend), prototype
commit `37585f0c76eded73798b936b17aa5e187075b78f`. `support.mjs` retains its original
verification semantics: validate the chip HTTPS URL, forward the original encrypted
hex fields to private `/api/tagtt`, reject verifier error bodies even with HTTP 200,
validate UID/counter/AES-or-LRP output, then apply our global high-water check.
**Do not expose the verifier publicly.** HTTP verifier origins must be loopback,
private IPv4, a local/internal hostname or a container service name. Remote private
network HTTPS origins are also accepted, without embedded credentials.

There is **no crypto fallback**. `provisioned` is an explicit operator assertion that
the upstream uses properly provisioned nonzero keys matching the chips; this process
cannot attest the upstream secret configuration. Factory-zero keys require **both**
`NATIVE_NFC_KEY_MODE=factory-test` and `FACTORY_KEY_TEST=1`. Those messages are forgeable:
use only for gated hardware demonstrations, never valuable rewards. Key bytes,
passwords, tokens, raw NFC URLs and Wallet device paths are not logged.

### Domain boundary (not a unified customer MVP)

The native `native_cafes`, cards, stamps and accumulated reward counts preserve the
hardware-test prototype's rules and identities. They are **separate from partner
business ownership, immutable published programs, dashboards and redemption**. No OIDC
subject or merchant ownership is fabricated. A cryptographically valid chip read is
not proof of a purchase; these test rewards are not redeemable. Account recovery,
email identity migration, merchant-approved purchases and native-to-partner program
unification remain separate work.

The phone continues to read NDEF using `NFCNDEFReaderSession`; an expired hostname
programmed on a chip does not prevent foreground verification of its ciphertext.
Tapping outside the app still opens that programmed hostname. This is not Universal
Links/background NFC support.

### Backwards-compatible native contract

All routes below are under `/api/v1`. Except health/accounts/sessions, send
`Authorization: Bearer <native-session-token>`. Login remains username/password,
salted scrypt with hashed bearer sessions and the existing 30-day expiry.

| Method and route | Contract |
| --- | --- |
| `GET /healthz` | Public native readiness: `{status,factoryKeyTest,publicBaseURL}` |
| `POST /accounts` | `{username,password}` → `{token,username}`; 201 |
| `POST /sessions` | Same body/response; 200 |
| `DELETE /session` | Revoke this session; 204 |
| `GET /cards` | `{cards:[...]}` for only the signed-in customer |
| `POST /taps` | `{url,requestId}` → `{eventId,card,duplicate}` |
| `GET /cards/:id/pass` | Owner-authorized signed `.pkpass` |

`GET /api/v1/healthz` is **404 in partner-only mode**. Enabled/configured native service
returns 200 with `status:"ok"`, `factoryKeyTest` and `publicBaseURL` after checking the
native migration and all native persistence tables. `publicBaseURL` is the configured
canonical HTTPS origin used to sign passes' `webServiceURL`, not a client-supplied
Host/forwarding header. Release preflight must compare it to the iPhone's API origin.
Database/schema unavailability is 503 with the same fields and `status:"unavailable"`.
It exposes no private service origins, account/chip/device data, credentials or
certificate details. This is a safe release
preflight, not an assertion that the private SDM keys match a chip or APNs reached a
device; real hardware verification is still required.

Public cards contain exactly `id,cafeId,cafeName,stamps,target,rewardsAvailable,updatedAt`.
UUIDs in paths/request IDs are case-normalized for Swift's uppercase `UUID.uuidString`.
Errors retain `{error: "human-readable message"}`. Native JSON bodies are limited to
16 KiB, chip URLs to 4096 characters; Fastify performs parsing (no raw-stream adapter).
Bounded in-process rate limits apply to native routes, with tighter login/signup
limits. At scale, add a shared ingress limiter; client-supplied forwarding headers
are not trusted by the API.

Retain **one request UUID per chip read**, including retries across restarts. A repeated
customer/request ID returns the same event and current card without re-verifying
consumed data. Different ciphertext with that ID is 409. Customer row locks, global
chip row locks and database uniqueness constraints provide multi-process atomicity.
Invalid verification never advances a counter. Unknown chips need explicit linking.
A full card remains full until the next accepted stamp, then rolls over to 1;
completing each cycle adds one reward. Card/pass serials stay fixed across cycles.

Award/event/counter/card changes commit **before** pass signing. Publication failure
returns 503 explicitly saying the stamp was recorded. Retry the **same request**,
download the pass, or let the worker reconcile dirty cards; none awards twice.
Signing/publication locks the latest card and atomically saves bytes, revision and push
jobs. The worker starts with the server, retries every 15 seconds, and is awaited on
shutdown. Its bounded batches are safe across multiple instances.

### Apple Wallet protocol

`/wallet/v1` implements registration POST (201 new / 200 existing), unregister DELETE,
device change lists (200 or 204), pass downloads (200/304), and bounded diagnostic POSTs.
Registration changes/downloads require the immutable `ApplePass` authentication token
and exact Pass Type ID. Change queries follow Apple's device-identifier protocol.
Downloads support ETag and Last-Modified, including conditional requests. The global
durable change sequence also records same-balance republication (e.g. new public origin).
Change-tag allocation is serialized through transaction commit, so a device polling
several passes cannot advance past another publication that has not committed yet.
Diagnostic contents are discarded, not logged.

Device push-token rotation persists and queues a fresh delivery. Unchanged registration
does not create push loops. APNs uses the existing HTTP/2 certificate-based sender;
jobs survive restarts, use exponential retry, and invalid APNs device tokens remove
their registrations. APNs is only a signal to download current pass bytes, not a balance
payload. Retries/token updates cannot remove newer jobs.

Wallet requires the user's first Add confirmation. A stable HTTPS service origin is
essential: installed passes retain their old web-service URL. After an expired tunnel,
reissue and manually replace/add the pass against the new origin before relying on
future pushes. Neither this integration nor an APNs push redirects the old service URL.

## Safe legacy SQLite cutover

The original `api.mjs`, `store.mjs`, `wallet.mjs`, `support.mjs`, `server.mjs`,
`register-tag.mjs`, `setup-local.mjs` and `test/*.test.mjs` remain migration/reference
sources and regression coverage. **Do not run the legacy server as a second authority**
after cutover; PostgreSQL, not SQLite, backs the shared server.

An operator must stop legacy writers, retain a secure backup of **both**
`data/customers.sqlite` (including WAL state) and `data/passes/`, apply migration 0004,
then run against the intended destination using its explicit PG settings:

```sh
# Default is a full constraint-checked dry-run, rolled back.
npm run native:import -- --source /private/backup/customers.sqlite \
  --passes-dir /private/backup/passes
# Review count-only output and destination before explicitly applying.
npm run native:import -- --source /private/backup/customers.sqlite \
  --passes-dir /private/backup/passes --apply
```

The importer first copies the main database **and committed WAL**, if present, into a
mode-0700 ignored `.dev/native-import-snapshot-*` directory, with mode-0600 files.
It never opens the original with SQLite (even read-only SQLite can write a `-shm`
index). Only the private copy is opened read-only; the copy is removed on success or
failure. Source metadata changes during copying and pending rollback journals are
refused. This is not an online backup: all legacy writers must still remain stopped.
The original database, WAL and SHM bytes are left unchanged.

The importer reads that single read-only SQLite snapshot, locks all native destination
tables, and requires the **entire native domain to be empty**. Existing partner rows
are irrelevant and untouched. It refuses collisions/overwrite rather than guessing
how to merge customer identities or resetting replay counters. All inserts, sequence
restarts and validation happen in one PostgreSQL transaction (`MIGRATION_ROLE` uses
SET LOCAL ROLE here too). Dry-run validates signed pass file presence/bytes as well.
Missing/incomplete Wallet state or inconsistent card/event/counter state aborts
without partial writes. Output contains only counts and mode, not account/tag/device
data, source paths or credentials.

Preserved: IDs/usernames/salts/password hashes, session hashes and exact expiry times,
cafes, chip high-water marks, event sequence/request IDs/fingerprints, card stamps and
reward counts, stable pass serial/token/revision/bytes/base URL, device push tokens,
registrations and APNs generation/attempt/due state. New sequence values exceed old
event/change versions. On startup the worker re-signs only stale versions/origins,
retaining serial/auth tokens. A repeated import intentionally refuses a nonempty target.
Never serve both copies after importing; that would create two replay authorities.

For another explicitly provisioned hardware chip after cutover, use an existing native
test cafe UUID and an authoritative high-water counter (default `-1` is for a genuinely
unused chip only):

```sh
npm run native:link-tag -- CHIP_UID CAFE_UUID HIGH_WATER_COUNTER          # dry-run
npm run native:link-tag -- CHIP_UID CAFE_UUID HIGH_WATER_COUNTER --apply  # explicit
```

The command refuses reassignment or lowering an existing counter and does not seed a
partner business. Existing physical tags/cafe are normally supplied by the SQLite
import. Signing identities and chip keys are **never** imported.

## Local verification (never the shared Azure database)

Use an explicitly named, isolated PostgreSQL 17 container with loopback-only random
port; do not modify any existing SDM or unrelated container:

```sh
docker run --name joeyy-native-integration-pg \
  -e POSTGRES_USER=joeyy_native_test -e POSTGRES_PASSWORD=local-native-test-only \
  -e POSTGRES_DB=joeyy_native_test -p 127.0.0.1::5432 -d postgres:17
docker port joeyy-native-integration-pg 5432/tcp
```

Set `PGHOST=127.0.0.1`, that `PGPORT`, `PGDATABASE=joeyy_native_test`,
`PGUSER=joeyy_native_test`, `PGPASSWORD=local-native-test-only`, `PGSSLMODE=disable`;
environment variables override `.env`. Leave `AZURE_STORAGE_TEST_ACCOUNT` unset/empty.
Tests create/drop isolated schemas; they are still database writes, so do **not** rely
on schema isolation as permission to run against shared/customer data.

```sh
mkdir -p .dev/test-work
export TMPDIR="$PWD/.dev/test-work"
npm run typecheck
npm test
npm run test:legacy
```

To avoid loading an existing private `.env` at all, keep the same explicit local PG
overrides and run the existing Node test runner directly:

```sh
node --test --test-concurrency=1 'test/**/*.test.ts' 'test/*.test.mjs'
```

`test/native.test.ts` uses the real local PostgreSQL storage, injected nonsecret signing/
push/verifier fixtures, route contracts and retained SQLite source to prove import
preservation. It also generates disposable test-only certificates with the existing
`openssl` CLI, checks a real pass signature (`unzip`/`openssl`), and launches the actual
enabled server through HTTP and shutdown. Legacy verifier tests exercise a local HTTP
upstream. No normal tests need real customer data, chips, signing identities or APNs. The existing real Azure
image test is opt-in via `AZURE_STORAGE_TEST_ACCOUNT`; do not enable it for local checks.
`test/native-import-wal.test.ts` additionally imports uncheckpointed committed data
while hashing the source database/WAL/SHM before and after dry-run and apply.
