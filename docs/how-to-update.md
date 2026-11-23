# How to Update JOEYY

## Where the code lives

There is **one GitHub repo** for everything: `github.com/jarenadams21/stamp-protocol-ios`.
On your Mac it's at `~/Projects/stamp-protocol-ios`.

| Folder | What it is |
|---|---|
| `apps/ios/` | The Swift iPhone app (`JOEYY/`, `project.yml`, `JOEYY.xcodeproj`); the NFC "Tap" tab is in `JOEYY/Customer/Tap/` |
| `apps/web/` | The web page a diner sees (the team's web work) |
| `services/api-dotnet/` | The NFC and Wallet api container (ASP.NET, C#): what runs as `joeyy-api` |
| `services/api/` | The shared Node api (sign-in, places, partner); also the Node version of the NFC code |
| `services/verifier/` | The verifier container (Python) |
| `services/api/db/migrations/` | Database changes (SQL files), shared by every service |
| `infra/` | Azure setup and deploy scripts |
| `.github/workflows/` | GitHub's robot (tests, auto-deploy, and the automatic undo of broken merges) |
| `docs/` | These guides and the architecture chart |

`~/Projects/cafe-wallet-prototype` is the **old first prototype**. It still holds the signing certificates (`certs/`) and the chip key file. Keep it safe, but no new code goes there.

---

## 1. Updating the Swift app

1. Change the code in `apps/ios/JOEYY/`. Run the next steps from the `apps/ios` folder.
2. Raise the **build number** (`CURRENT_PROJECT_VERSION`) in `project.yml`, then run `xcodegen generate` so `JOEYY.xcodeproj` matches. TestFlight refuses a build number it has seen before.
3. Build and archive:
   `node Tools/archive-live-tap.mjs https://joeyy-api.happycoast-32e2d60b.westus.azurecontainerapps.io --prototype`
4. Upload to TestFlight:
   `xcodebuild -exportArchive -archivePath .build/native-release/JOEYY.xcarchive -exportOptionsPlist .build/testflight/UploadOptions.plist -exportPath .build/testflight/out -allowProvisioningUpdates`
5. Wait for Apple to process it, then install it from the TestFlight app on the phone.
6. Commit and push.

For the App Store, the same build goes through App Store Connect review.

## 2. Updating the containers (backend)

**Automatic (once switched on):**
1. Change code in `services/api-dotnet/` or `services/verifier/`.
2. Open a pull request and merge it to `main`.
3. GitHub runs the tests, logs into Azure (no password), builds new images, and tells the Container App to switch over. The new version only receives traffic once it is healthy.

This needs three GitHub repo variables to be added first by the repo admin: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`.

**By hand (what we do today):**
1. Commit your changes. The script refuses to deploy uncommitted code.
2. Run `infra/deploy.sh`.
3. If certificates or the chip key changed, run `infra/deploy.sh --upload-secrets` instead.

Both containers are always deployed together as one unit. (The shared Node api, `joeyy-api-node`, is a separate app that the team deploys on its own.)

## 3. Updating the database

Database changes are **never automatic**. This is on purpose, because a bad change can damage real data.

1. Add a new numbered SQL file, for example `services/api/db/migrations/0007_add_rewards.sql` (the next free number). Never edit an old file.
2. Test it locally with `npm test` in `services/api/` and `dotnet test` in `services/api-dotnet/`.
3. Apply it to Azure from `services/api/`, signed in as an admin:
   `MIGRATION_ROLE=joeyyadmin npm run migrate`
4. Then deploy the containers that use the change.

The database remembers which files it has already run, in a table called `schema_migrations`, so each file runs only once.

**Order matters:** database first, then containers. The app checks on start-up that the migrations it needs are there. If they aren't, it refuses to start, and the old version keeps running.
