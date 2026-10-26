# The interception & parsing layer

How `src-tauri/scripts/intercept.js` captures Google Maps business data, and how to maintain it when Google changes its payload.

## Injection

- The script is injected via Tauri's `initialization_script` on **every** document load of the `maps` webview, and embedded at compile time with `include_str!` — **editing the file alone does nothing**; rebuild so Rust picks it up.
- Rust prefixes the script with `window.__PLACE_MILL_DEBUG__ = <bool>`, true only in debug builds. Debug helpers (`__placemillDiag`, `__placemillTest`) are defined only when it is set — they can write rows into SQLite from the page, so release builds must not define them at all.
- The script tags itself `window.__placemillInjected = true` to avoid double-injection side effects.

## Patching

- `fetch` and `XMLHttpRequest` are monkey-patched **through `Object.defineProperty`**, so Maps cannot overwrite the patch. Originals are preserved under `window.__placemillOriginalOpen/Send/SetRequestHeader`.
- Only responses matching `/search?tbm=map/i` are parsed; everything else passes through untouched.

## Three parse paths

Handled in order, first match wins:

1. **Wrapper format** — `{"c":0,"d":"<escaped json>",...}`: unescape `d` and parse again.
2. **Raw XSSI format** — `)]}'\n[[...]]`: strip the prefix bytes and parse the array.
3. **Legacy regex fallback** — for shapes neither of the above matches.

**Every `JSON.parse` is preceded by `sanitizeJsonText`.** A raw control byte (a NUL in particular) inside a JSON string is invalid, so `JSON.parse` throws and the **whole response is lost** — one byte, zero rows. The bytes are removed before parsing; escaped ones survive as real NULs inside values and are stripped later by the Rust ingress guard.

## The payload

Google returns a positional (protobuf-ish) JSON array. The result list lives at `data[64]`; each entry is a `detail` array read at fixed indices:

| Field | Index |
|---|---|
| Name | `detail[11]` |
| Address | `detail[39]` (fallback `detail[18]`, prefix-stripped) |
| Phone | `detail[178]` |
| Website | `detail[7]` |
| Types | `detail[13]` (lowercased, underscores → spaces) |
| Coordinates | `detail[9][2]` / `detail[9][3]` |
| Place id | `detail[78] \|\| detail[10]` |

Helpers `hStr` / `hNum` / `hPhone` / `hWebsite` / `hTypes` coerce the loose values. **These indices are the fragile core** — when Google changes the layout, this is the file to fix.

## Field map & remote override

- The built-in indices live in `BUILTIN_FIELD_MAP` (in `intercept.js`) — it is the only list to touch; the optional keys are derived from it.
- `src-tauri/src/remote_config.rs` can override a few indices at runtime from `https://usedel.github.io/placemill-config/stable/parser-config.json`. The config is a **minisign-signed** JSON (`parser-config.json.sig` sidecar); the signature is verified against the built-in `CONFIG_PUBKEY`, the on-disk cache is re-verified on every read, and unsigned or tampered configs are rejected (fail closed) — the built-in map applies instead. Sign updates with `node scripts/sign-parser-config.mjs <file>` and upload both files together.
- A field is **optional** in the remote map: a missing or invalid key drops only itself (the built-in value applies via `resolveIndex`). The nine core keys stay required — their absence means the layout really changed, so the whole map is rejected and the app falls back to the built-in one.
- `window.__placemillFieldMapStatus()` reports `map` (what the config said) and `effective` (what the parser actually uses).
- `window.__placemillIndexProbe(detail?)` (debug builds only) reports the shape at every candidate path — use it to pick an index instead of guessing. It only reads; its snapshot never reaches `business-data`.

## Cross-checking indices

The index table has been cross-checked against the open-source [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) (MIT), which reads the same Google positional arrays from a different payload shape. When a field breaks, comparing its `darray` indices in that project is the fastest way to find the new position here.

## Emitting

- Parsed rows are batched (~20) and emitted as `business-data` via `window.__TAURI__.event.emit`; if the IPC bridge is not ready, batches buffer in `PENDING` and flush on a timer.
- Each batch may carry tile context written by `__placemillGoto` (via `sessionStorage`); **attribution to the running job/tile is decided in Rust** (`collector::attribute_batch`), never from the payload.
- Scroll idle state is broadcast as `collector:scroll-idle`; the Rust scheduler uses it to decide a tile is finished (`wait_for_idle` accepts `idle` / `max-scrolls` / `no-results` / `drift`).

## Maintenance recipe

1. Reproduce with a real search in `tauri dev` (debug build).
2. Run `__placemillIndexProbe()` from the Maps page console and read the shape at each candidate path.
3. Fix `parseWrapperFormat` / `parseRawFormat` / `extractBusinesses` / the `h*` helpers — or ship a signed remote `parser-config.json` if only indices moved.
4. Cross-check against gosom's `darray` indices.
5. Verify with `npm run e2e:interceptor` and a real `e2e:real` run.
