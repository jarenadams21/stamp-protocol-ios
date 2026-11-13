# Native customer + NFC + Wallet vertical slice

This is a runnable backend for the app's live **Tap** experience. It does not
replace the existing local demo screens or implement the entire partner MVP.
Node 24+, the private upstream SDM verifier, and an Apple Pass Type ID signing
identity are required.

The verifier is
[`nfc-developer/sdm-backend`](https://github.com/nfc-developer/sdm-backend),
pinned for this prototype to commit
`37585f0c76eded73798b936b17aa5e187075b78f`. It is an independent private service,
not part of the Node server. This Mac already has its Docker deployment;
another machine needs that service and matching tag-key/legacy-derivation
configuration before NFC verification can work.

## What is real

- Username/password customer accounts, salted scrypt password hashes, hashed
  bearer sessions with 30-day expiry, and server-side logout.
- Each customer has their **own** card for a cafe, not a shared tag card.
- The phone reads an NTAG 424 DNA NDEF URL; this service sends its original
  ciphertext/CMAC to the private upstream `/api/tagtt` verifier.
- Atomic per-chip replay counters, stable request/event IDs, safe retries,
  enrollment, stamp balances, full-card rollover, and earned-reward counts.
- Signed personal `.pkpass` files, immutable per-pass authentication tokens,
  Wallet registration/download/change endpoints, and persistent APNs retry jobs.
- Native PassKit can replace the installed pass after a scan; APNs updates other
  registered copies without needing the app open.

**This is a real-hardware prototype, not a production rewards system.** The
current local verifier uses the explicitly selected zero master. Zero-key
messages are forgeable; they must not authorize valuable rewards. Accounts are
username/password accounts, not verified email identities. Account recovery,
production identity-provider integration, merchant authorization/redemption,
full program-version publishing, audit/retention policies, and operational
hardening are not implemented. A verified tag read does not prove a purchase.

## Local setup

1. Keep the SDM Docker verifier running on `127.0.0.1:5005`. Use the same master
   as the programmed chips; never change only the service's key and expect old
   tags to keep working.
2. In `backend`, run `npm ci`.
3. Copy `.env.example` to ignored `.env` and set your stable public HTTPS
   origin, Pass Type ID, Team ID, and absolute paths to the certificate,
   matching private key, and WWDR intermediate. Signing files stay **outside
   this repository**.
4. Link a verified tag UID to the test cafe:

   ```sh
   node register-tag.mjs YOUR_14_HEX_CHARACTER_UID
   ```

   On this Mac, the already observed physical tags were imported with:

   ```sh
   node register-tag.mjs --import-prototype /path/to/cafe-wallet-prototype/data/cards/nfc.sqlite
   ```

   This copies identities and high-water counters, not signing keys, master
   keys, customer accounts, or shared-card balances. Repeat imports do not reset
   native counters. The new service's replay database is separate from the old
   shared website demo: use the **native scanner** for this flow, not both
   services as interchangeable authorities for real rewards.
5. Run `npm start`. The API listens only on `127.0.0.1:3002` by default.
   Expose port 3002 through HTTPS; do not expose the SDM verifier.

For this existing Mac prototype, `node setup-local.mjs https://YOUR-HOST
/path/to/cafe-wallet-prototype` generates ignored `.env` and
`../Config/Local.xcconfig`, referencing existing signing files without copying
them. It refuses to overwrite existing files. The app config contains only the
API URL and signing team. Both outputs are private local configuration.

`Config/App.xcconfig` includes optional `Config/Local.xcconfig`. Set
`LOYALTY_API_BASE_URL` and `DEVELOPMENT_TEAM` locally, then regenerate the project
with the repository's XcodeGen workflow when build configuration changes.
An xcconfig HTTPS value needs slash escaping, e.g.
`LOYALTY_API_BASE_URL = https:/$()/api.example.com`.

The temporary URL on this Mac is available in ignored `Config/Local.xcconfig`;
do not treat that hostname as permanent hosting. The Mac, Node API, SDM service,
and tunnel must stay running.

## Trying it on a physical iPhone

1. Run the app with your signing team and NFC/Wallet capabilities provisioned.
2. Open **Tap**, create your own account, and sign in.
3. Start the scan and hold the iPhone near a linked chip. Allow Apple's NFC
   scan UI to read it.
4. The server verifies the dynamic message, enrolls your personal card, and
   awards one stamp. Confirm Add once if the app presents the new Wallet pass.
5. Scan again. The app shows the server's new balance and replaces that same
   installed pass. APNs also signals registered devices; delivery can be delayed.
6. Retry a failed request using the retry action, not a newly invented request
   ID. It finishes the original award without awarding twice.
7. Sign in as a different customer: their card starts independently. A copied
   previously consumed NFC URL must not award either account another stamp.

Foreground Core NFC reads the URL **from the chip**, not from its web server.
An old programmed hostname can therefore still work in the scanner: it is
the encrypted query data that the verifier needs. You do not need to reprogram
the existing test chips just to use this foreground app flow. Tapping the chip
outside the app still follows its programmed website URL. Universal Links and
background-notification routing are not part of this first implementation.

Wallet requires the user's first Add confirmation. It is not possible to install
a new card silently. Updating an existing issuer-authorized pass is separate:
the app can replace it while active, with APNs as the server-driven path.

## API

All customer routes are under `/api/v1`. Except signup/login, use
`Authorization: Bearer <token>`. Tokens/passwords must never be logged.

| Method and route | Behavior |
| --- | --- |
| `POST /accounts` | `{username,password}` -> `{token,username}`; 201 |
| `POST /sessions` | Same body/response for login; 200 |
| `DELETE /session` | Revoke this bearer session; 204 |
| `GET /cards` | `{cards:[...]}`, restricted to authenticated customer |
| `POST /taps` | `{url,requestId}` -> `{eventId,card,duplicate}` |
| `GET /cards/:id/pass` | Authenticated `.pkpass` download for the owner |

`requestId` is a UUID generated **once per read**, retained during retries.
Reusing it with different URL data returns 409. Counter replay checking is
global per chip, not per account. A retry of an already accepted request returns
the same event ID and current authoritative card without re-verifying consumed
data. Invalid signatures do not advance counters. Unknown UIDs require explicit
operator linking.

The tap transaction records the counter, event, enrollment, balance, and
earned-reward count together. Pass generation happens after commit: if it fails,
503 explicitly reports that the stamp was recorded. Retrying the same request,
downloading the pass, or restarting the API republishes current state without
another award.

A full card remains full until the next accepted stamp, which starts the next
cycle at 1. Completing each cycle earns one reward. The per-customer/cafe Wallet
serial remains stable across cycles. Reward redemption is not implemented here;
earned counts are demonstrations and not redeemable.

Apple's endpoints are served under `/wallet/v1`, with `ApplePass` authorization
on registration changes and pass downloads. The device identifier authorizes
change-list queries as Apple's protocol specifies. Device logs are bounded and
their contents are not copied into server logs.

## Persistence and operations

`backend/data/customers.sqlite` and `backend/data/passes/` are ignored, private,
and persistent. Back them up **together**. The database contains password
hashes, session hashes, chip counters, customer cards, pass authentication
tokens, device registrations, and pending pushes. Do not delete it to work
around replay checks or rotate pass tokens after installation.

Rate limits apply to all requests and more tightly to signup/login.
`TRUST_CLOUDFLARE=1` trusts the Cloudflare client-IP header only for a loopback
connection from the local tunnel; leave it off for other proxy configurations.
No access logs include URLs, bearer tokens, raw NFC parameters, or private keys.

Use permanent HTTPS hosting before relying on Wallet updates. Installed passes
remember their web-service URL. An expired quick tunnel requires manually
adding the reissued pass after changing the service's public origin.

`npm test` exercises accounts, customer isolation, repeated/concurrent request
handling, global replay rejection, invalid verification, rollover, publication
retry, Wallet authorization, conditional downloads, persistence, and APNs retry
behavior without needing real signing credentials or sending real pushes.
