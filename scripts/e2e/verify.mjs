#!/usr/bin/env node
/**
 * E2E acceptance for email verification (roadmap G-04).
 *
 * A local HTTP server stands in for a DoH resolver; `PLACE_MILL_VERIFY_DOH`
 * points the debug build at it, so the run exercises the real client, the real
 * parser and the real write path — only the network is fake.
 *
 *   good.test     MX              -> valid
 *   nullmx.test   MX 0 .          -> invalid(null_mx)
 *   nx.test       Status 3        -> invalid(nxdomain)
 *   amx.test      no MX, A exists -> unknown(implicit_mx)
 *   nomx.test     no MX, no A     -> invalid(no_mx)
 *   slow.test     MX, delayed     -> valid (drives cancel / exclusion tests)
 *   mailinator.com                -> must never be queried (disposable)
 *
 * Usage:
 *   npm run e2e:verify
 *   npm run e2e:verify -- --keep-data
 */
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  backupDatabase,
  check,
  databaseDir,
  devLog,
  evalIn,
  launchApp,
  note,
  openPanel,
  preflight,
  printSummary,
  restoreDatabase,
  sleep,
  stopApp,
} from './harness.mjs';

const KEEP_DATA = process.argv.includes('--keep-data');
const RUN = Date.now();
const DNS_PORT = 14301;
const SITE_PORT = 14302;
const SITE_HOST = '127.0.0.2';

/** Mutable fixture state — the suite flips these between phases. */
const fixture = {
  mode: 'ok',
  delayMs: 0,
  requests: 0,
  counts: new Map(),
};

function countFor(domain) {
  return fixture.counts.get(domain) ?? 0;
}

function resetCounts() {
  fixture.counts = new Map();
  fixture.requests = 0;
}

function mxAnswer(name) {
  return {
    Status: 0,
    Answer: [
      { name: `${name}.`, type: 15, TTL: 60, data: `10 mx.${name}.` },
    ],
  };
}

function dnsAnswer(name, type) {
  if (type === 'MX') {
    if (name === 'good.test' || name === 'slow.test') return mxAnswer(name);
    if (name === 'nullmx.test') {
      return {
        Status: 0,
        Answer: [{ name: `${name}.`, type: 15, TTL: 60, data: '0 .' }],
      };
    }
    if (name === 'nx.test') return { Status: 3 };
    // No MX record at all: the client must fall back to the A record.
    if (name === 'amx.test' || name === 'nomx.test') return { Status: 0 };
    return { Status: 3 };
  }
  if (name === 'amx.test') {
    return {
      Status: 0,
      Answer: [{ name: `${name}.`, type: 1, TTL: 60, data: '1.2.3.4' }],
    };
  }
  return { Status: 0 };
}

function startDohServer() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${DNS_PORT}`);
    if (url.pathname !== '/dns-query') {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const name = url.searchParams.get('name') ?? '';
    const type = url.searchParams.get('type') ?? 'MX';
    fixture.counts.set(name, countFor(name) + 1);
    fixture.requests += 1;
    if (fixture.delayMs > 0) await sleep(fixture.delayMs);
    if (fixture.mode === 'fail') {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('resolver down');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/dns-json' });
    response.end(JSON.stringify(dnsAnswer(name, type)));
  });
  return new Promise((resolve) => {
    server.listen(DNS_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** A slow site, so a mining run stays in flight long enough to be observed. */
function startSiteServer() {
  const server = http.createServer(async (_request, response) => {
    await sleep(3000);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><body><p>No address here.</p></body></html>');
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.listen(SITE_PORT, SITE_HOST, () => resolve(server));
  });
}

function buildRows() {
  const common = {
    address: '1 Test Street',
    phone: '+1 555 0100',
    rating: 4.2,
    reviews_total: 9,
    lat: 34.05,
    lng: -118.24,
    types: ['dentist'],
  };
  const row = (suffix, emails, website = '') => ({
    ...common,
    place_id: `e2e-vf-${RUN}-${suffix}`,
    name: `E2E Verify ${suffix}`,
    website,
    emails,
  });
  return [
    // Two rows, one address each pair — the same address appears twice on
    // purpose (cross-row dedupe) and one row has both a valid and a risky one.
    // `alice@` is the valid case on purpose: `info@` is in `ROLE_MAILBOXES`,
    // so it can only ever come out `risky`.
    row('1', ['alice@good.test', 'sales@good.test'], 'https://good.test'),
    row('2', ['ALICE@good.test']),
    row('3', ['a@nullmx.test']),
    row('4', ['b@nx.test']),
    row('5', ['c@amx.test']),
    row('6', ['d@nomx.test']),
    row('7', ['e@mailinator.com']),
    row('8', ['bad@@x.com']),
    row('9', []),
    row('10', ['slow@slow.test']),
    // Website only: the mining-exclusion phase needs a target.
    row('11', [], `http://${SITE_HOST}:${SITE_PORT}/`),
  ];
}

/**
 * Write the mined column for the seeded rows.
 *
 * `store_businesses` (the insert path behind `on_business_data`) deliberately
 * never writes `emails`: the column belongs to the miner, and a re-collect must
 * not erase what a previous mining run found. There is no command that sets it
 * either, so the fixture writes the column the same way `update_email_mining`
 * would — one UPDATE per row, on the file the app is already using.
 *
 * `node:sqlite` is built in only from Node 22.5 (still experimental), so it is
 * loaded here rather than at module scope: an older runtime should get a clear
 * message instead of dying on an import line.
 */
async function seedEmails(rows) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('seeding the mined column needs node:sqlite (Node >= 22.5)');
  }
  const db = new DatabaseSync(join(databaseDir(), 'placemill.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const update = db.prepare('UPDATE businesses SET emails = ? WHERE place_id = ?');
    for (const row of rows) {
      update.run(JSON.stringify(row.emails), row.place_id);
    }
  } finally {
    db.close();
  }
}

async function attempt(panel, command, args) {
  const raw = await evalIn(
    panel,
    `(async () => {
       try {
         const value = await window.__TAURI_INTERNALS__.invoke(
           ${JSON.stringify(command)},
           ${JSON.stringify(args ?? {})}
         );
         return JSON.stringify({ ok: true, value: value === undefined ? null : value });
       } catch (error) {
         return JSON.stringify({
           ok: false,
           error: String(error && error.message ? error.message : error),
         });
       }
     })()`,
  );
  return JSON.parse(raw);
}

async function installListeners(panel) {
  await evalIn(
    panel,
    `(async () => {
       window.__verifyDone = [];
       window.__verifyProgress = [];
       window.__mineDone = [];
       await window.__TAURI__.event.listen('email:done', (event) =>
         window.__mineDone.push(event.payload));
       await window.__TAURI__.event.listen('email:verify:done', (event) =>
         window.__verifyDone.push(event.payload));
       await window.__TAURI__.event.listen('email:verify:progress', (event) =>
         window.__verifyProgress.push(event.payload));
       return true;
     })()`,
  );
}

async function clearEvents(panel) {
  await evalIn(panel, 'window.__verifyDone = []; window.__verifyProgress = []; true');
}

async function lastDone(panel) {
  const events = await evalIn(panel, 'window.__verifyDone ?? []');
  return Array.isArray(events) && events.length > 0 ? events[events.length - 1] : null;
}

async function rowsByPlace(call) {
  const page = await call('query_businesses', { request: { page: 1, pageSize: 100 } });
  const map = new Map();
  page.verifyRefs.forEach((ref) => map.set(ref.placeId, ref));
  return { rows: page.rows, refs: map, total: page.total };
}

function refOf(state, suffix) {
  return state.refs.get(`e2e-vf-${RUN}-${suffix}`) ?? null;
}

async function main() {
  await preflight();

  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (!snapshot && !KEEP_DATA) {
    throw new Error('could not snapshot the database; refusing to clear real rows');
  }

  const doh = await startDohServer();
  const site = await startSiteServer();
  // Read by `launchApp` through the inherited environment; the debug-only hook
  // also accepts `http://` for exactly this case.
  process.env.PLACE_MILL_VERIFY_DOH = `http://127.0.0.1:${DNS_PORT}/dns-query`;

  let panel = null;
  let exportDir = null;
  note(`G-04 · email verification (run ${RUN})`);

  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);
    await installListeners(panel);

    if (snapshot) {
      await call('clear_data');
      await sleep(400);
    }
    await call('on_business_data', { businesses: buildRows() });
    const seeded = await pollUntil(
      () => call('query_businesses', { request: { page: 1, pageSize: 100 } }),
      (page) => page.total === 11,
      15_000,
    );
    check('the synthetic rows are in the table', seeded.total === 11, `${seeded.total}`);
    await seedEmails(buildRows());

    // ---- 1. preflight numbers -------------------------------------------
    resetCounts();
    const plan = await call('verify_email_plan', { request: { filter: {} } });
    check('preflight counts the rows that carry an address', plan.rows === 9, `${plan.rows}`);
    check('preflight counts distinct addresses', plan.addresses === 9, `${plan.addresses}`);
    check('nothing is cached yet', plan.cached === 0 && plan.pending === 9, JSON.stringify(plan));
    check(
      'preflight separates the offline-invalid addresses',
      plan.localInvalid === 2,
      `${plan.localInvalid}`,
    );
    check('preflight counts distinct domains to resolve', plan.lookups === 6, `${plan.lookups}`);
    check('a small scope does not ask for confirmation', plan.confirm === false);
    check('preflight is read-only', fixture.requests === 0, `${fixture.requests} requests`);

    // ---- 2. a full run ---------------------------------------------------
    await clearEvents(panel);
    const accepted = await call('start_email_verification', { request: { filter: {} } });
    check('start returns the plan it accepted', accepted.addresses === 9, JSON.stringify(accepted));

    const done = await pollUntil(() => lastDone(panel), Boolean, 60_000);
    check('the run is not cancelled', done.cancelled === false && done.reason === '', JSON.stringify(done));
    check('no fatal error', done.fatal === '', done.fatal);
    check(
      'the status counts add up to done',
      done.valid + done.risky + done.invalid + done.unknown + done.error === done.done &&
        done.done === 9,
      JSON.stringify(done),
    );
    check(
      'verdicts: 2 valid, 1 risky, 5 invalid, 1 unknown',
      done.valid === 2 &&
        done.risky === 1 &&
        done.invalid === 5 &&
        done.unknown === 1 &&
        done.error === 0,
      JSON.stringify(done),
    );

    const after = await rowsByPlace(call);
    const first = refOf(after, '1');
    check('a row with a valid address is valid', first?.status === 'valid', JSON.stringify(first?.status));
    check('the row is not stale', first?.stale === false);
    check(
      'the valid address carries the same-domain evidence',
      first?.addresses.find((a) => a.address === 'alice@good.test')?.sameDomain === true,
      JSON.stringify(first?.addresses),
    );
    check(
      'the role mailbox is risky, not valid',
      first?.addresses.find((a) => a.address === 'sales@good.test')?.status === 'risky',
      JSON.stringify(first?.addresses),
    );

    const status = (suffix) => refOf(after, suffix)?.status;
    const flags = (suffix) => refOf(after, suffix)?.addresses[0]?.flags ?? [];
    check('null MX is invalid', status('3') === 'invalid' && flags('3').includes('null_mx'), JSON.stringify(flags('3')));
    check('NXDOMAIN is invalid', status('4') === 'invalid' && flags('4').includes('nxdomain'), JSON.stringify(flags('4')));
    check(
      'no MX with an A record is unknown',
      status('5') === 'unknown' && flags('5').includes('implicit_mx'),
      JSON.stringify(flags('5')),
    );
    check('no MX and no A is invalid', status('6') === 'invalid' && flags('6').includes('no_mx'), JSON.stringify(flags('6')));
    check(
      'a disposable domain is invalid without a lookup',
      status('7') === 'invalid' && flags('7').includes('disposable'),
      JSON.stringify(flags('7')),
    );
    check('a syntax error is invalid', status('8') === 'invalid' && flags('8').includes('syntax'), JSON.stringify(flags('8')));
    check('a row without addresses reports none', status('9') === 'none', JSON.stringify(status('9')));

    // ---- 3. one lookup per domain, cross-row ---------------------------
    check('the shared domain was resolved once', countFor('good.test') === 1, `${countFor('good.test')}`);
    check(
      'the disposable domain was never sent to the resolver',
      countFor('mailinator.com') === 0,
      `${countFor('mailinator.com')}`,
    );
    check(
      'the implicit-MX domain needed the A fallback',
      countFor('amx.test') === 2,
      `${countFor('amx.test')}`,
    );
    check('the fixture saw exactly the six domains', fixture.requests === 8, `${fixture.requests}`);

    // ---- 4. the cache is reused -----------------------------------------
    resetCounts();
    const second = await attempt(panel, 'start_email_verification', { request: { filter: {} } });
    check(
      'a second run is refused because everything is fresh',
      !second.ok && second.error.includes('nothing_to_verify:already_verified'),
      JSON.stringify(second),
    );
    const plan2 = await call('verify_email_plan', { request: { filter: {} } });
    check(
      'the preflight now reports everything cached',
      plan2.cached === 9 && plan2.pending === 0,
      JSON.stringify(plan2),
    );

    // ---- 5. force re-queries --------------------------------------------
    await clearEvents(panel);
    await call('start_email_verification', { request: { filter: {}, force: true } });
    const forced = await pollUntil(() => lastDone(panel), Boolean, 60_000);
    check('a forced run resolves again', forced.lookups >= 6, `${forced.lookups}`);
    check('the forced run is complete', forced.done === 9, JSON.stringify(forced));

    // ---- 6. filters ------------------------------------------------------
    const usable = await call('query_businesses', {
      request: { verify: 'usable', page: 1, pageSize: 100 },
    });
    const usableIds = usable.rows.map((row) => row.place_id).sort();
    check(
      'usable returns the rows with a valid or risky address',
      usableIds.join(',') === [`e2e-vf-${RUN}-1`, `e2e-vf-${RUN}-2`, `e2e-vf-${RUN}-10`].sort().join(','),
      JSON.stringify(usableIds),
    );
    const invalid = await call('query_businesses', {
      request: { verify: 'invalid', page: 1, pageSize: 100 },
    });
    check('invalid excludes the unknown row', invalid.total === 5, `${invalid.total}`);
    const unverified = await call('query_businesses', {
      request: { verify: 'unverified', page: 1, pageSize: 100 },
    });
    check(
      'unverified never counts a row without addresses',
      unverified.total === 0,
      `${unverified.total}`,
    );

    // ---- 7. export -------------------------------------------------------
    exportDir = join(tmpdir(), `placemill-e2e-verify-${RUN}`);
    mkdirSync(exportDir, { recursive: true });
    await call('update_settings', {
      patch: { exportDir, exportSaveMode: 'auto', openExportFolder: false },
    });
    const file = await call('export_csv', {
      businesses: [],
      filter: { page: 1, pageSize: 100 },
      fileName: `e2e-verify-${RUN}`,
      saveAs: false,
    });
    const csv =
      file && existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
    check('the export contains both verification columns', csv.includes('Email Status,Email Verification'), csv.slice(0, 200));
    check(
      'the row status is a stable token',
      /(^|\r?\n)valid,/.test(csv) || csv.includes(',valid,'),
      csv.slice(0, 400),
    );
    check(
      'the detail cell names the role mailbox',
      csv.includes('sales@good.test=risky(role)'),
      csv.slice(0, 600),
    );
    check(
      'the detail cell writes an error code only for failed lookups',
      !csv.includes('=error('),
      csv.slice(0, 600),
    );

    // ---- 8/9/10. single flight, exclusion, cancel -----------------------
    fixture.delayMs = 2500;
    await clearEvents(panel);
    await call('start_email_verification', { request: { filter: {}, force: true } });
    await sleep(300);

    const twice = await attempt(panel, 'start_email_verification', {
      request: { filter: {}, force: true },
    });
    check(
      'a second start while running is refused',
      !twice.ok && twice.error.includes('already-running'),
      JSON.stringify(twice),
    );

    const mineWhileVerifying = await attempt(panel, 'start_email_mining', {
      request: { placeIds: [`e2e-vf-${RUN}-11`] },
    });
    check(
      'mining is refused while verification runs',
      !mineWhileVerifying.ok && mineWhileVerifying.error.includes('verify_running'),
      JSON.stringify(mineWhileVerifying),
    );

    await call('cancel_email_verification');
    const cancelled = await pollUntil(() => lastDone(panel), Boolean, 30_000);
    check(
      'the run reports a user cancellation',
      cancelled.cancelled === true && cancelled.reason === 'user',
      JSON.stringify(cancelled),
    );
    check(
      'partial results are kept',
      cancelled.done > 0,
      JSON.stringify(cancelled),
    );

    // The other direction: mining holds the slot, verification is refused.
    fixture.delayMs = 0;
    const mining = await attempt(panel, 'start_email_mining', {
      request: { placeIds: [`e2e-vf-${RUN}-11`] },
    });
    check('the slow site is scheduled', mining.ok, JSON.stringify(mining));
    await sleep(300);
    const verifyWhileMining = await attempt(panel, 'start_email_verification', {
      request: { filter: {}, force: true },
    });
    check(
      'verification is refused while mining runs',
      !verifyWhileMining.ok && verifyWhileMining.error.includes('mining_running'),
      JSON.stringify(verifyWhileMining),
    );
    await call('cancel_email_mining');
    // The slot is released only when the worker thread ends; waiting for its
    // `email:done` is the only honest signal.
    await pollUntil(
      async () => {
        const events = await evalIn(panel, 'window.__mineDone ?? []');
        return Array.isArray(events) && events.length > 0;
      },
      Boolean,
      60_000,
    );

    // ---- 11. clear during an in-flight run ------------------------------
    fixture.delayMs = 2500;
    await clearEvents(panel);
    await call('start_email_verification', { request: { filter: {}, force: true } });
    await sleep(400);
    await call('clear_data');
    const clearedDone = await pollUntil(() => lastDone(panel), Boolean, 30_000);
    check(
      'a clear stops the run through the epoch',
      clearedDone.cancelled === true && clearedDone.reason === 'cleared',
      JSON.stringify(clearedDone),
    );
    await sleep(600);
    const leftover = await evalIn(
      panel,
      `(async () => {
         const page = await window.__TAURI_INTERNALS__.invoke('query_businesses', {
           request: { page: 1, pageSize: 100 },
         });
         return JSON.stringify({ total: page.total, refs: page.verifyRefs.length });
       })()`,
    );
    check('the clear left no rows behind', JSON.parse(leftover).total === 0, leftover);

    // ---- 12. every endpoint failing --------------------------------------
    fixture.delayMs = 0;
    fixture.mode = 'fail';
    await call('on_business_data', { businesses: buildRows() });
    await pollUntil(
      () => call('query_businesses', { request: { page: 1, pageSize: 100 } }),
      (page) => page.total === 11,
      15_000,
    );
    await seedEmails(buildRows());
    await clearEvents(panel);
    await call('start_email_verification', { request: { filter: {} } });
    const failed = await pollUntil(() => lastDone(panel), Boolean, 60_000);
    check(
      'every address ends in error, none in invalid',
      failed.error === 7 && failed.invalid === 2,
      JSON.stringify(failed),
    );
    const failedRows = await rowsByPlace(call);
    check(
      'a failed lookup shows as unverified, not invalid',
      refOf(failedRows, '3')?.status === 'unverified',
      JSON.stringify(refOf(failedRows, '3')?.status),
    );
    fixture.mode = 'ok';
  } finally {
    await stopApp();
    doh.close();
    site.close();
    if (exportDir) rmSync(exportDir, { recursive: true, force: true });
    restoreDatabase(snapshot);
    delete process.env.PLACE_MILL_VERIFY_DOH;
  }

  const ok = printSummary();
  process.exit(ok ? 0 : 1);
}

process.on('SIGINT', async () => {
  await stopApp();
  process.exit(130);
});

main().catch(async (error) => {
  console.error(`ERROR  ${error.message}`);
  devLog();
  await stopApp();
  process.exit(2);
});

async function pollUntil(produce, isDone, timeoutMs) {
  const started = Date.now();
  for (;;) {
    let value = null;
    try {
      value = await produce();
    } catch {
      // transient CDP hiccups must not abort the poll
    }
    const settled = isDone(value);
    if (settled) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`poll timed out after ${timeoutMs}ms (last: ${JSON.stringify(value)})`);
    }
    await sleep(400);
  }
}
