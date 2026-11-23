# Native NFC + Wallet (Node implementation)

This is the **customer NFC and Apple Wallet** part of the API: customer sessions, phone-read NTAG 424 DNA
verification, replay-safe stamps, and signed Wallet passes. It lives in `src/native/` (plus `support.mjs` and
`wallet.mjs`) and is switched on with `NATIVE_NFC_ENABLED=1`. The rest of the API is described in
[README.md](README.md).

> **What runs on Azure today:** since 2026-11-20 the live `joeyy-api` app runs the **ASP.NET port** of this code
> ([`../api-dotnet/`](../api-dotnet/README.md)), which answers the same routes the same way. This Node version is kept as
> the reference implementation, as the rollback option, and because its tests define the contract the port is checked
> against. Change both together.

## Migrations used by this part

| Migration | Purpose |
| --- | --- |
| `0004_native_nfc` | Customers, sessions, cafes, chips, cards, events and the Wallet tables (`native_*`) |
| `0005_native_prototype` | Explicit technical guest marker; existing credentials/imports default to ordinary accounts |

The shared sign-in migrations (`0004_sign_in`, `0006_account_email`) were written separately and happen to share
the `0004` number with `0004_native_nfc`. That is harmless: migrations are tracked by their **full name**, applied in
name order, and none depends on the other. The shared dev database already has all of them applied. Never rename or
edit an applied migration; give the next one a fresh number (`0007_…`).

Startup does **not** migrate, create cafes, seed chips, import customer data, or write Azure resources.

## Enable native NFC + Wallet

Default `NATIVE_NFC_ENABLED=0` leaves `/api/v1` and `/wallet/v1` absent and does not
require native secrets. Set **all** the following when opting in:

```dotenv
NATIVE_NFC_ENABLED=1
NATIVE_PROTOTYPE_MODE=0
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
Migration 0005 is required even in normal native account mode because authentication
checks the guest marker. Apply it explicitly with the existing migration runner/owner
role; startup never silently modifies the database.

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
Tapping outside the app opens that programmed hostname. Since the iOS app claims the chip
domain (Associated Domains) and the domain's web server vouches for it, iOS opens the app
instead and the app adds the stamp: see [docs/setup/tap-opens-app.md](../../docs/setup/tap-opens-app.md).

### Backwards-compatible native contract

All routes below are under `/api/v1`. Except health/accounts/sessions and anonymous
prototype-session creation, send
`Authorization: Bearer <native-session-token>`. Login remains username/password,
salted scrypt with hashed bearer sessions and the existing 30-day expiry.

| Method and route | Contract |
| --- | --- |
| `GET /healthz` | Public native readiness: `{status,factoryKeyTest,publicBaseURL,prototypeMode}` |
| `POST /prototype/session` | Prototype-only, no body; create/resume `{token,username,prototype:true}`; 200 |
| `POST /accounts` | `{username,password}` → `{token,username}`; 201 |
| `POST /sessions` | Same body/response; 200 |
| `DELETE /session` | Revoke this session; 204 |
| `GET /cards` | `{cards:[...]}` for only the signed-in customer |
| `POST /taps` | `{url,requestId}` → `{eventId,card,duplicate}` |
| `GET /cards/:id/pass` | Owner-authorized signed `.pkpass` |

`GET /api/v1/healthz` is **404 in partner-only mode**. Enabled/configured native service
returns 200 with `status:"ok"`, `factoryKeyTest`, `publicBaseURL` and `prototypeMode` after checking the
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

For normal credential accounts, award/event/counter/card changes commit **before** pass signing. Publication failure
returns 503 explicitly saying the stamp was recorded. Retry the **same request**,
download the pass, or let the worker reconcile dirty cards; none awards twice.
Signing/publication locks the latest card and atomically saves bytes, revision and push
jobs. The worker starts with the server, retries every 15 seconds, and is awaited on
shutdown. Its bounded batches are safe across multiple instances.

### Anonymous NFC-only prototype mode

Set **both** `NATIVE_NFC_ENABLED=1` and `NATIVE_PROTOTYPE_MODE=1` to exercise NFC
verification/card increments without signup or login. Prototype mode defaults off,
only accepts the literal flags `0`/`1`, and **refuses `NODE_ENV=production`**. Native
verifier and existing Wallet certificate configuration are still validated; this does
not add optional/unsigned Wallet configuration or bypass chip verification.

`POST /api/v1/prototype/session` exists only while prototype mode is enabled. Send
**no request body**. Without Authorization, it returns 200:

```json
{"token":"<opaque random bearer>","username":"nfc-<random identifier>","prototype":true}
```

The server creates a distinct `native_customers.is_prototype=true` **technical owner**
with random, unusable password fields and a hashed session. This is per-install card
and request ownership, **not customer identity**, account verification, a shared/global
card, or a secret embedded in the app. Ordinary `/accounts` and `/sessions` continue
to behave as before; guest rows cannot be signed into using passwords. Existing
credential accounts and SQLite imports remain `is_prototype=false`.

To resume, POST the same endpoint without a body and send
`Authorization: Bearer <retained guest token>`. A known guest session is renewed for
30 days **even if expired**, returning the exact same token and username. Existing
cards, event/request scope and pending retries are retained. Invalid, revoked,
malformed and ordinary-account tokens return 401; they never silently create another
identity. Logout revokes the token using the existing `DELETE /api/v1/session`.
When prototype mode is off, guest bearers are rejected by every normal authenticated
native route, even while their stored sessions are unexpired.

Guest `/taps` uses the same `{url,requestId}` body, real private `verifyTag` adapter,
global chip high-water checks and atomic request idempotency as normal accounts.
Successful guest responses add only:

```json
{"verification":{"verified":true,"counter":123}}
```

The normal `eventId,card,duplicate` fields remain. For an idempotent retry the metadata
counter comes from the **persisted original event**, while `card` is current. No
client-supplied UID/counter/verification metadata substitutes for cryptographic
verification. Reusing the ciphertext under another request UUID is still a replay.
The same chip gives each guest their own card, not their own replay authority.

Guest tap success is **independent of Wallet signing**: the route does not
synchronously publish/fetch a pass and a signing failure cannot hide a verified stamp.
The existing worker can publish dirty guest cards later, and an explicitly requested
owner-authorized pass download still uses the configured signer. Full-card retention,
rollover to 1 and accumulated test-reward counts are unchanged. Normal-account taps
retain their original response shape and post-commit Wallet-failure 503 behavior.
No prototype verification response claims a purchase or redeemable reward.

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
