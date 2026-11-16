# Running the JOEYY backend on your Mac (temporary)

This gets the backend and a database running on your own Mac, so you can connect the business
side of the app before the shared backend is online. You don't need Azure access. Everything here
stays on your machine, and nothing you do affects anyone else's data.

Setup takes about 15 minutes. When you're done you'll have:

- The backend at `http://localhost:8080`, with the same code and database tables as the Azure version.
- A test token to sign in with, and your own business created through the backend.
- Logo and cover photo uploads working, with the images kept in a folder on your Mac.

This file is temporary. Once the backend is hosted, the app will point there instead.

## What's going on

Until now, the business side of the app has saved everything on the phone (`PartnerStore` writes a
JSON file). The goal is for it to read and write through a shared backend instead, so the business
side and the customer side see the same data.

```
JOEYY app (simulator)  ──HTTP──▶  Backend (Node.js)  ──▶  Postgres database
  your Swift changes               backend/ in the repo     tables from backend/db/migrations
```

- **The backend** is a small Node.js server in `backend/`. The app never talks to the database
  directly. It calls the backend's routes (listed below), and the backend checks who's asking and
  reads or writes the database.
- **The real database** is on Azure and belongs to Omar. You don't need it: you run your own copy
  of the backend and your own Postgres, built by the same migration files, so the tables match exactly.
- **There is no sample data in the backend.** Your database starts empty, and you create a
  business through the routes below, the way the app will.
- **Images** go to Azure Blob Storage on the real backend. On your Mac, `IMAGE_STORE=local` keeps
  them in `backend/.dev/images/` instead, and the routes behave the same.
- **Signing in** isn't built yet. For now the backend runs in dev mode and accepts test tokens it
  creates itself. Each token says who you are, for example "the owner called `elshiekh-test`".
- **Your job** is the Swift side: teach the app to call these routes, as a second mode next to
  today's on-phone storage. See [Two modes](#two-modes-demo-and-account) below.

The routes, request shapes and error codes are listed under
[What you can build against](#what-you-can-build-against). The full rules are in
`docs/backend-spec.md`, and the overall plan is in the JOEYY Launch Plan doc.

## 1. Get the code

```sh
git fetch
git checkout omarukonneh/backendconnection   # or main, once it's merged
```

## 2. Install Node and Postgres

You need Node 22.18 or later and Postgres 17.

```sh
brew install node postgresql@17
echo 'export PATH="$(brew --prefix postgresql@17)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
brew services start postgresql@17
createdb joeyy
```

Check that both are installed:

```sh
node -v            # v22.18 or later
psql joeyy -c "select version();"
```

If you'd rather not use Homebrew, [Postgres.app](https://postgresapp.com) works too. Create a
database named `joeyy` in it.

## 3. Configure the backend

Create `backend/.env`. Git ignores this file, so it never gets committed.

```sh
PGHOST=localhost
PGPORT=5432
PGDATABASE=joeyy
PGUSER=<your Mac username, from: whoami>
PGPASSWORD=local
PGSSLMODE=disable
AUTH_MODE=dev
IMAGE_STORE=local
PORT=8080
```

Keep `PGPASSWORD` set. Local Postgres doesn't check it, but if it's missing the backend tries to
sign in to Azure instead and fails. `IMAGE_STORE=local` does the same job for images.

## 4. Create the database tables

```sh
cd backend
npm install
npm run migrate
```

You should see `applied 0001_initial_schema`, `applied 0002_align_with_backend_spec` and
`applied 0003_images`.

## 5. Start the backend

```sh
npm run dev
```

Leave it running. In another terminal, check it's working:

```sh
curl localhost:8080/healthz      # {"status":"ok"}
```

## 6. Get a test token and create a business

```sh
npm run -s token -- partner elshiekh-test
```

This prints a token that signs you in as an owner called `elshiekh-test`. It lasts 12 hours, so run
it again when it expires. Any other name gives you a different owner with no business yet.

A new owner has no business, so create one:

```sh
TOKEN=$(npm run -s token -- partner elshiekh-test)
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "Test Cafe", "location": "Seattle, WA", "timeZone": "America/Los_Angeles" }' \
  localhost:8080/v1/partner/business
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/partner/business
```

The second command should give Test Cafe back.

## 7. Point the app at it

The app doesn't read any backend settings yet; that's part of your first task (the shared API
client). Until sign-in exists, use two launch arguments, set in Xcode under **Product > Scheme > Edit
Scheme > Run > Arguments**. They only fill in account mode's address and token; they don't replace
the mode choice on the Welcome screen.

```
-api http://localhost:8080
-api-token <the token from step 6>
```

The iOS Simulator can reach your Mac at `localhost`. If iOS blocks the plain `http://` request
(an App Transport Security error), allow local networking (`NSAllowsLocalNetworking`) for debug
builds in `project.yml`.

## What you can build against

Every request needs `Authorization: Bearer <token>`. The business is always taken from the token,
never from the request. Errors come back as `{ "error": "<code>", "message": "<text>" }`, and the
codes match the app's `PartnerError` cases (for example `nameTooLong`, `invalidTheme`,
`unchangedProgram`). The full rules are in `docs/backend-spec.md`.

| Route | What it does |
| --- | --- |
| `GET /v1/partner/business` | Your business, or `404 businessNotFound` before setup |
| `PUT /v1/partner/business` | Create or update: `{ "name", "location", "timeZone", "logoKey" }` |
| `POST /v1/partner/images?kind=logo` (or `cover`) | Upload an image. Returns `{ "key", "url", … }` |
| `GET /v1/partner/program` | The live card, or `404 programNotFound` before the first publish |
| `GET /v1/partner/program/versions` | Every version, newest first, with usage (`live`, `finishing`, `retired`) |
| `GET /v1/partner/program/publish-impact` | `{ "keepRules", "switchToNew" }` for the publish confirmation |
| `POST /v1/partner/program/versions` | Publish: `{ "requiredPunches", "rewardDescription", "theme" }` |
| `GET /v1/partner/dashboard?from=&to=` | Overview counts. `to` is required, `from` is optional (leave it out for All) |
| `GET /v1/partner/notifications` | Newest first. Empty for now; real ones arrive with the customer routes |

A publish body looks like this. Colors are `#RRGGBB` text, while the app stores them as `UInt32`:

```json
{
  "requiredPunches": 10,
  "rewardDescription": "One handcrafted drink",
  "theme": {
    "lightPaper": "#F7EFD9", "lightInk": "#2F241E",
    "darkPaper": "#2F241E", "darkInk": "#F7EFD9",
    "typeface": "serif", "artwork": "cloud", "allowsMotion": true,
    "coverKey": null
  }
}
```

Images are uploaded first and attached second:

1. Send the image itself as the request body (not JSON, not a form), with `Content-Type: image/png`
   or `image/jpeg`. The app already makes logos PNG and covers JPEG, so send those bytes. The limit
   is 5 MB.
2. Put the `key` you get back in `logoKey` when saving the business, or in `theme.coverKey` when
   publishing. For the business, `logoKey: null` removes the logo and leaving `logoKey` out keeps it.
3. To show an image, download `logoURL` or `theme.coverURL` from a response. These links stop
   working after 15 minutes. `AsyncImage(url:)` is enough to start with.

**Where images live (spec section 3.2):** in account mode the real image is in Azure, and the app
saves only `logoKey` and `coverKey`. Don't put image bytes in the app's saved data. If you add a
cache later, put it in the Caches folder, file each image under its key (not its link, which changes
on every response), and clear it on sign-out. Demo mode keeps its `logoPNG` on the phone as today.

A business has to exist before it can upload. For a new owner, save the business first, upload the
logo, then save again with `logoKey`.

Upload right before saving. The backend deletes uploads that nothing uses after 24 hours, so a key
kept in a draft for days can stop working. If a save returns `400 unknownImage`, upload the image
again and save with the new key.

Dashboard times are UTC instants such as `2026-11-01T07:00:00Z`. Work out each period's start and
end in the business's time zone, then send them in UTC.

**Not available yet:** real sign-in, and anything on the customer side. The dashboard shows zeros
until customers and stamps exist.

## Two modes: demo and account

The app keeps its demo, next to the real backend, as two separate modes. The full rules are in
section 11 of `docs/backend-spec.md`.

```
                 Welcome screen
          ┌────────────┴────────────┐
   "Explore a demo"             "Sign in"
          │                         │
     Demo mode                 Account mode
   LocalPartnerDataSource     RemotePartnerDataSource
   (today's JSON file,        (the API client:
    Norema sample,             these routes, uploads,
    demo stamps)               the token)
```

- **Screens don't know the mode.** They call one `PartnerDataSource` interface, and the active mode
  supplies the implementation.
- **Demo data never reaches the backend.** A demo logo stays a PNG on the phone and is never
  uploaded. Backend data is never saved into the demo JSON file.
- **Each mode keeps its own data,** and switching modes doesn't delete or merge anything.
- **Demo mode shows a "Demo" badge.** Loading the Norema sample and other shortcuts appear only there.
- **UI tests run in demo mode,** so they need no backend.

## Your first three tasks

1. **Build the shared API client.** One Swift type that account mode uses to call the backend:
   base address and token, ISO 8601 dates, image uploads, and backend error codes turned into
   `PartnerError` messages. Jaren will reuse it for the customer side.
2. **Put a `PartnerDataSource` interface between the screens and their data, and make it async.**
   Today's JSON storage becomes `LocalPartnerDataSource` (demo mode) and the API client becomes
   `RemotePartnerDataSource` (account mode). Add the mode choice to the Welcome screen and the
   "Demo" badge. Screens get loading and error states.
3. **Connect the business screens to the routes above in account mode:** profile, publishing,
   version history, the publish confirmation, logo and cover uploads, and the Overview dashboard.

**Done when:**
- In account mode, you can set up a business with a logo, publish a card with a cover photo, and
  see both again after relaunching the app.
- Demo mode still works with the backend switched off.
- Switching modes leaves both sets of data as they were.

## If something goes wrong

| Problem | Fix |
| --- | --- |
| `createdb: command not found` | The PATH line in step 2 didn't take effect. Open a new terminal, or run `source ~/.zshrc` |
| `connection refused` on port 5432 | Postgres isn't running: `brew services start postgresql@17` |
| An error mentioning Azure, Entra or `DefaultAzureCredential` | `PGPASSWORD` is missing from `backend/.env` |
| `role "…" does not exist` | `PGUSER` must be your Mac username (`whoami`) |
| `401 unauthorized` | The token expired (12 hours) or has a typo. Run step 7 again |
| `404 businessNotFound` | You're signed in as an owner with no business. Create one with `PUT /v1/partner/business` (step 6) |
| An error mentioning `AZURE_STORAGE_ACCOUNT` | `IMAGE_STORE=local` is missing from `backend/.env` |
| `400 unknownImage` | The key isn't one this business uploaded, or a logo key was used as a cover (or the reverse). Upload again |
| An image link returns `403` | The link expired, or the backend restarted. Fetch the business or card again for a fresh link |

Questions about the backend: ask Omar.
