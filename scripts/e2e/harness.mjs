/**
 * Shared CDP harness for end-to-end checks against the real app.
 *
 * Same mechanism as `scripts/e2e-settings.mjs`: launch `tauri dev` with
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`, then drive
 * the two webviews over the DevTools protocol. Nothing is mocked: the React
 * panel, the Rust commands and the injected script all run for real.
 *
 * Why the environment variable and not `additional_browser_args()`: WebView2
 * refuses webviews whose environment arguments differ inside one user-data
 * folder, so a per-webview flag would blank the Maps panel. The env var applies
 * to the whole process, which keeps both webviews consistent.
 *
 * Requirements: Windows + WebView2 + a machine where a GUI window may open.
 * Ports 1421 (Vite) and 9222 (CDP) must be free.
 *
 * The settings suite still carries its own copy of this code; merge it into
 * this module the next time that file is touched (it also does a restart cycle
 * that would need a slightly different `stopApp` contract).
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEV_PORT = 1421;
export const CDP_PORT = 9222;
export const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
export const LAUNCH_TIMEOUT_MS = 240_000;
/// A single CDP call may not take longer than this.
export const CDP_TIMEOUT_MS = 30_000;

const DEV_LOG = join(tmpdir(), 'placemill-e2e-dev.log');
const DB_FILES = ['placemill.db', 'placemill.db-wal', 'placemill.db-shm'];

// ---------------------------------------------------------------------------
// Check bookkeeping
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

export function check(name, ok, detail = '') {
  checks += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

export function note(message) {
  console.log(`INFO  ${message}`);
}

export function skip(name, reason) {
  console.log(`SKIP  ${name}  [${reason}]`);
}

export function failureCount() {
  return failures;
}

export function printSummary() {
  const failed = failures > 0;
  console.log(
    failed
      ? `\nRESULT: ${failures} of ${checks} check(s) failed`
      : `\nRESULT: ALL ${checks} CHECKS PASSED`,
  );
  return !failed;
}

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

/**
 * Vite may bind `[::1]` only. Probing 127.0.0.1 alone missed a running dev
 * server, and the suite then started a second one on another port — with the
 * database restore failing because the first app still held the file.
 */
export async function portIsOpen(port) {
  if (await probe(port, '127.0.0.1')) return true;
  return probe(port, '::1');
}

export async function preflight() {
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

let child = null;
let stopping = false;
let devLogTail = [];

export function devLog() {
  if (!devLogTail.length) return;
  console.log('\n--- tauri dev output (tail) ---');
  for (const line of devLogTail) console.log(line);
  console.log(`--- full log: ${DEV_LOG} ---\n`);
}

/** Reject when the promise takes longer than `ms`. The label goes into the
 *  error, so a stalled step says which one it was instead of hanging. */
export function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  // The guard keeps its timer even when the race is already settled; without
  // this catch its later rejection is unhandled and takes the process down.
  guard.catch(() => {});
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), guard]);
}

/** Spawn `tauri dev` and wait until the panel target answers over CDP. */
export async function launchApp({ waitForPanel = true } = {}) {
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
  child = spawn('npm run tauri dev', {
    cwd: REPO_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      // The email-mining fixture serves from 127.0.0.2/3, which the miner's
      // SSRF guard rejects by design (R-05). Debug builds honour this flag; a
      // release binary ignores it (the check is `cfg!`-gated).
      PLACE_MILL_ALLOW_PRIVATE_TARGETS: '1',
      // The suites seed rows with no collecting session (no job behind the
      // injected `business-data`), which the write gate and the Rust-side
      // attribution refuse by design. Same debug-only escape hatch as above; a
      // release binary never reads it.
      PLACE_MILL_ALLOW_OFF_SESSION_BATCHES: '1',
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
    if (code !== 0 && code !== null && !stopping) note(`dev process exited with code ${code}`);
  });

  if (!waitForPanel) return;

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${CDP_BASE}/json/list`);
      const targets = await res.json();
      if (targets.some(isPanelTarget)) return;
    } catch {
      /* CDP not up yet */
    }
    await sleep(500);
  }
  throw new Error('app did not expose a panel target in time');
}

export async function stopApp() {
  if (!child) return;
  stopping = true;
  const pid = child.pid;
  child = null;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    killer.once('exit', resolve);
    killer.once('error', resolve);
  });
  // WebView2 needs a moment to release the user-data folder before a relaunch.
  await sleep(3000);
}

// ---------------------------------------------------------------------------
// Targets + CDP client
// ---------------------------------------------------------------------------

export const isPanelTarget = (target) =>
  target.type === 'page' && /localhost:142\d/.test(target.url || '');
export const isMapsTarget = (target) =>
  target.type === 'page' && /google\.com/.test(target.url || '');

export async function listTargets() {
  const res = await fetch(`${CDP_BASE}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list returned ${res.status}`);
  return res.json();
}

async function waitForTarget(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    try {
      seen = await listTargets();
      const found = seen.find(predicate);
      if (found) return found;
    } catch {
      /* ignore */
    }
    await sleep(500);
  }
  throw new Error(`no ${label} target. saw: ${JSON.stringify(seen.map((t) => t.url))}`);
}

export const waitForPanelTarget = (timeoutMs = LAUNCH_TIMEOUT_MS) =>
  waitForTarget(isPanelTarget, 'panel', timeoutMs);
export const waitForMapsTarget = (timeoutMs = 60_000) =>
  waitForTarget(isMapsTarget, 'maps', timeoutMs);

/// ---- Maps webview helpers -----------------------------------------------
/// A tile navigation replaces the execution context, so callers must not hold a
/// connection across one. These helpers re-attach on failure.

let mapsConn = null;
let mapsWs = null;

export async function connectMaps() {
  const target = await waitForMapsTarget();
  if (mapsConn && mapsWs === target.webSocketDebuggerUrl) return mapsConn;
  mapsConn?.close();
  mapsConn = await connect(target.webSocketDebuggerUrl);
  mapsWs = target.webSocketDebuggerUrl;
  return mapsConn;
}

export async function evalMaps(expression) {
  try {
    return await evalIn(await connectMaps(), expression);
  } catch {
    mapsConn?.close();
    mapsConn = null;
    mapsWs = null;
    return evalIn(await connectMaps(), expression);
  }
}

export async function pollMaps(expression, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evalMaps(expression);
      if (last) return last;
    } catch {
      /* navigation in flight */
    }
    await sleep(intervalMs);
  }
  return last;
}

export function closeMaps() {
  mapsConn?.close();
  mapsConn = null;
  mapsWs = null;
}

export async function connect(wsUrl) {
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

  // A CDP call must not wait forever. A navigation can tear the connection
  // down between the request and the answer, and then the promise would never
  // settle — the suite would hang with the app window open and no output.
  // Timing out turns that into an error the caller can retry or report.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${CDP_TIMEOUT_MS} ms`));
      }, CDP_TIMEOUT_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  return { send, close: () => ws.close() };
}

export async function evalIn(conn, expression) {
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

export async function waitFor(conn, expression, timeoutMs, label) {
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

/** Poll an expression until it is truthy, returning the last value either way. */
export async function pollValue(conn, expression, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evalIn(conn, expression);
      if (last) return last;
    } catch {
      /* ignore */
    }
    await sleep(intervalMs);
  }
  return last;
}

/** `invoke` bound to a page, so tests read like the app's own code. */
export function api(conn) {
  return (command, args = {}) =>
    evalIn(
      conn,
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
    );
}

/** Attach to the panel and wait until the Tauri bridge and React are ready. */
export async function openPanel() {
  const target = await waitForPanelTarget();
  const panel = await connect(target.webSocketDebuggerUrl);
  await waitFor(panel, 'typeof window.__TAURI_INTERNALS__ === "object"', 60_000, 'tauri ipc');
  await waitFor(panel, 'document.querySelector(".app-shell") !== null', 90_000, 'react mount');
  return panel;
}

// ---------------------------------------------------------------------------
// Database backup / restore
//
// The e2e writes real rows into the real database. Snapshot it before launch and
// put it back afterwards, so a passing run leaves no trace. WAL/SHM must be
// restored together: replaying an old WAL onto a newer main file corrupts it.
// ---------------------------------------------------------------------------

export function databaseDir() {
  const conf = JSON.parse(readFileSync(join(REPO_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is not set');
  return join(appData, conf.identifier);
}

export function backupDatabase() {
  const dir = databaseDir();
  const source = join(dir, DB_FILES[0]);
  if (!existsSync(source)) {
    note(`no database yet at ${source}: nothing to back up`);
    return null;
  }

  const target = join(tmpdir(), `placemill-e2e-db-${Date.now()}`);
  mkdirSync(target, { recursive: true });
  const copied = [];
  for (const name of DB_FILES) {
    const from = join(dir, name);
    if (!existsSync(from)) continue;
    try {
      copyFileSync(from, join(target, name));
      copied.push(name);
    } catch (error) {
      note(`could not back up ${name}: ${error.message}`);
    }
  }
  note(`database backed up (${copied.join(', ') || 'nothing'}) -> ${target}`);
  return copied.length > 0 ? target : null;
}

/** @returns {boolean} true when the snapshot was restored and the snapshot deleted. */
export function restoreDatabase(snapshot) {
  if (!snapshot) return false;
  const dir = databaseDir();
  try {
    for (const name of DB_FILES) rmSync(join(dir, name), { force: true });
    for (const name of DB_FILES) {
      const from = join(snapshot, name);
      if (existsSync(from)) copyFileSync(from, join(dir, name));
    }
    rmSync(snapshot, { recursive: true, force: true });
    note('database restored from the pre-run snapshot');
    return true;
  } catch (error) {
    note(`database restore failed: ${error.message} (snapshot kept at ${snapshot})`);
    return false;
  }
}

export function databaseSizeInfo() {
  try {
    return `${statSync(join(databaseDir(), DB_FILES[0])).size} bytes`;
  } catch {
    return 'missing';
  }
}

export { sleep };
