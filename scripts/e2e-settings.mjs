#!/usr/bin/env node
/**
 * End-to-end acceptance for the settings feature.
 *
 * Drives the *real* app over the WebView2 DevTools protocol instead of mocking
 * the Tauri bridge:
 *
 *   1. starts `npm run tauri dev` with --remote-debugging-port
 *   2. attaches to both webviews (React panel + embedded Google Maps)
 *   3. calls the real commands (`update_settings`, `set_split_ratio`, ...) and
 *      asserts on real DOM state
 *   4. kills and relaunches the app to prove the values survive a restart
 *   5. restores the settings that were on disk before the run
 *
 * Requirements: Windows, WebView2, and a machine where a GUI window may open.
 * The script needs ports 1421 (Vite) and 9222 (CDP) to be free.
 *
 * Usage: npm run e2e:settings
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createWriteStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_PORT = 1421;
const CDP_PORT = 9222;
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const DEV_LOG = join(tmpdir(), 'placemill-e2e-dev.log');
const LAUNCH_TIMEOUT_MS = 180_000;

const PERSISTED_KEYS = [
  'theme',
  'language',
  'pageSize',
  'scrollMinMs',
  'scrollMaxMs',
  'maxScrolls',
  'stopAfterIdle',
  'jitter',
  'onlyWithPhone',
  'logLevel',
  'defaultExportFormat',
  'exportPreset',
  'csvBom',
  'fileNameTemplate',
  'duplicateStrategy',
  // UI-04: the column-visibility list must survive a restart just like the
  // scalar settings — the picker reads it straight back on the next launch.
  'hiddenColumns',
];

let failures = 0;
let child = null;
let stopping = false;
let devLogTail = [];

/** Original settings, captured before the first mutation. */
let original = null;
/** Distinctive settings written at the end of phase 1, verified after restart. */
let expected = null;

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures += 1;
};

const note = (message) => console.log(`INFO  ${message}`);

// ---------------------------------------------------------------------------
// Process handling
// ---------------------------------------------------------------------------

function probe(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Vite may bind `[::1]` only; probe both stacks before claiming the port is free. */
async function portIsOpen(port) {
  if (await probe(port, '127.0.0.1')) return true;
  return probe(port, '::1');
}

async function preflight() {
  if (process.platform !== 'win32') {
    throw new Error('this harness relies on WebView2 CDP and only runs on Windows');
  }
  if (await portIsOpen(DEV_PORT)) {
    throw new Error(
      `port ${DEV_PORT} is busy: stop the running "tauri dev" first, otherwise Vite ` +
        `binds another port while the app still loads ${DEV_PORT}`,
    );
  }
  if (await portIsOpen(CDP_PORT)) {
    throw new Error(`port ${CDP_PORT} is busy: another debug session is running`);
  }
}

async function launchApp() {
  const log = createWriteStream(DEV_LOG, { flags: 'w' });
  devLogTail = [];
  const remember = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      devLogTail.push(line);
      if (devLogTail.length > 40) devLogTail.shift();
    }
  };

  stopping = false;
  // A single command string (instead of args + shell) keeps Node from warning
  // about unescaped arguments; the string is a constant, nothing is injected.
  child = spawn('npm run tauri dev', {
    cwd: REPO_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });

  child.stdout.on('data', (chunk) => {
    log.write(chunk);
    remember(chunk);
  });
  child.stderr.on('data', (chunk) => {
    log.write(chunk);
    remember(chunk);
  });
  child.on('exit', (code) => {
    // `taskkill` makes npm exit non-zero on purpose; only unexpected exits matter.
    if (code !== 0 && code !== null && !stopping) note(`dev process exited with code ${code}`);
  });

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CDP_BASE}/json/list`);
      const targets = await res.json();
      if (targets.some((t) => t.type === 'page' && /localhost:142\d/.test(t.url || ''))) return;
    } catch {
      /* CDP not up yet */
    }
    await sleep(500);
  }
  throw new Error('app did not expose a panel target in time');
}

async function stopApp() {
  if (!child) return;
  stopping = true;
  const pid = child.pid;
  child = null;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    killer.once('exit', resolve);
    killer.once('error', resolve);
  });
  // Give WebView2 a moment to release the user data folder before relaunching.
  await sleep(3000);
}

function dumpDevLog() {
  if (!devLogTail.length) return;
  console.log('\n--- tauri dev output (tail) ---');
  for (const line of devLogTail) console.log(line);
  console.log(`--- full log: ${DEV_LOG} ---\n`);
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

async function listTargets() {
  const res = await fetch(`${CDP_BASE}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list returned ${res.status}`);
  return res.json();
}

const isPanelTarget = (target) =>
  target.type === 'page' && /localhost:142\d/.test(target.url || '');
const isMapsTarget = (target) => target.type === 'page' && /google\.com/.test(target.url || '');

async function waitForPanelTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    try {
      seen = await listTargets();
      const panel = seen.find(isPanelTarget);
      if (panel) return panel;
    } catch {
      /* ignore */
    }
    await sleep(500);
  }
  throw new Error(`no panel target. saw: ${JSON.stringify(seen.map((t) => t.url))}`);
}

async function waitForMapsTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    try {
      seen = await listTargets();
      const maps = seen.find(isMapsTarget);
      if (maps) return maps;
    } catch {
      /* ignore */
    }
    await sleep(500);
  }
  throw new Error(`no maps target. saw: ${JSON.stringify(seen.map((t) => t.url))}`);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('CDP websocket failed to open'));
  });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  return { send, close: () => ws.close() };
}

async function evalIn(conn, expression) {
  const message = await conn.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = message.result;
  if (result?.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(String(description).split('\n')[0]);
  }
  return result?.result?.value;
}

async function waitFor(conn, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evalIn(conn, expression)) return;
    } catch {
      /* context not ready yet */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label || expression}`);
}

/** `invoke` bound to a page, so tests read like the app's own code. */
function api(conn) {
  return (command, args = {}) =>
    evalIn(
      conn,
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
    );
}

async function openPanel() {
  const target = await waitForPanelTarget(LAUNCH_TIMEOUT_MS);
  const panel = await connect(target.webSocketDebuggerUrl);
  await waitFor(panel, 'typeof window.__TAURI_INTERNALS__ === "object"', 60_000, 'tauri ipc');
  await waitFor(panel, 'document.querySelector(".app-shell") !== null', 90_000, 'react mount');
  return panel;
}

// ---------------------------------------------------------------------------
// Phase 1: behaviour while the app is running
// ---------------------------------------------------------------------------

async function phaseBehaviour() {
  const panel = await openPanel();
  const call = api(panel);

  await waitFor(panel, 'typeof window.__PLACE_MILL_SETTINGS__ === "object"', 30_000, 'bootstrap');
  const boot = JSON.parse(await evalIn(panel, 'JSON.stringify(window.__PLACE_MILL_SETTINGS__)'));
  check('bootstrap injected into the panel', typeof boot === 'object' && boot !== null);

  original = await call('get_settings');
  check(
    'bootstrap equals get_settings',
    JSON.stringify(boot) === JSON.stringify(original),
    `${Object.keys(boot).length} fields`,
  );
  check(
    'bootstrap carries the export fields',
    ['csvBom', 'fileNameTemplate', 'duplicateStrategy', 'defaultExportFormat'].every(
      (key) => key in boot,
    ),
  );

  // Then start the test from a known state. Without this, a run that died
  // before its restore (killed dev process, crashed relaunch) leaves its test
  // values in the DB and every later run adopts them as "original" — e.g. a
  // splitRatio stuck at the test value makes the live-resize check compare a
  // width with itself. `original` is still what the final restore writes back.
  await call('reset_settings');
  await sleep(300);

  // The attribute is written at module scope in main.tsx, before React renders;
  // the marker is set in that same block, so it proves the ordering.
  const marker = await evalIn(panel, 'window.__PLACE_MILL_THEME_APPLIED__');
  const themeAttr = await evalIn(panel, 'document.documentElement.dataset.theme');
  const themeOk =
    boot.theme === 'system'
      ? themeAttr === 'dark' || themeAttr === 'light'
      : themeAttr === boot.theme;
  check(
    'theme applied before the first React render',
    marker === 'module' && themeOk,
    `marker=${marker} attr=${themeAttr} setting=${boot.theme}`,
  );

  // `reset_settings` ran just above, so the language is back at its default:
  // the DOM must be English whatever the app booted with. (Comparing against
  // `boot.language` here made the check fail whenever the previous run left the
  // store on another language.)
  const lang = await evalIn(panel, 'document.documentElement.lang');
  check('locale applied after the reset', lang === 'en-US', lang);

  // --- live updates ---
  await call('update_settings', { patch: { theme: 'dark' } });
  await sleep(300);
  check(
    'theme=dark reaches the DOM',
    (await evalIn(panel, 'document.documentElement.dataset.theme')) === 'dark',
  );

  const beforeLanguage = boot.language;
  await call('update_settings', { patch: { language: 'zh' } });
  await sleep(400);
  check(
    'language=zh switches the UI',
    (await evalIn(panel, 'document.documentElement.lang')) === 'zh-CN' &&
      (await evalIn(panel, 'document.body.innerText.includes("\u91c7\u96c6")')),
  );
  await call('update_settings', { patch: { language: beforeLanguage } });
  await sleep(300);

  await call('update_settings', { patch: { pageSize: 20 } });
  await sleep(400);
  const pageSizeText = await evalIn(
    panel,
    `(document.querySelector('.ant-pagination-options .ant-select-selection-item') || {}).textContent || ''`,
  );
  if (pageSizeText) {
    check('pageSize=20 reaches the table', pageSizeText.includes('20'), pageSizeText);
  } else {
    note('pageSize DOM check skipped: the table shows no pagination');
  }

  // --- split handle ---
  const widthBefore = await evalIn(panel, 'window.innerWidth');
  const applied = await call('set_split_ratio', { ratio: 0.6 });
  await sleep(600);
  const widthAfter = await evalIn(panel, 'window.innerWidth');
  check('set_split_ratio resolves the clamped ratio', Math.abs(applied - 0.6) < 1e-6, String(applied));
  check(
    'split change resizes the panel live',
    widthAfter > widthBefore + 40,
    `${widthBefore} -> ${widthAfter}`,
  );

  // --- validation ---
  const clamped = await call('update_settings', { patch: { scrollMinMs: 99999, pageSize: 7 } });
  check('scrollMinMs clamped to 10000', clamped.scrollMinMs === 10000, String(clamped.scrollMinMs));
  check('pageSize=7 falls back to 50', clamped.pageSize === 50, String(clamped.pageSize));

  // R-25: the clamp above must announce itself. Without the event the drawer
  // keeps showing "saved" while the backend stored something else.
  await evalIn(
    panel,
    `(async () => {
       window.__e2eCorrected = null;
       if (!window.__e2eCorrectedUn) {
         window.__e2eCorrectedUn = await window.__TAURI__.event.listen('settings:corrected', (e) => {
           window.__e2eCorrected = e.payload;
         });
       }
       return true;
     })()`,
  );
  await evalIn(
    panel,
    `(async () => {
       try {
         await window.__TAURI_INTERNALS__.invoke('update_settings', { patch: { theme: 'neon' } });
         return 'OK';
       } catch (e) { return 'ERR:' + String(e); }
     })()`,
  );
  await sleep(500);
  const correctedEvent = await evalIn(panel, 'JSON.stringify(window.__e2eCorrected)');
  check(
    'a corrected value is announced to the panel',
    typeof correctedEvent === 'string' && correctedEvent.includes('theme'),
    correctedEvent,
  );

  // Catch inside the page: a rejected Tauri promise surfaces as a generic
  // "Uncaught (in promise)" over CDP, losing the message we want to assert on.
  const unknownKey = await evalIn(
    panel,
    `(async () => {
       try {
         await window.__TAURI_INTERNALS__.invoke('update_settings', { patch: { scrollminMs: 500 } });
         return 'NO_ERROR';
       } catch (e) { return 'ERR:' + String(e); }
     })()`,
  );
  check(
    'unknown key is rejected',
    unknownKey.startsWith('ERR:') && unknownKey.includes('unknown_setting'),
    unknownKey.slice(0, 60),
  );

  // --- collector settings reach the maps webview ---
  let mapsTarget = null;
  try {
    mapsTarget = await waitForMapsTarget(60_000);
    check('maps webview target found', true, mapsTarget.url);
  } catch (error) {
    check('maps webview target found', false, error.message);
  }

  if (mapsTarget) {
    // Google Maps is a network page: a slow load must degrade to one failed
    // check instead of aborting the rest of the run.
    const maps = await connect(mapsTarget.webSocketDebuggerUrl).catch(() => null);
    if (!maps) {
      check('maps webview ready', false, 'could not attach to the CDP target');
    } else {
      try {
        await waitFor(maps, 'typeof window.__placemillAutoScroll === "object"', 90_000, 'autoscroll');

        await call('update_settings', {
          patch: { scrollMinMs: 3000, scrollMaxMs: 6000, maxScrolls: 42, jitter: false },
        });

        let minDelay = 0;
        for (let i = 0; i < 24; i += 1) {
          minDelay = await evalIn(maps, '(window.__placemillAutoScroll || {}).minDelay');
          if (minDelay === 3000) break;
          await sleep(250);
        }
        check('maps webview applied the scroll range', minDelay === 3000, String(minDelay));
        // M5 (720245a) rides a validated field map along with the collector
        // payload, so the key set is the 7 collector fields plus
        // `fieldMap`/`fieldMapVersion` while a remote config is active. The
        // assertion's real intent is unchanged: no full-settings leak
        // (theme, pageSize, exportDir, …) may reach the Maps webview.
        const mapsKeys = await evalIn(maps, 'Object.keys(window.__placemillSettings)');
        const ALLOWED_MAPS_KEYS = new Set([
          'jitter',
          'logLevel',
          'maxScrolls',
          'onlyWithPhone',
          'scrollMaxMs',
          'scrollMinMs',
          'stopAfterIdle',
          'fieldMap',
          'fieldMapVersion',
        ]);
        check(
          'maps webview only sees the collector subset',
          Array.isArray(mapsKeys) &&
            mapsKeys.length > 0 &&
            mapsKeys.every((key) => ALLOWED_MAPS_KEYS.has(key)),
          Array.isArray(mapsKeys) ? mapsKeys.join(',') : String(mapsKeys),
        );
        check(
          'jitter=false is applied',
          (await evalIn(maps, 'window.__placemillAutoScroll.jitter')) === false,
        );
        check(
          'log level applied',
          (await evalIn(maps, 'window.__placemillSettings.logLevel')) === 'normal',
        );
      } catch (error) {
        let detail = error.message;
        try {
          detail += ` | url=${await evalIn(maps, 'location.href')}`;
          detail += ` ready=${await evalIn(maps, 'document.readyState')}`;
        } catch {
          /* page not evaluable either */
        }
        check('maps webview ready', false, detail);
      } finally {
        maps.close();
      }
    }
  }

  // --- Rust-side backstop (negative case only: nothing is written) ---
  await call('update_settings', { patch: { onlyWithPhone: true } });
  // `get_businesses` went away with R-29: the row count now comes back with a
  // one-row page query.
  const totalRows = async () =>
    (await call('query_businesses', { request: { page: 1, pageSize: 1 } })).total;
  const rowsBefore = await totalRows();
  await call('on_business_data', {
    businesses: [
      {
        name: 'E2E_NO_PHONE',
        address: 'e2e',
        phone: '',
        rating: 0,
        reviews_total: 0,
        lat: 0,
        lng: 0,
        place_id: `E2E_NOPHONE_${Date.now()}`,
        website: '',
        types: [],
      },
    ],
  });
  await sleep(300);
  const rowsAfter = await totalRows();
  check('only_with_phone blocks phone-less rows', rowsAfter === rowsBefore, `${rowsBefore} -> ${rowsAfter}`);

  // --- distinctive state for the restart phase ---
  expected = await call('update_settings', {
    patch: {
      theme: 'light',
      language: 'en',
      pageSize: 100,
      splitRatio: 0.6,
      scrollMinMs: 3000,
      scrollMaxMs: 6000,
      maxScrolls: 42,
      stopAfterIdle: 5,
      jitter: false,
      onlyWithPhone: true,
      logLevel: 'verbose',
      defaultExportFormat: 'csv',
      exportPreset: 'hubspot',
      csvBom: false,
      fileNameTemplate: 'e2e-{date}-{count}',
      duplicateStrategy: 'update',
      hiddenColumns: ['types', 'emails'],
    },
  });
  check('distinctive state written for the restart check', expected.pageSize === 100);

  panel.close();
}

// ---------------------------------------------------------------------------
// Phase 2: restart, verify what survived, put the original back
// ---------------------------------------------------------------------------

async function phaseRestart() {
  const panel = await connect((await waitForPanelTarget(LAUNCH_TIMEOUT_MS)).webSocketDebuggerUrl);
  await waitFor(panel, 'typeof window.__TAURI_INTERNALS__ === "object"', 60_000, 'tauri ipc');
  await waitFor(panel, 'document.querySelector(".app-shell") !== null', 90_000, 'react mount');
  const call = api(panel);

  if (expected) {
    const actual = await call('get_settings');
    for (const key of PERSISTED_KEYS) {
      check(
        `persisted after restart: ${key}`,
        JSON.stringify(actual[key]) === JSON.stringify(expected[key]),
        JSON.stringify(actual[key]),
      );
    }
    check(
      'persisted after restart: splitRatio',
      Math.abs(actual.splitRatio - 0.6) < 1e-3,
      String(actual.splitRatio),
    );

    // theme=light while the OS may be dark: only the bootstrap path can win this
    // before the first paint, and the marker proves it ran before React rendered.
    const marker = await evalIn(panel, 'window.__PLACE_MILL_THEME_APPLIED__');
    const themeAttr = await evalIn(panel, 'document.documentElement.dataset.theme');
    check(
      'prepaint theme wins over the OS preference',
      marker === 'module' && themeAttr === 'light',
      `marker=${marker} attr=${themeAttr}`,
    );
    const boot = JSON.parse(await evalIn(panel, 'JSON.stringify(window.__PLACE_MILL_SETTINGS__)'));
    check('bootstrap carries the persisted page size', boot.pageSize === 100, String(boot.pageSize));
  } else {
    note('phase 1 aborted before writing test values: only restoring the original settings');
    check('persistence checks skipped', true, 'phase 1 incomplete');
  }

  if (original) {
    await call('update_settings', { patch: original });
    await sleep(500);
    const restored = await call('get_settings');
    check(
      'original settings restored',
      JSON.stringify(restored) === JSON.stringify(original),
    );
  }

  panel.close();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  await preflight();

  try {
    await launchApp();
    await phaseBehaviour().catch((error) => {
      check('phase 1 completed', false, error.message);
    });
  } finally {
    await stopApp();
  }

  if (original) {
    try {
      await launchApp();
      await phaseRestart().catch((error) => {
        check('phase 2 completed', false, error.message);
        dumpDevLog();
      });
    } finally {
      await stopApp();
    }
  } else {
    note('no settings were touched before the failure: skipping the restart phase');
  }

  if (failures > 0) dumpDevLog();
  try {
    rmSync(DEV_LOG, { force: true });
  } catch {
    /* ignore */
  }

  console.log(failures === 0 ? '\nRESULT: ALL CHECKS PASSED' : `\nRESULT: ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

process.on('SIGINT', async () => {
  await stopApp();
  process.exit(130);
});

main().catch((error) => {
  console.error(`ERROR  ${error.message}`);
  process.exit(2);
});
