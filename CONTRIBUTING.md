# Contributing

Thanks for your interest in improving PlaceMill. This document covers the minimum you need to build, test and submit changes.

## Development setup

- Windows 10/11 (the app uses the system WebView2 runtime)
- Node.js >= 18
- Rust stable ([rustup](https://rustup.rs); if a build fails after a toolchain update, run `rustup update` first)

```bash
npm install          # dependencies
npm run tauri dev    # dev run: Vite on port 1421 + the Rust app
npm run build        # frontend type-check + bundle (tsc + vite)
cargo check          # fastest backend feedback (in src-tauri/)
cargo test --lib     # Rust unit tests (in src-tauri/)
```

Note: `npm run dev` starts Vite only — all data actions fail without the Tauri IPC bridge.

## End-to-end suites

The e2e suites launch the real app (CDP-driven). **Run them one at a time** — every suite launches the app against the same SQLite file and they pollute each other when run in parallel.

```bash
npm run e2e:grid      # grid collection
npm run e2e:queue     # queue + crash-resume
npm run e2e:settings  # settings persistence
npm run e2e:browse    # paginated browsing
npm run e2e:real      # real Google search — network/account dependent
```

`e2e:real` actually searches Google; failures there are often consent pages, CAPTCHAs or network noise rather than regressions. Check the `tauri dev` log tail before assuming a code problem. The other suites use fake keywords and exercise state machines only.

## Invariants — read before changing core code

[`docs/architecture.md`](docs/architecture.md) lists the constraints that past bugs taught us (split-ratio constants duplicated in Rust and React, no `additional_browser_args` on the maps webview, the loose cell/radius grid contract, three dedupe layers, single writer for the collection switch). If your change touches webview creation, the split layout, the collection pipeline or the grid, please read it first. Parser changes are covered in [`docs/parser.md`](docs/parser.md).

## Commit style

- Conventional Commits, in English: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:` — imperative mood (`fix: clamp drift allowance to one viewport`, not `fixed`).
- One logical concern per commit; unrelated refactors belong in their own commit.
- Reference issues as `(#123)`.

## UI strings & localization

- All panel strings live in `src/i18n/en.ts` (the source dictionary) with `zh.ts` and `es.ts`. The `Dict` type enforces that the dictionaries stay aligned — if `tsc` fails after adding a key, add the missing translations.
- Do not hardcode user-visible strings in components.
- Docs in `docs/` are written in English.

## Reporting bugs

Please include what the **diagnostics drawer** shows (collector state, DB row count, recent errors) — it exists precisely to make reports actionable. Screenshots of the map pane state (consent page / CAPTCHA) help too.

## Pull requests

- Keep PRs small and focused on one concern.
- Make sure `npm run build` and `cargo check` pass before submitting.
- By opening a PR you agree your contribution is licensed under the project's [MIT License](LICENSE).
