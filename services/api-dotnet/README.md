# services/api-dotnet: the ASP.NET version of the JOEYY api

This folder is a C# (ASP.NET Core, .NET 10) rewrite of the **native NFC/Wallet** part of `services/api/`. It answers
the same web addresses with the same responses, so the iPhone app, Apple Wallet, the verifier and the database
don't notice which one is running.

| Part | Node (`services/api/`) | ASP.NET (`services/api-dotnet/Joeyy.Api/`) |
|---|---|---|
| Routes `/api/v1/*`, `/wallet/v1/*` | `src/native/routes.ts` | `Native/NativeEndpoints.cs` |
| Customers, sessions, stamps | `src/native/store.ts` | `Native/NativeStore.cs` |
| Wallet publishing, pushes, worker | `src/native/wallet.ts`, `index.ts` | `Native/NativeWallet.cs`, `NativeServices.cs` |
| Pass drawing and signing | `wallet.mjs` (`renderPass`) | `Native/PassRenderer.cs` |
| Apple push (APNs) | `wallet.mjs` (`applePush`) | `Native/ApplePush.cs` |
| Chip check via the verifier | `support.mjs` (`verifyTag`) | `Native/VerifierClient.cs` |
| Settings | `src/native/config.ts` | `Native/NativeConfig.cs` (same variable names) |
| Database, migrations | `src/db.ts`, `src/migrate.ts` | `Infrastructure/Database.cs`, `Migrator.cs` |

**Not ported (still Node only):** the partner/business routes (`/v1/partner/*`), image uploads and OIDC sign-in.
The iPhone app does not use them yet.

The SQL migrations stay in `services/api/db/migrations/` and are shared. Add new numbered files there; never edit old ones.

## Run the tests

They need .NET 10 and a throwaway local PostgreSQL 17:

```sh
docker run -d --name joeyy-dotnet-pg -e POSTGRES_USER=joeyy -e POSTGRES_PASSWORD=joeyy -e POSTGRES_DB=joeyy \
  -p 127.0.0.1:55432:5432 postgres:17
cd services/api-dotnet && dotnet test
```

The tests refuse to run against anything except `localhost`, so they can never touch the Azure database.
GitHub Actions runs them on every change (`.github/workflows/api-dotnet.yml`).

## Migrations

```sh
cd services/api-dotnet
PGHOST=joeyy-dev-pg.postgres.database.azure.com PGDATABASE=<database> PGUSER=<your Entra login> \
AZURE_TOKEN_CREDENTIALS=dev MIGRATION_ROLE=joeyyadmin dotnet run --project Joeyy.Api -- migrate
```

## Deploying

`infra/deploy.sh` builds this folder (`joeyy-api-dotnet` image) and runs it as the `api` container of `joeyy-api`,
on the same address and database the Node backend used. Installed Wallet passes and the TestFlight app keep working.
Going back to Node is one command; see "Going back to the Node backend" in `infra/README.md`.

Never run two **NFC/Wallet-enabled** backends with different addresses on the same database: each one re-signs Wallet
passes with its own address, so they would overwrite each other's installed passes. (The shared Node API,
`joeyy-api-node`, has the NFC/Wallet part switched off, so it can share the database safely.)
