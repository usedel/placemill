# Architecture

PlaceMill is a Tauri v2 desktop app. A single window hosts **two webviews** with two isolated JavaScript contexts, and every feature is built around that fact. Read this before changing webview creation, the split layout, or the collection pipeline.

## Two webviews, two isolated JS contexts

`src-tauri/src/lib.rs::run()` creates a window named `main` containing the React panel webview (also named `main`), then attaches a **child webview** named `maps` pointing at `https://www.google.com/maps`.

Consequences that shape most of the code:

- The two webviews are separate renderers. The injected script cannot touch React state; React cannot read the Maps DOM. Everything crosses Tauri IPC: the script emits `business-data`, and Rust drives the Maps page through `eval()`.
- Child webviews do **not** resize with their parent. `WindowEvent::Resized` re-applies the split, the window opens maximized, and a 400 ms delayed `apply_split` compensates for the maximized size arriving asynchronously. Keep this pattern when touching webview creation.
- `additional_browser_args()` must **not** be added to the `maps` webview: WebView2 shares a user-data folder and rejects a webview whose environment args differ — the result is a permanently blank Maps pane.
- `tauri` is built with `features = ["tray-icon", "unstable"]`; `unstable` is required for `WebviewBuilder` / `add_child`.

## Split layout is owned by Rust, mirrored in React

The split ratio is the **panel's share** of the window width, clamped to `[0.26, 0.80]`, default `0.46`. The constants exist twice — `DEFAULT/MIN/MAX_SPLIT_RATIO` in `lib.rs` and `DEFAULT/MIN/MAX_SPLIT` in `split_ratio` / `SplitHandle.tsx`. **Change both or the handle and the geometry disagree.**

`SplitHandle` drags by `screenX` (tracking survives the webview being resized under the pointer), throttles `set_split_ratio` through `requestAnimationFrame`, and persists the ratio only when the gesture ends. `set_map_collapsed` collapses the maps pane to 1 px; that state is independent of the ratio.

## Data flow

1. `src-tauri/scripts/intercept.js` is injected into the `maps` webview via `initialization_script` on **every** document load. It is embedded at compile time with `include_str!` — editing the file alone does nothing; rebuild (`npm run tauri dev` recompiles Rust). Rust prefixes `window.__PLACE_MILL_DEBUG__ = <bool>` (true only in debug builds) to gate debug helpers (`__placemillDiag`, `__placemillTest`).
2. The script monkey-patches `fetch` and `XMLHttpRequest` (through `Object.defineProperty`, so Maps cannot undo the patch) and filters responses matching `/search?tbm=map/i`.
3. Three payload shapes are handled in order: wrapper `{"c":0,"d":"<escaped json>"}`, raw XSSI `)]}'\n[[...]]`, and a legacy regex fallback. See [`parser.md`](parser.md) for the parsing details.
4. With the collector switch on, the script emits `business-data` batches (~20 rows) via `window.__TAURI__.event.emit`, buffering into `PENDING` if the IPC bridge is not ready yet.
5. `lib.rs` receives `business-data` and runs the **ingress guard**: row cap (≤ 500), text fields clamped and stripped of NUL bytes, list fields capped, non-finite numbers zeroed — and only then is `place_id` judged, so a NUL byte in the id costs the byte, not the business. A 10 s rate window (200 batches / 5000 rows) throttles floods.
6. `store_businesses` refuses batches unless a collecting session is active (`state.listening`, or the 3 s `switch_off_at` grace for in-flight batches), dedupes in memory by `place_id`, upserts into SQLite (`INSERT OR IGNORE`, or `ON CONFLICT DO UPDATE` when `duplicateStrategy == "update"`), attributes rows to the running job/tile, **drops rows outside the job's radius** (`grid::within_radius`; unattributed batches have no circle and skip the check), then emits `businesses:updated` and `collector:batch`.
7. `src/App.tsx` subscribes to `businesses:updated`, `listening:changed`, `collector:batch`, `jobs:progress`, `email:*`, `maps:health` and others, and dedupes by `place_id` through `seenRef` (bounded to 5000 ids; it only drives the "N new" pill — the real dedupe is Rust + SQLite).

Deduplication therefore exists at **three layers** (script per batch, Rust `HashSet` + `UNIQUE(place_id)`, React `seenRef`), each covering a different failure mode. Keep all three.

## Collector switch and navigation

Collection is task-driven: the switch is on exactly while a runner is working.

- `state.listening` is the authority; `commands::apply_listening` is its **only writer**. It evals the page flag + a `localStorage` mirror + `__placemillAutoScroll.stop()` + `__placemillSetTileContext(null)`, updates state, stamps the `switch_off_at` grace, and emits `listening:changed`.
- The **worker owns the end of the session** (`collector::spawn_runner`): it turns the switch off on its single exit path and re-arms it when chaining to the next queued job — after the status flip, so a cancel racing the queue cannot leave it on. `start_job` turns it on for the first job. `pause_job` / `cancel_job` still flip it off immediately; the worker guarantees it cannot leak back on.
- Every document boots from Rust, not from the mirror: `collector_settings_script` appends `window.__placemillEnabled = <state>` to the settings push on page load. There is **no boot-time auto-resume** in the injected script.
- `clear_data` pauses a running job first, then turns the switch off, then clears — otherwise the next navigation would re-arm collection into the emptied table.
- `navigate_maps` is refused while a task runs, and `update_settings` refuses a map language/region change for the same reason (`map_busy`): it would reload the pane mid-tile.

## Jobs and the grid

A *job* is one keyword over a rectangular grid. `plan_grid` splits the radius into `cellKm` tiles and caps the count; `create_jobs` stores the **effective** `cell_km` returned by `grid::generate`.

- The cell/radius contract is deliberately loose: `steps = ceil(radius / cell)` and a cell is kept when its centre is within `radius + cell/2`. **Do not "fix" this by shrinking the cell to the radius** — that widens gaps to 1.5× the viewport and leaves bands of the circle uncollected. The grid's job is *coverage*; the *range* is enforced at write time by `store_businesses` + `grid::within_radius`, because Google's feed keeps loading results further away as the page scrolls.
- `zoom_for_cell` **floors** instead of rounding: a viewport may be wider than its cell but never narrower.
- Auto-scroll is bounded from two sides, both handed over in the tile context (`__placemillGoto(url, {jobId, tileId, lat, lng, maxScrolls, maxDriftKm})`): `max_scrolls_for_radius` caps the budget by job radius (always ≥ 6, the ~120-place feed cap), and the page compares the URL camera with the cell centre every round — drifting beyond one viewport width stops the cell with reason `drift`. There is deliberately **no** "stop when results stop being local" rule: Google's feed is relevance-ordered and local rows are interleaved across the whole window. The scroll itself is deliberately human-like (60–90 % of viewport with randomness) — do not turn it into jump-to-bottom.
- `wait_for_idle` accepts `idle` / `max-scrolls` / `no-results` / `drift`.
- Tile context `{jobId, tileId}` travels in `sessionStorage`: `__placemillGoto` stores it before navigating. **Attribution is decided in Rust** (`collector::attribute_batch`: active tile + runner slot must both agree); the payload's own `jobId` is ignored, because that context outlives the job that wrote it.
- Adaptive splitting counts rows **after** every filter (`collector::count_tile_rows`, called from `store_businesses`), not before — otherwise feed rows outside the radius inflate the count and cells quadruple into ground they were never asked to cover.
- `start_job` / `resume_job` / `pause_job` / `cancel_job` are a small state machine (`queued → running → paused → running → done`, plus `cancelled` / `failed`); only one job may be `running` at a time. The runner lives in `collector.rs` on a dedicated connection thread and navigates the `maps` webview tile by tile through `eval`.

## Storage, exports, updates

- SQLite at `%APPDATA%\com.placemill.app\placemill.db`: `businesses` (`place_id UNIQUE`), job/tile tables, settings (single JSON row), plus migrations.
- Exports stream from Rust (CSV / Excel) — the panel never holds the full table; browsing is server-side paginated.
- Auto-update via `tauri-plugin-updater` against a static `latest.json` on GitHub Releases; binaries are minisign-signed. The remote parser field map (`remote_config.rs`) is a separate minisign-verified config served from GitHub Pages — unsigned or tampered configs are rejected (fail closed) and the built-in field map applies. See [`parser.md`](parser.md).
