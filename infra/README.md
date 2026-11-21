# Hosting the JOEYY backend on Azure

The backend runs in **Azure Container Apps**. Your Mac doesn't need to be on, and there's no temporary tunnel.

```text
GitHub (main) ──merge──► GitHub Actions ──► Azure Container Registry (packaged versions)
                                                    │
iPhone app / Apple Wallet ──HTTPS──►  Container App "joeyy-api"
                                      ├─ api       ASP.NET backend (public)
                                      └─ verifier  NFC decryption (private, 127.0.0.1 only)
                                           │            │               │
                                      Key Vault     PostgreSQL     Image storage
                                      (secrets)     (existing)     (existing)
```

| File | What it is | Who runs it |
|---|---|---|
| `backend-dotnet/Dockerfile` | Packages the ASP.NET backend (what runs) | Azure (during deploy) |
| `backend/Dockerfile` | Packages the older Node backend (kept for rollback) | Only when going back to Node |
| `backend/verifier/` | Packages the pinned SDM verifier (`nfc-developer/sdm-backend`, MIT) | Azure (during deploy) |
| `infra/foundation.bicep` + `owner-setup.sh` | One-time shared setup, including access rights | Subscription **Owner**, once |
| `infra/app.bicep` + `dev.bicepparam` | The running app and its settings | Anyone in `joeyy-devs`, or GitHub Actions |
| `infra/deploy.sh` | Builds the current commit in Azure, deploys it and waits for it to be healthy | Anyone in `joeyy-devs`, or GitHub Actions |
| `.github/workflows/deploy-backend.yml` | Deploys automatically after the Backend tests pass on `main` | GitHub |

## 1. One-time setup (subscription Owner)

```sh
az login --tenant 939f4731-d4d0-4cc5-b75e-decd2df66d0a
infra/owner-setup.sh
```

This does the following:
- Registers the Azure services the backend needs.
- Creates the registry, Key Vault, Container Apps environment and log workspace.
- Gives `joeyy-devs` deploy rights.
- Adds the backend's managed identity to `joeyy-devs`, so it can reach the database and image storage the same way a team member does.

Finally, the script prints three values to add to GitHub. Go to the repo → **Settings → Secrets and variables → Actions → Variables** and add them.

### Database login for the app

The app signs in to PostgreSQL as its own login, `joeyy-api-identity`, which is a member of the `joeyy-devs` role. A PostgreSQL Microsoft Entra admin creates this login once, connected to the `postgres` database:

```sql
SELECT * FROM pgaadauth_create_principal_with_oid('joeyy-api-identity', '<apiIdentityPrincipalId>', 'service', false, false);
GRANT "joeyy-devs" TO "joeyy-api-identity";
```

(Done for `joeyy-dev-pg` on 2026-11-19.)

## 2. First deploy (any `joeyy-devs` member)

The first deploy also uploads the Wallet signing files and the verifier key to Key Vault:

```sh
SIGNER_CERT_PATH=…/signerCert.pem SIGNER_KEY_PATH=…/signerKey.pem WWDR_CERT_PATH=…/wwdr.pem \
SDM_ENV_FILE=…/.env.sdm infra/deploy.sh --upload-secrets
```

The deploy prints the permanent address, for example `https://joeyy-api.<random>.westus.azurecontainerapps.io`. Archive the iPhone app against that address:

```sh
node Tools/archive-live-tap.mjs https://joeyy-api.….azurecontainerapps.io --prototype
```

## 3. Every change after that

Merge to `main`. GitHub Actions tests the change and then runs `infra/deploy.sh`. You can also run `infra/deploy.sh` yourself.

Database migrations remain a manual, reviewed step (from `backend/`, or the .NET equivalent in `backend-dotnet/README.md`):

```sh
MIGRATION_ROLE=joeyyadmin npm run migrate
```

## Going back to the Node backend

The api switched from Node to ASP.NET on 2026-11-20, on the same address and database. The last Node image is
`joeyy-api:72959913a272`. To put it back within a few minutes (no rebuild):

```sh
az containerapp update -g joeyy-dev-rg -n joeyy-api --container-name api \
  --image joeyydevacrq6nfbh.azurecr.io/joeyy-api:72959913a272
```

To make that permanent, set `apiImageName = 'joeyy-api'` in `dev.bicepparam` and build `backend` again in `deploy.sh`.

## Notes

- **Prototype settings**: anonymous scanning is on, and the chips use factory test keys.
  - Before real customers use it, set `prototypeMode = '0'` and `nfcKeyMode = 'provisioned'` in `dev.bicepparam`.
  - Then program the chips with real keys.
- **Wallet passes remember the server address they were created with.** If the address changes later (for example, to a custom domain), set `PUBLIC_BASE_URL` and re-add the passes.
- **Logs**: `az containerapp logs show -g joeyy-dev-rg -n joeyy-api --container api --tail 50`
- **Cost**: one always-on, small app (0.75 vCPU) plus a Basic registry. The app stays on because the Wallet update worker must keep running. Key Vault and logs cost only a few cents at this scale.
