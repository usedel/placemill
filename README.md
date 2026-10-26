# PlaceMill

[English](./README.md) | [简体中文](./README.zh-CN.md)

A Windows desktop tool that collects Google Maps business data (Tauri v2 + React 18 + Ant Design 5). The window is split in two: a control panel on the left, a real, embedded `google.com/maps` page on the right whose search responses are intercepted by an injected script. Given a keyword, a center point and a radius, it walks a grid of map cells automatically; results land in a local SQLite database and export to CSV/Excel.

## Features

- **Area collection** — give it a keyword, a center point and a radius: it walks a grid of map cells automatically, and densely covered cells split themselves into quadrants for full coverage.
- **Job queue** — queue many keywords at once; jobs run sequentially and survive app restarts (finished cells are never re-run). Dead pages such as consent screens or CAPTCHAs pause the job instead of burning requests.
- **Data management** — filter by name/rating/contact/type, SQL-backed pagination that stays fast at 100k+ rows, one-click Excel/CSV export.
- **Email & social mining** — visit a business website and its contact pages to extract emails and social links (optional, off by default).
- **Observability** — a diagnostics drawer with live collector state, row counts, query P95 and recent errors.
- **Local-first** — everything is stored in a local SQLite file; nothing leaves the machine.

## How it works

1. The app embeds a real Google Maps page in a child webview and injects a script (`src-tauri/scripts/intercept.js`) on every page load.
2. The script patches `fetch`/`XMLHttpRequest`, filters business-search responses, and parses Google's positional JSON payload (field indices are overridable at runtime via a signed remote config).
3. Batches cross into Rust, pass an ingress guard (row limits, NUL-byte stripping, clamping) and a rate window, are deduplicated in memory and in SQLite (`UNIQUE(place_id)`), filtered against the job's radius, then attributed to the running job/tile.
4. Deduplication exists at three layers — script per batch, Rust + SQLite, UI view state — each covering a different failure mode.

## Requirements

- Windows 10/11 (uses the system WebView2 runtime; Win11 ships with it)
- Node.js >= 18 and Rust stable (for building from source)
- A network environment where Google Maps is reachable — the app embeds the real `maps.google.com` page

## Install

1. Download `PlaceMill_<version>_x64-setup.exe` from the [latest release](https://github.com/usedel/placemill/releases/latest) and run it — no toolchain required.
2. First launch may trigger a SmartScreen prompt for an unsigned binary: choose *More info → Run anyway*. (Authenticode signing is on the roadmap; until then every build is unsigned.)
3. The window opens split: control panel left, Google Maps right.

The app updates itself from these releases, so you never have to download an installer by hand twice. Building from source is only needed for development — see [Development](#development).

## First run

1. Sign in to your Google account inside the embedded map page, like you would in a normal browser.
2. If a cookie-consent page appears, complete it manually before collecting.
3. Click *New task* at the top of the panel, fill in a keyword and a radius, and start; the header shows *Collecting* plus the elapsed time.

## Collection

Every collection run is a task. Click *New task* in the panel:

| Field | Meaning |
|---|---|
| Keywords | One job per keyword; multiple supported |
| Center | Defaults to the current map center, or enter coordinates |
| Radius / cell | Bigger radius or smaller cells = more cells (cap 200); the dialog estimates count and duration live |
| Split threshold | A cell reaching this many results (default 100) splits into 4 smaller cells, up to 3 levels deep |

Jobs enter a queue and run one at a time — pause/resume/cancel/delete at will. **Don't touch the map pane while a job runs**, or you'll interfere with the active cell.

## Where is my data

- Local SQLite: `%APPDATA%\com.placemill.app\placemill.db`
- Exports: default directory configurable in settings, filename template supports `{date}`
- *Clear data* removes business rows but keeps job records; the diagnostics drawer shows the exact DB path.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A job runs but no new rows arrive | The panel raises a warning card once a task has made no progress for 90 seconds — usually the map is stuck on a consent page / CAPTCHA / expired login. Handle it on the right pane, then use *Reload map* or *Restart collection* on the card |
| A grid job pauses itself | The dead-page watchdog fired: several consecutive cells got no data (usually a consent/CAPTCHA page). Clear the page and resume |
| Some cells show failed | Cells retry twice automatically; failed jobs can restart from the queue without re-running finished cells |
| Duplicate rows | Shouldn't happen (three dedupe layers). If it does, please open an issue with the diagnostics drawer's error info |

## Legal

This tool automates your own normal browsing of Google Maps in your own browser session. It is **not affiliated with, endorsed by, or connected to Google in any way**. "Google Maps" is a trademark of Google LLC — used here only to describe what the tool interacts with. You are responsible for complying with Google's Terms of Service, controlling collection rate and scale, and using collected data lawfully.

## Development

```bash
npm install          # dependencies
npm run tauri dev    # dev run (Vite on 1421 + Rust app)
npm run build        # frontend type-check + bundle
cargo test --lib     # Rust unit tests (in src-tauri/)
```

End-to-end suites are CDP-driven against a real app launch (they back up and restore the DB temporarily):

```bash
npm run e2e:settings   # settings persistence
npm run e2e:grid       # grid collection
npm run e2e:queue      # queue + resume
npm run e2e:tasks      # task views
npm run e2e:browse     # paginated browsing
npm run e2e:interceptor
npm run e2e:emails
npm run e2e:real       # real Google search (network-dependent)
```

`e2e:real` really searches Google; failures there are usually network/account/consent-page noise, not code regressions. The other suites use fake keywords and only exercise state machines.

### Packaging

```bash
npm run build:release   # NSIS installer (default)
npm run build:msi       # MSI
npm run build:clean     # clean + rebuild
```

or `.\build.ps1` (`-Dev`, `-Clean`, `-Target msi|all`).

### Signing & releases (auto-update)

The app checks updates via `tauri-plugin-updater` against a static `latest.json` on GitHub Releases (endpoint in `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`). Publishing is automated by [`.github/workflows/release.yml`](.github/workflows/release.yml): it runs on every `v*` tag and attaches the NSIS installer plus `latest.json` to a new Release.

One-time repository setup:

1. Generate a signing key (the private key never goes into the repo):

   ```bash
   npm run signer:generate -- -w %USERPROFILE%\.tauri\placemill.key
   ```

2. Put the printed public key into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

3. Store the private key as repository secrets — `TAURI_SIGNING_PRIVATE_KEY` (the full file contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (only if you set one):

   *Settings → Secrets and variables → Actions → New repository secret*

Cutting a release:

1. Bump `version` in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`.
2. Commit, then tag and push: `git tag v0.1.1 && git push origin v0.1.1`.
3. CI builds the installer, writes `latest.json` and publishes the Release; running apps pick it up on the next update check. The workflow refuses to build when the tag and the version disagree.

To exercise the updater locally, build signed by hand:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\placemill.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<password>"   # only if set
.\build.ps1
```

`scripts/release-latest-json.mjs` produces `latest.json` next to the bundle.

4. Sign the remote parser config (when changing `parser-config.json`): the client only accepts configs with a valid `parser-config.json.sig` against the built-in public key; unsigned or tampered configs are dropped (fail closed) and the built-in field map applies.

   ```powershell
   node scripts/sign-parser-config.mjs D:\path\to\parser-config.json
   ```

   Upload `parser-config.json` **and** `parser-config.json.sig` together to the `usedel.github.io/placemill-config` Pages site — JSON alone makes clients reject the config until the signature arrives.

### Project structure

```
placemill/
├── src/                       # React frontend
│   ├── App.tsx                # main UI + data orchestration (server-side pagination)
│   ├── components/            # header, metrics, filters, job queue, drawers, split handle
│   ├── settings/ i18n/ types/ # preferences, localization (en/zh, es scaffold), types
├── src-tauri/                 # Rust backend
│   ├── src/
│   │   ├── lib.rs             # app entry, dual-webview layout, shared state
│   │   ├── commands.rs        # Tauri commands (query, export, job queue, diagnostics)
│   │   ├── collector.rs       # job worker (single-flight, retries, dead-page watchdog)
│   │   ├── grid.rs            # grid generation + adaptive quadtree geometry
│   │   ├── db.rs              # SQLite (business + job tables + migrations)
│   │   ├── email_miner.rs     # website/contact-page email & social extraction
│   │   └── remote_config.rs   # signed remote field-map config
│   ├── scripts/
│   │   └── intercept.js       # Google Maps injection script
│   └── tauri.conf.json        # window, CSP, updater, bundle config
├── scripts/e2e/               # CDP-driven end-to-end suites
├── skills/placemill-leads/    # MCP server / Agent Skill (read-only local leads DB)
├── docs/                      # technical documentation (English)
└── build.ps1                  # packaging script (NSIS / MSI)
```

### Technical notes

- [`docs/architecture.md`](docs/architecture.md) — the dual-webview architecture, data flow, job/grid model and the invariants you must not break when contributing.
- [`docs/parser.md`](docs/parser.md) — how the interception and parsing layer works, the field-index map and how to maintain it when Google changes its payload.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — build/test workflow, commit conventions and PR guidelines.
- [`skills/placemill-leads/SKILL.md`](skills/placemill-leads/SKILL.md) — query the local leads DB from Claude Desktop / CodeBuddy / Cursor via MCP.

## License

[MIT](LICENSE) © 2026 Placemill contributors
