# Run the API and a database on your Mac

This gets the shared API ([`services/api`](../../services/api/README.md)) and a Postgres database
running on your own Mac, so you can work on the app's account mode without Azure access. Everything
stays on your machine.

When you're done you'll have:

- The API at `http://localhost:8080`, with the same code and database tables as the Azure dev server.
- A development token and a test business created through the API.
- Logo and cover uploads working, with the images kept in a folder on your Mac.

To use the shared Azure dev server instead, follow [Run it locally](../../services/api/README.md#run-it-locally)
in the API README.

## How the pieces fit

```
JOEYY app (simulator)  ──HTTP──▶  API (Node.js)          ──▶  Postgres
  apps/ios/                         services/api/              tables from services/api/db/migrations
```

- **The API** is a small Node.js server in `services/api/`. The app never talks to the database
  directly; it calls the API's routes, and the API checks who's asking.
- **Your database** is built by the same migration files as the Azure one, so the tables match.
  It starts empty: there is no sample data in the API.
- **Images** go to Azure Blob Storage on the dev server. Locally, `IMAGE_STORE=local` keeps them in
  `services/api/.dev/images/`, and the routes behave the same.
- **Sign-in** uses `AUTH_MODE=dev`: the API signs tokens with a local key in `services/api/.dev/`,
  `npm run token` creates test tokens, and one-time sign-in codes are written to the API's log
  instead of being sent.

The full rules are in [docs/backend-spec.md](../backend-spec.md).

## 1. Install Node and Postgres

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

[Postgres.app](https://postgresapp.com) works too; create a database named `joeyy` in it.

## 2. Configure the API

Create `services/api/.env`. Git ignores this file, so it never gets committed.

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

Keep `PGPASSWORD` set. Local Postgres doesn't check it, but without it the API tries to sign in to
Azure instead and fails. `IMAGE_STORE=local` does the same job for images.

## 3. Create the database tables

```sh
cd services/api
npm install
npm run migrate
```

You should see one `applied …` line per file in `db/migrations`.

## 4. Start the API

```sh
npm run dev
```

Leave it running. In another terminal, check it's working:

```sh
curl localhost:8080/healthz      # {"status":"ok"}
```

## 5. Get a test token and create a business

```sh
npm run -s token -- partner my-test-owner
```

This prints a token for an owner called `my-test-owner`. It lasts 12 hours. Any other name gives a
different owner with no business yet. Create one:

```sh
TOKEN=$(npm run -s token -- partner my-test-owner)
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "Test Cafe", "location": "Seattle, WA", "timeZone": "America/Los_Angeles" }' \
  localhost:8080/v1/partner/business
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/partner/business
```

The second command should give Test Cafe back.

## 6. Point the app at it

The app reaches the API at `http://localhost:8080` by default, which the iOS Simulator maps to your
Mac. To use another address (for example your Mac's address from a phone), set the `apiBaseURL`
user default, such as the launch argument `-apiBaseURL http://192.168.1.20:8080` under
**Product > Scheme > Edit Scheme > Run > Arguments**.

Sign in from the person button with an email code; in dev mode the code appears in the API's log.

If iOS blocks a plain `http://` request (an App Transport Security error), allow local networking
(`NSAllowsLocalNetworking`) for debug builds in `apps/ios/project.yml`.

## Partner routes

Every partner request needs `Authorization: Bearer <token>`. The business is always taken from the
token, never from the request. Errors come back as `{ "error": "<code>", "message": "<text>" }`,
and the codes match the app's `PartnerError` cases (for example `nameTooLong`, `invalidTheme`,
`unchangedProgram`).

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
| `GET /v1/partner/notifications` | Newest first |

Sign-in routes are under `/v1/auth` and places search under `/v1/places`; see the
[API README](../../services/api/README.md).

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
   or `image/jpeg`. The limit is 5 MB.
2. Put the returned `key` in `logoKey` when saving the business, or in `theme.coverKey` when
   publishing. For the business, `logoKey: null` removes the logo and leaving `logoKey` out keeps it.
3. To show an image, download `logoURL` or `theme.coverURL` from a response. These links expire
   after 15 minutes.

A business has to exist before it can upload: save the business, upload the logo, then save again
with `logoKey`. Upload right before saving; uploads nothing uses are deleted after 24 hours, and a
save then returns `400 unknownImage`.

Dashboard times are UTC instants such as `2026-11-01T07:00:00Z`. Work out each period's start and
end in the business's time zone, then send them in UTC.

## If something goes wrong

| Problem | Fix |
| --- | --- |
| `createdb: command not found` | The PATH line in step 1 didn't take effect. Open a new terminal, or run `source ~/.zshrc` |
| `connection refused` on port 5432 | Postgres isn't running: `brew services start postgresql@17` |
| An error mentioning Azure, Entra or `DefaultAzureCredential` | `PGPASSWORD` is missing from `services/api/.env` |
| `role "…" does not exist` | `PGUSER` must be your Mac username (`whoami`) |
| `401 unauthorized` | The token expired (12 hours) or has a typo. Run step 5 again |
| `404 businessNotFound` | The owner has no business yet. Create one with `PUT /v1/partner/business` (step 5) |
| An error mentioning `AZURE_STORAGE_ACCOUNT` | `IMAGE_STORE=local` is missing from `services/api/.env` |
| `400 unknownImage` | The key isn't one this business uploaded, or a logo key was used as a cover (or the reverse). Upload again |
| An image link returns `403` | The link expired, or the API restarted. Fetch the business or card again for a fresh link |