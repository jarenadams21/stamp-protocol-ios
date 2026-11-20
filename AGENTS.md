# AGENTS.md: Project context for AI coding sessions

Read this first. It describes the current state of JOEYY so a new session can continue without the earlier chat history. Keep it up to date when things change.

## What JOEYY is

JOEYY is a cafe loyalty app.
- A customer taps their iPhone on an **NTAG 424 DNA NFC chip** at the counter.
- The backend decrypts and verifies the tap, then awards a stamp.
- An **Apple Wallet** loyalty pass updates automatically.

The owner (Yesake, GitHub `Yesaket`) is not deeply technical. Explain things in plain language, keep answers short, and show steps.

## Repo layout (single repo: github.com/jarenadams21/stamp-protocol-ios)

- `JOEYY/`, `project.yml`, `JOEYY.xcodeproj`: SwiftUI iOS app. `project.yml` is the XcodeGen source; keep the build number in sync with the pbxproj.
- `backend/`: the "api" container: Node 24, TypeScript, Fastify.
  - Native NFC/Wallet code lives in `backend/src/native/` (`routes.ts`, `store.ts`, `wallet.ts`, `config.ts`, `index.ts`).
  - Chip verification adapter: `verifyTag` in `backend/support.mjs`.
  - Pass rendering and signing: `backend/wallet.mjs`.
- `backend/verifier/`: the "verifier" sidecar container.
  - Python `sdm-backend`, pinned commit 37585f0c, MIT licence.
  - Private, at `127.0.0.1:5005`, endpoint `GET /api/tagtt?picc_data=..&cmac=..`.
- `backend/db/migrations/`: numbered SQL files, 0001–0005. Add new files; never edit old ones.
- `infra/`: Azure Bicep and scripts.
  - `foundation.bicep`: one-time Owner setup.
  - `app.bicep`: Container App.
  - `dev.bicepparam`, `owner-setup.sh`, `deploy.sh`, `README.md`.
- `.github/workflows/`: Backend tests, plus `deploy-backend.yml` (auto-deploy).
- `docs/`: plain-English guides for the owner.
  - `azure-architecture.html`: interactive chart.
  - `azure-architecture-explained.md`: essay.
  - `how-to-update.md`: how to update the app, containers and database.
- `~/Projects/cafe-wallet-prototype` (outside the repo, older first prototype) holds the secrets. **Never print or commit these:**
  - Apple pass signing certs in `certs/`.
  - The chip key in `services/sdm/.env.sdm`.

## Current state (Nov 2026)

- Active branch: **`feature/azure-nfc-wallet`**, pushed to origin but **not merged to `main`**.
- The backend is **live on Azure (dev, not prod)**: https://joeyy-api.happycoast-32e2d60b.westus.azurecontainerapps.io (`/api/v1/healthz`).
  - Runs `NODE_ENV=development`, `AUTH_MODE=dev`, `NATIVE_PROTOTYPE_MODE=1` (anonymous guest cards, no accounts), and `NATIVE_NFC_KEY_MODE=factory-test` (the chip's default test key).
- **TestFlight build 4** points at the Azure URL. A real phone scan works: verified, counter 21, stamps saved in the Azure database.
- **Not yet confirmed:** that the Wallet pass updates itself on the next scan (7 → 8 stamps).
- **There is no prod environment yet.** Prod would need:
  - a separate resource group and database,
  - real per-cafe chip keys,
  - real sign-in,
  - prototype mode off (the code refuses prototype mode when `NODE_ENV=production`).

## Azure (subscription dbaa0ed1-cf1e-4e64-aa37-b20d3d74198c, tenant 939f4731-d4d0-4cc5-b75e-decd2df66d0a)

Resource group `joeyy-dev-rg` (westus). The Entra group `joeyy-devs` is Owner on it.

| Resource | Name |
|---|---|
| Container App (api + verifier, 1 replica) | `joeyy-api` |
| Container Apps environment | `joeyy-dev-env` |
| Container Registry | `joeyydevacrq6nfbh` |
| Key Vault (secrets: signer-cert, signer-key, wwdr-cert, sdm-master-key) | `joeyy-dev-kv-q6nfbh` |
| PostgreSQL Flexible Server (Entra auth only; delete lock) | `joeyy-dev-pg`, database `joeyyRewards` |
| Blob storage | `joeyydevimages` |
| Log Analytics | `joeyy-dev-logs` |
| Identity used by the app (also its Postgres login) | `joeyy-api-identity` |
| Identity used by GitHub OIDC (clientId 7351325d-f164-4335-aa96-d6260128bad9) | `joeyy-github-deployer` |

## How things flow

1. **Scan:** the app calls `POST /api/v1/taps` with the chip URL. The api calls the verifier (local HTTP) to decrypt and check the signature. The api checks that the counter is greater than the last counter (replay → 409; tamper → 422). One database transaction then adds the stamp, and the api replies to the app.
2. **Wallet update:** a 15-second worker (`scheduleNativeWorker`) rebuilds and signs the `.pkpass` and queues `native_wallet_jobs`. It sends an empty APNs push. Wallet then calls `/wallet/v1/devices/...` and `/wallet/v1/passes/...` to fetch the new pass.
3. **Deploy:** GitHub Actions runs tests, signs in to Azure with OIDC, runs `az acr build`, then updates the Container App.

## Common commands

- **Backend tests:** `cd backend && npm test`.
- **Deploy by hand:** `infra/deploy.sh` (needs a clean git tree). Add `--upload-secrets` to push certs and keys to Key Vault.
- **Database migrations** (manual, before deploying code that needs them): `cd backend && MIGRATION_ROLE=joeyyadmin npm run migrate`.
- **iOS TestFlight:**
  1. Bump `CURRENT_PROJECT_VERSION`.
  2. Archive: `node Tools/archive-live-tap.mjs <azure-url> --prototype`.
  3. Upload: `xcodebuild -exportArchive -archivePath .build/native-release/JOEYY.xcarchive -exportOptionsPlist .build/testflight/UploadOptions.plist -exportPath .build/testflight/out -allowProvisioningUpdates`.
- **Apple identifiers:** pass type `pass.com.cafewallet.prototype`; team `S23DT2V34P`.

## Gotchas

- The GitHub OIDC subject uses immutable IDs: `repo:jarenadams21@94200103/stamp-protocol-ios@1437938662:ref:refs/heads/main`. Do not add `environment:` to the deploy job, because it changes the subject.
- `.bicepparam` cannot be combined with `-f`. Deploy with `-p infra/dev.bicepparam` only.
- In bash, use `${VAR}…`, not `$VAR…`. A Unicode character right after a variable name causes unbound-variable errors.
- `native_events` has no `created_at`; order by `seq`. `native_cards` uses the columns `stamps` and `rewards`.
- Never print `.env` files, keys or certificates.

## Open to-dos

1. Confirm the Wallet card updates automatically after a scan.
2. The repo admin (Jaren) must add these GitHub Actions variables, then merge to `main` to switch on auto-deploy:
   - `AZURE_CLIENT_ID=7351325d-f164-4335-aa96-d6260128bad9`
   - `AZURE_TENANT_ID=939f4731-...`
   - `AZURE_SUBSCRIPTION_ID=dbaa0ed1-...`
3. Optional: the owner removes the temporary Postgres Entra admin `Yesaket2@gmail.com`. This needs the delete lock lifted briefly.
4. Optional: stop the old Mac-local tunnel, the local api and the local verifier containers. They are no longer needed.
5. Future work: real user accounts, a prod environment, real chip keys, and the Google Wallet equivalent for Android.
