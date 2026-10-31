#!/usr/bin/env node
/**
 * E2E acceptance for site email/social mining (roadmap M7 / G-03).
 *
 * A local fixture HTTP server stands in for real SMB websites:
 *
 *   127.0.0.2:14300   good site    — homepage has socials and a /contact
 *                                     anchor but no email; /contact has one
 *   127.0.0.3:14300   blocked site — answers 403 on everything
 *
 * Four synthetic rows point at them (two share the good domain):
 *
 *   - rows sharing a domain are mined together and both get the result
 *   - the contact page is discovered from the homepage anchor (keywords)
 *   - the blocked site ends in `email_status = blocked`, not an error
 *   - a row without a website is never touched
 *   - a second non-force run is a no-op (already-mined rows are skipped)
 *   - a second run while one is active is refused (single-flight)
 *
 * Synthetic rows go through `on_business_data`; mining is driven by
 * `start_email_mining` over CDP.
 *
 * Usage:
 *   npm run e2e:emails
 *   npm run e2e:emails -- --keep-data
 */
import http from 'node:http';
import {
  api,
  backupDatabase,
  check,
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
const GOOD_HOST = '127.0.0.2';
const BLOCKED_HOST = '127.0.0.3';
const PORT = 14300;

function startFixtureServer() {
  const pages = new Map([
    ['/', `<html><body>
        <a href="/contact">Contact us</a>
        <a href="https://www.linkedin.com/company/downtown-dental">LinkedIn</a>
        <a href="https://www.facebook.com/downtowndental">Facebook</a>
        <a href="https://www.instagram.com/downtowndental">Instagram</a>
        <script>var trap = "build@2024";</script>
      </body></html>`],
    ['/contact', `<html><body>
        <p>Write to <a href="mailto:contact@hiddendental.com">us</a>.</p>
        <a href="/">Home</a>
      </body></html>`],
  ]);
  const server = http.createServer((request, response) => {
    const host = String(request.headers.host || '');
    if (host.startsWith(BLOCKED_HOST)) {
      response.writeHead(403, { 'Content-Type': 'text/html' });
      response.end('<html><body>Forbidden</body></html>');
      return;
    }
    const path = request.url.split('?')[0];
    const body = pages.get(path);
    if (body === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  // The https-first fallback pings this plain server with TLS bytes; answer
  // politely and close so the miner falls back to http quickly.
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.listen(PORT, '0.0.0.0', () => resolve(server));
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
  return [
    {
      ...common,
      place_id: `e2e-em-${RUN}-1`,
      name: 'E2E Email Good 1',
      website: `${GOOD_HOST}:${PORT}`,
    },
    {
      ...common,
      place_id: `e2e-em-${RUN}-2`,
      name: 'E2E Email Good 2',
      website: `${GOOD_HOST}:${PORT}`,
    },
    {
      ...common,
      place_id: `e2e-em-${RUN}-3`,
      name: 'E2E Email Blocked',
      website: `http://${BLOCKED_HOST}:${PORT}/`,
    },
    {
      ...common,
      place_id: `e2e-em-${RUN}-4`,
      name: 'E2E Email NoWeb',
      website: '',
    },
  ];
}

/**
 * Run a command and normalise success/failure so a check can read either.
 *
 * The catch has to live *inside* the page: a rejected `invoke` surfaces over
 * CDP as a bare "Uncaught (in promise)" with the message stripped, which is
 * exactly the code the checks below assert on.
 */
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

async function fetchRow(call, placeId) {
  const page = await call('query_businesses', {
    request: { page: 1, pageSize: 50 },
  });
  return page.rows.find((row) => row.place_id === placeId) || null;
}

async function main() {
  await preflight();

  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (!snapshot && !KEEP_DATA) {
    throw new Error('could not snapshot the database; refusing to clear real rows');
  }

  const server = await startFixtureServer();
  let panel = null;
  note(`M7 · email/social mining (run ${RUN})`);

  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);

    if (snapshot) {
      await call('clear_data');
      await sleep(400);
    }

    await call('on_business_data', { businesses: buildRows() });
    const seeded = await pollUntil(
      () => call('query_businesses', { request: { page: 1, pageSize: 50 } }),
      (page) => page.total === 4,
      15_000,
    );
    check('the four synthetic rows are in the table', seeded.total === 4, `${seeded.total}`);

    // ---- the run starts, scoped to everything ----------------------------
    const sites = await call('start_email_mining', {
      request: { filter: {} },
    });
    // good + blocked; the website-less row is excluded by SQL.
    check('two distinct sites are scheduled', sites === 2, `${sites}`);

    // ---- single-flight ---------------------------------------------------
    const secondRun = await attempt(panel, 'start_email_mining', { request: { filter: {} } });
    check(
      'a second run is refused while one is active',
      !secondRun.ok && secondRun.error.includes('already-running'),
      JSON.stringify(secondRun),
    );

    // ---- results ---------------------------------------------------------
    const settled = await pollUntil(
      async () => {
        const good1 = await fetchRow(call, `e2e-em-${RUN}-1`);
        return good1 && good1.email_status !== '' ? good1 : null;
      },
      Boolean,
      45_000,
    );
    check(
      'the good site was mined through its contact page',
      settled.emails.includes('contact@hiddendental.com'),
      JSON.stringify(settled.emails),
    );
    check(
      'the source page is the discovered contact page',
      settled.email_source_url.includes('/contact'),
      settled.email_source_url,
    );
    check(
      'socials came from the homepage',
      settled.socials.length === 3,
      JSON.stringify(settled.socials),
    );

    const good2 = await fetchRow(call, `e2e-em-${RUN}-2`);
    check(
      'rows sharing the domain share the mining result',
      good2.email_status === 'found' &&
        good2.emails.join(',') === settled.emails.join(','),
      JSON.stringify(good2.emails),
    );

    const blocked = await fetchRow(call, `e2e-em-${RUN}-3`);
    check(
      'the 403 site is marked blocked, not error',
      blocked.email_status === 'blocked' && blocked.emails.length === 0,
      blocked.email_status,
    );

    const noweb = await fetchRow(call, `e2e-em-${RUN}-4`);
    check(
      'the website-less row was never touched',
      noweb.email_status === '' && noweb.emails.length === 0,
      noweb.email_status,
    );

    // ---- idempotency -----------------------------------------------------
    // C-15: an empty scope is an error that says *why* (`nothing_to_mine:*`),
    // not `0`. The panel used to report all three causes as "no website", which
    // is wrong when the row has one and was simply mined before.
    const again = await attempt(panel, 'start_email_mining', { request: { filter: {} } });
    check(
      'a non-force re-run reports why there is nothing to mine',
      !again.ok && again.error.includes('nothing_to_mine:already_mined'),
      JSON.stringify(again),
    );

    // (cancel_email_mining with nothing running must be a harmless no-op)
    await call('cancel_email_mining');
    check('cancel without a run is a no-op', true);
  } finally {
    await stopApp();
    server.close();
    restoreDatabase(snapshot);
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
