# AGENTS.md: Project context for AI coding sessions

Read this first. It describes the current state of JOEYY so a new session can continue without the earlier chat history. Keep it up to date when things change.

## What JOEYY is

JOEYY is a cafe loyalty app.
- A customer taps their iPhone on an **NTAG 424 DNA NFC chip** at the counter.
- The backend decrypts and verifies the tap, then awards a stamp.
- An **Apple Wallet** loyalty pass updates automatically.

The owner (Yesake, GitHub `Yesaket`) is not deeply technical. Explain things in plain language, keep answers short, and show steps.

## Repo layout (monorepo: github.com/jarenadams21/stamp-protocol-ios)

- `apps/ios/`: SwiftUI iOS app. `project.yml` is the XcodeGen source; **`JOEYY.xcodeproj` must equal `xcodegen generate`** (CI checks), and the build number lives in `project.yml` (`CURRENT_PROJECT_VERSION`, currently 4).
  - Source folders: `JOEYY/{App,Customer,Business,Shared}`. The **Tap tab** (NFC + Wallet) is in `JOEYY/Customer/Tap/`.
  - The app talks to **two services**: `JOEYY_API_BASE_URL` → the shared Node API (`joeyy-api-node`: sign-in, places, partner); `LOYALTY_API_BASE_URL` (in `Config/App.xcconfig`, overridden by the git-ignored `Config/Local.xcconfig`) → the NFC/Wallet api (`joeyy-api`).
  - Release tooling: `Tools/archive-live-tap.mjs` (+ `check-native-service.mjs`) and `Config/`. Run them from `apps/ios`.
  - Every UI test must be listed in exactly one shard in `JOEYYUITests/shards.txt` (`node .github/scripts/ui-tests.mjs check`).
- `apps/web/`: Vite web page for diners (teammates' work).
- `services/api/`: the shared **Node** API (Fastify, TypeScript): sign-in (Apple, Google, one-time codes), places, partner routes, images.
  - It also holds the **Node reference implementation of NFC/Wallet** in `src/native/` (plus `support.mjs`, `wallet.mjs`). Docs: `native-nfc.md`.
  - `db/migrations/` is the **single source of SQL** for every service. Add new numbered files (next is `0007_…`); never edit or rename an applied one.
- `services/api-dotnet/`: the **ASP.NET Core (.NET 10) NFC/Wallet api**. This is what `infra/deploy.sh` deploys as `joeyy-api` (image `joeyy-api-dotnet`).
  - Same routes, responses, env vars and SQL as the Node `src/native`; 31 xUnit tests; it was checked against Node with a 47-request side-by-side comparison.
  - Not ported (Node only): sign-in, partner routes, images. See `services/api-dotnet/README.md`.
  - Build context is the repo root (`-f services/api-dotnet/Dockerfile .`).
  - Local .NET 10 SDK is in `~/.dotnet` (set `DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH`). Test Postgres: Docker `joeyy-dotnet-pg` on 127.0.0.1:55432.
- `services/verifier/`: the "verifier" sidecar container.
  - Python `sdm-backend`, pinned commit 37585f0c, MIT licence.
  - Private, at `127.0.0.1:5005`, endpoint `GET /api/tagtt?picc_data=..&cmac=..`.
- `infra/`: Azure Bicep and scripts.
  - `foundation.bicep`: one-time Owner setup.
  - `app.bicep`: Container App (`apiImageName` picks the Node or .NET image; `dev.bicepparam` sets .NET).
  - `dev.bicepparam`, `owner-setup.sh`, `deploy.sh`, `README.md`. Rollback to Node: `infra/README.md` → "Going back to the Node backend" (last Node NFC image `joeyy-api:72959913a272`).
- `.github/workflows/`: `ios.yml`, `web.yml`, `api.yml` (pull request gates), `post-merge.yml` (full tests after every merge, **auto-reverts a merge** whose unit, API or web tests fail), `api-dotnet.yml`, `release.yml`, `deploy-backend.yml` (auto-deploy of the .NET api; inactive until the `AZURE_*` variables exist).
- `docs/`: `README.md` is the index. For the owner: plain-English guides.
  - `azure-architecture.html`: interactive chart with two tabs: "Azure tour" (whole system) and "ASP.NET & containers" (inside the api container, Dockerfile, settings, deploy steps, known limits). Keep both in step with the code; it is the owner's main reference for how the flow works.
  - `azure-architecture-explained.md`: essay. `how-to-update.md`: how to update the app, containers and database.
- `~/Projects/cafe-wallet-prototype` (outside the repo, older first prototype) holds the secrets. **Never print or commit these:**
  - Apple pass signing certs in `certs/`.
  - The chip key in `services/sdm/.env.sdm`.

## Current state (Nov 2026)

- **Branches:** `main` has the monorepo layout, real sign-in and the shared Node API, but **not** the NFC/Wallet work. `feature/merge-main-nfc-dotnet` integrates the Azure NFC/Wallet work and the ASP.NET api onto that layout, with every gate green locally; it supersedes `feature/azure-nfc-wallet` and `feature/dotnet-backend` (PR #8), which should not be merged separately.
- The NFC/Wallet api is **live on Azure (dev, not prod)**: https://joeyy-api.happycoast-32e2d60b.westus.azurecontainerapps.io (`/api/v1/healthz`).
  - Since 2026-11-20 it runs the **ASP.NET** version (image `joeyy-api-dotnet:1811da01447b`). `NODE_ENV=development`, `NATIVE_PROTOTYPE_MODE=1` (anonymous guest cards: **each phone has its own card**), `NATIVE_NFC_KEY_MODE=factory-test` (the chip's default test key).
- **TestFlight build 4** points at that URL. Confirmed on a phone: scans verify (read counter rises), stamps save, and the Wallet pass updates itself.
- **A second app, `joeyy-api-node`**, runs the shared Node API (sign-in etc.), `AUTH_MODE=live`, `TRUST_PROXY=1`, scales to zero. Same environment, registry, identity and **database** as `joeyy-api`. It has the NFC/Wallet part switched off, so it never re-signs Wallet passes.
- **Database `joeyyRewards`** has migrations `0001`–`0003`, `0004_native_nfc`, `0005_native_prototype`, `0004_sign_in`, `0006_account_email` applied. The two `0004`s are harmless: migrations are tracked by full name.
- **Not integrated yet:** the Tap tab's guest sessions are separate from the real sign-in (Apple/Google/code) that `main` added. Linking taps to a signed-in account is the next product step.
- **There is no prod environment yet.** Prod would need:
  - a separate resource group and database,
  - real per-cafe chip keys,
  - real sign-in for taps,
  - prototype mode off (the code refuses prototype mode when `NODE_ENV=production`).

## Azure (subscription dbaa0ed1-cf1e-4e64-aa37-b20d3d74198c, tenant 939f4731-d4d0-4cc5-b75e-decd2df66d0a)

Resource group `joeyy-dev-rg` (westus). The Entra group `joeyy-devs` is Owner on it.

| Resource | Name |
|---|---|
| Container App: NFC/Wallet api (ASP.NET) + verifier, 1 replica | `joeyy-api` |
| Container App: shared Node API, scales to zero | `joeyy-api-node` |
| Container Apps environment | `joeyy-dev-env` |
| Container Registry | `joeyydevacrq6nfbh` |
| Key Vault (secrets: signer-cert, signer-key, wwdr-cert, sdm-master-key) | `joeyy-dev-kv-q6nfbh` |
| PostgreSQL Flexible Server (Entra auth only; delete lock) | `joeyy-dev-pg`, database `joeyyRewards` |
| Blob storage | `joeyydevimages` |
| Log Analytics | `joeyy-dev-logs` |
| Identity used by the apps (also their Postgres login) | `joeyy-api-identity` |
| Identity used by GitHub OIDC (clientId 7351325d-f164-4335-aa96-d6260128bad9) | `joeyy-github-deployer` |

## How things flow

1. **Scan:** the app calls `POST /api/v1/taps` with the chip URL. The api calls the verifier (local HTTP) to decrypt and check the signature. The api checks that the counter is greater than the last counter (replay → 409; tamper → 422). One database transaction then adds the stamp, and the api replies to the app.
2. **Wallet update:** a 15-second worker rebuilds and signs the `.pkpass` and queues `native_wallet_jobs`. It sends an empty APNs push. Wallet then calls `/wallet/v1/devices/...` and `/wallet/v1/passes/...` to fetch the new pass.
3. **Deploy:** `infra/deploy.sh` (by hand, or via `deploy-backend.yml` once enabled) signs in to Azure, runs `az acr build`, then updates the Container App.

## Common commands

- **Node API tests:** `cd services/api && npm test` (needs Node 22.18+, local PostgreSQL via `PGHOST=127.0.0.1 …`, `openssl`, `unzip`).
- **ASP.NET tests:** `cd services/api-dotnet && dotnet test` (needs the throwaway local Postgres, see its README).
- **Deploy by hand:** `infra/deploy.sh` (needs a clean git tree). Add `--upload-secrets` to push certs and keys to Key Vault.
- **Database migrations** (manual, before deploying code that needs them): `cd services/api && MIGRATION_ROLE=joeyyadmin npm run migrate`.
- **iOS TestFlight** (from `apps/ios`):
  1. Bump `CURRENT_PROJECT_VERSION` in `project.yml`, then `xcodegen generate`.
  2. Archive: `node Tools/archive-live-tap.mjs <azure-url> --prototype`.
  3. Upload: `xcodebuild -exportArchive -archivePath .build/native-release/JOEYY.xcarchive -exportOptionsPlist .build/testflight/UploadOptions.plist -exportPath .build/testflight/out -allowProvisioningUpdates`.
- **Apple identifiers:** pass type `pass.com.cafewallet.prototype`; team `S23DT2V34P`.

## Gotchas

- **A merge to `main` that breaks unit, API or web tests is reverted automatically** (`post-merge.yml`). Run the gates locally first. A UI test that fails twice only notifies.
- The GitHub OIDC subject uses immutable IDs: `repo:jarenadams21@94200103/stamp-protocol-ios@1437938662:ref:refs/heads/main`. Do not add `environment:` to the deploy job, because it changes the subject.
- `.bicepparam` cannot be combined with `-f`. Deploy with `-p infra/dev.bicepparam` only.
- Never run two **NFC/Wallet-enabled** backends with different addresses on one database: each re-signs Wallet passes to its own address.
- In bash, use `${VAR}…`, not `$VAR…`. A Unicode character right after a variable name causes unbound-variable errors.
- `native_events` has no `created_at`; order by `seq`. `native_cards` uses the columns `stamps` and `rewards`.
- Azure Container Registry's Dockerfile scanner rejects `FROM --platform=$BUILDPLATFORM`. On an Apple Silicon Mac, build the .NET image without `--platform` (.NET crashes under amd64 emulation).
- Never print `.env` files, keys or certificates.

## Open to-dos

1. The repo admin (Jaren) must add these GitHub Actions variables to switch on auto-deploy of the .NET api (after the merge to `main`):
   - `AZURE_CLIENT_ID=7351325d-f164-4335-aa96-d6260128bad9`
   - `AZURE_TENANT_ID=939f4731-...`
   - `AZURE_SUBSCRIPTION_ID=dbaa0ed1-...`
2. Link NFC taps to the real sign-in: let a signed-in user own the card, and let a guest card be claimed by an account without losing stamps.
3. The .NET api's rate limits count the connection address; behind Azure's front door that is probably the proxy, so all phones may share one limit. The Node API has `TRUST_PROXY` for this; the .NET api does not yet read forwarded headers. Not yet checked.
4. Optional: the owner removes the temporary Postgres Entra admin `Yesaket2@gmail.com`. This needs the delete lock lifted briefly.
5. Optional: stop the old Mac-local tunnel, the local api and the local verifier containers. They are no longer needed.
6. Future work: a prod environment, real chip keys, "tap opens the app / background tag reading" (needs a permanent chip domain, an apple-app-site-association file and an Associated Domains entitlement), and the Google Wallet equivalent for Android.
