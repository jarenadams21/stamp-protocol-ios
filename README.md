# JOEYY

JOEYY is a digital stamp-card loyalty program for local businesses. Customers collect stamps and
rewards from the places they visit; businesses design their card and see how often customers come
back. This monorepo holds every part of it.

| Part | Path | What it is |
| --- | --- | --- |
| iOS app | [`apps/ios`](apps/ios/README.md) | One SwiftUI app (iOS 18+) with both the **customer** side (cards, rewards, discovery) and the **business** side (card designer, overview, profile) |
| Web | [`apps/web`](apps/web/README.md) | The page a diner sees after tapping a JOEYY stand without the app (stamp card, rewards, Wallet pass, sign-in), plus a demo server with sample data |
| API | [`services/api`](services/api/README.md) | The shared backend (Node.js, Fastify, PostgreSQL, Azure Blob Storage) used by the apps |
| Docs | [`docs`](docs/README.md) | Backend specification, design system, architecture diagrams, and setup guides |

## Repository map

```
apps/
  ios/            Xcode project (generated from project.yml), JOEYY/{App,Customer,Business,Shared}, tests
  web/            Vite + TypeScript web page; server/ is the demo backend used in demo mode
services/
  api/            Shared API: src/, db/migrations/, scripts/, test/
docs/             backend-spec.md, design.md, architecture/, setup/
.github/workflows ios.yml, web.yml, api.yml, release.yml
```

## Run each part

**iOS app** (macOS with Xcode): open `apps/ios/JOEYY.xcodeproj`, choose the **JOEYY** scheme and an
iPhone simulator, and Run. No backend or credentials are needed; the app uses sample data. See
[apps/ios/README.md](apps/ios/README.md) for tests, sideloading, and launch arguments.

**Web** (Node 22):

```sh
cd apps/web
npm install
npm run dev        # demo mode with sample data
```

See [apps/web/README.md](apps/web/README.md) for demo and production builds.

**API** (Node 22.18+ and PostgreSQL 17):

```sh
cd services/api
cp .env.example .env
npm install
npm run migrate
npm run dev        # http://localhost:8080
```

See [services/api/README.md](services/api/README.md) for the Azure dev server, or
[docs/setup/dev-database.md](docs/setup/dev-database.md) to run everything on your Mac.

## Continuous integration

Each part has its own workflow, triggered only by changes under its folder:

| Workflow | Runs on changes to | Checks |
| --- | --- | --- |
| [`ios.yml`](.github/workflows/ios.yml) | `apps/ios/**` | Xcode project matches `project.yml`, build, unit tests; UI tests on pull requests into `main`, nightly, and manual runs |
| [`web.yml`](.github/workflows/web.yml) | `apps/web/**` | Type-check, demo and production builds |
| [`api.yml`](.github/workflows/api.yml) | `services/api/**` | Type-check, migrations on an empty Postgres, tests |
| [`release.yml`](.github/workflows/release.yml) | `v*` tags | Builds an unsigned IPA from `apps/ios` and publishes a prerelease for sideloading |

Keep `main` green; open a pull request for changes.
