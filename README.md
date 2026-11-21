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
.github/workflows ios.yml, web.yml, api.yml (pull request gate), post-merge.yml, release.yml
.github/scripts   UI test sharding, result classification, and the post-merge verdict and rollback
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

Pull requests pass a fast gate and merge; the full suite runs **after merge** on `main`, and a merge
that breaks it is reverted automatically.

**1. Pull request gate (about 8 minutes).** Each part runs only when its folder changes:

| Workflow | Runs on changes to | Checks |
| --- | --- | --- |
| [`ios.yml`](.github/workflows/ios.yml) | `apps/ios/**`, `.github/scripts/**` | Every UI test is in a shard; Xcode project matches `project.yml`; build and unit tests; in parallel, a build and the UI smoke tests ([`smoke.txt`](apps/ios/JOEYYUITests/smoke.txt)) |
| [`web.yml`](.github/workflows/web.yml) | `apps/web/**` | Type-check, demo and production builds |
| [`api.yml`](.github/workflows/api.yml) | `services/api/**` | Type-check, migrations on an empty Postgres, tests |

**2. Post-merge validation (about 15 minutes).** [`post-merge.yml`](.github/workflows/post-merge.yml)
runs on every push to `main`, one run per merge, never cancelled. The UI tests are split across four
parallel macOS jobs ([`shards.txt`](apps/ios/JOEYYUITests/shards.txt)), with unit tests, API, and web
checks for the parts the merge changed. A failing test is retried once: one that fails twice is
broken; one that passes on retry is reported as flaky.

- **Green:** the commit gets a `Post-merge validation` success status and the `verified` tag moves to it.
- **A test failed twice:** the job reverts the merge on `main` (`git revert -m 1`, no force push),
  comments on the pull request with the failed tests and the run, and opens or updates the
  "`main` was rolled back" issue. To reland, fix the test and open a new pull request.
- **Build, runner, simulator, or audit timeout (-56) errors:** an error status and a comment; nothing
  is reverted. Re-run the failed jobs.

It reverts only the merge it tested, and only if the commit before it passed (a failure inherited from
an earlier merge is left to that merge's rollback). If the revert conflicts with a later merge, or the
merge changed workflow files, it opens a "`main` needs attention" issue instead. Its own reverts are
pushed with the workflow token, so they don't start another run, and are never reverted.

**3. Quarantine.** Tests that already fail on `main` are listed in
[`quarantine.txt`](apps/ios/JOEYYUITests/quarantine.txt) and tracked in
[#9](https://github.com/jarenadams21/stamp-protocol-ios/issues/9). The gate and post-merge validation
skip them; the nightly run still runs them. Fix one, confirm it passes nightly, and remove it from both.

**4. Nightly (09:00 UTC).** The full suite on `main`, including quarantined tests, for trends and
flake data. It never reverts. **Run workflow** on Post-merge validation can also target another branch,
include quarantined tests, or roll back (off by default).

**5. Releases.** [`release.yml`](.github/workflows/release.yml) builds an unsigned IPA on `v*` tags,
and only from a commit with a passing post-merge validation (tag the `verified` commit).

Adding a UI test: put it in the shortest shard in `shards.txt`; the gate fails if a test is in no shard.
