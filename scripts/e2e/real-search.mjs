#!/usr/bin/env node
/**
 * One real scrape, end to end (network-dependent, not part of the deterministic
 * suite).
 *
 * The other suites use a deliberately meaningless keyword (`e2e-...`) so a tile
 * ends through the `no-results` path in ~15 s. That proves the queue and the
 * state machine, but it never exercises "Google returns results -> protobuf is
 * parsed -> rows land in SQLite". This script closes that gap with the oldest
 * trick available: search for something that definitely exists.
 *
 * Expectations on failure: a consent page, a captcha or a forced re-login makes
 * this fail. That is a real signal about the account/session, not a code
 * regression — read the `tauri dev` tail before blaming the parser.
 *
 * Geometry: 2 km radius with 5 km cells collapses to exactly one tile, and the
 * 2 km circle is what makes the count meaningful. A 1 km circle around the same
 * point holds two dentists out of the ~40 the feed delivers (38 of them dropped
 * by `grid::within_radius`), so the check below is a floor for "the pipeline
 * produced rows", not a target: the radius decides how many there are.
 *
 * Usage:
 *   npm run e2e:real                 # keyword "dentist", Los Angeles, 1 tile
 *   npm run e2e:real -- --keep-data  # leave the scraped rows in the database
 */
import {
  api,
  backupDatabase,
  check,
  closeMaps,
  devLog,
  evalMaps,
  launchApp,
  note,
  openPanel,
  pollMaps,
  pollValue,
  preflight,
  printSummary,
  restoreDatabase,
  sleep,
  stopApp,
} from './harness.mjs';

const KEEP_DATA = process.argv.includes('--keep-data');
const KEYWORD = 'dentist';
const CITY = 'Los Angeles';
const CENTER = { lat: 34.0522, lng: -118.2437 };
const TILE_BUDGET_MS = 240_000;
/** Floor, not a target: a downtown 2 km circle holds far more than this on a
 *  normal day, and a thin day must not read as "the parser broke". */
const MIN_ROWS = 5;
const RADIUS_KM = 2;

/** Haversine, in km — the same circle `grid::within_radius` enforces. */
function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function main() {
  await preflight();

  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (!snapshot && !KEEP_DATA) {
    throw new Error('could not snapshot the database; refusing to clear real rows');
  }

  let panel = null;

  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);

    if (snapshot) {
      await call('clear_data');
      await sleep(400);
    } else {
      note('--keep-data: existing rows are kept, so the counts below include them');
    }

    await pollMaps('typeof window.__placemillAutoScroll === "object"', 45_000);

    // Leave the queue empty so `next_queued_job` cannot pick up an old entry.
    for (const job of await call('list_jobs')) {
      if (job.status === 'running') await call('pause_job', { id: job.id }).catch(() => {});
      await call('delete_job', { id: job.id }).catch(() => {});
    }

    const [job] = await call('create_jobs', {
      request: {
        entries: [
          { keyword: KEYWORD, city: CITY, centerLat: CENTER.lat, centerLng: CENTER.lng },
        ],
        radiusKm: RADIUS_KM,
        cellKm: 5,
      },
    });
    check('a one-tile job is queued', job.totalTiles === 1, String(job.totalTiles));

    await call('start_job', { id: job.id });

    ['scroll-start', 'scroll-idle'].forEach((name) => {
      note(`waiting for ${name} on a real search — this is the slow path`);
    });

    // Two legitimate outcomes since M4: a thin result list finishes the job, a
    // dense one (this is downtown LA) hits the split threshold and subdivides.
    // Both mean "the scrape worked"; waiting for `completed` only would hang on
    // the dense case, because its children keep the job running.
    const outcome = await pollValue(
      panel,
      `(async () => {
         const jobs = await window.__TAURI_INTERNALS__.invoke('list_jobs');
         const job = jobs.find((item) => item.id === ${JSON.stringify(job.id)});
         const tiles = await window.__TAURI_INTERNALS__.invoke('get_job_tiles', {
           id: ${JSON.stringify(job.id)},
         });
         if (job && job.status !== 'running') return { job, tile: tiles[0] };
         if (tiles[0] && tiles[0].status === 'split') return { job, tile: tiles[0] };
         return null;
       })()`,
      TILE_BUDGET_MS,
      1000,
    );
    check(
      'the real tile reaches a decision',
      Boolean(outcome),
      outcome ? outcome.tile?.status : 'timeout',
    );

    const tile = outcome?.tile;
    check(
      'the tile collected results (done or subdivided)',
      tile?.status === 'done' || tile?.status === 'split',
      tile?.status ?? 'missing',
    );

    const inserted = outcome?.job?.inserted ?? 0;
    check('rows were inserted by a real search', inserted >= MIN_ROWS, `${inserted} rows`);

    // How much the feed actually delivered, and how much of it the filters took.
    // Without this line a low count is ambiguous: a thin result list, a feed that
    // was cut short, or the radius filter doing its job all look the same.
    const diagnostics = await call('get_diagnostics');
    note(
      `feed: ${diagnostics.records} row(s) seen, ${diagnostics.dropped} dropped ` +
        `(ingress/phone/radius), ${diagnostics.newRecords} stored`,
    );

    if (tile?.status === 'split') {
      // The parent proved the scrape worked; stop the children so the suite does
      // not spend another minute collecting the same neighbourhood.
      note('the cell hit the split threshold; cancelling its children');
      await call('cancel_job', { id: job.id });
    }

    // R-13: `get_businesses` (whole table over the bridge) is gone; the paged
    // query is the only read path, so the acceptance reads the first page.
    const page = await call('query_businesses', {
      request: { page: 1, pageSize: 100 },
    });
    const rows = page.rows;
    check('the database has the scraped rows', rows.length >= MIN_ROWS, `${rows.length} rows`);

    // P2-3: the radius is enforced at write time, and a real feed is the only
    // place where that can be observed — Google keeps loading further away as
    // the page scrolls, so a row kilometres out is the normal case, not a bug.
    const outside = rows.filter((row) => distanceKm(CENTER, row) > RADIUS_KM * 1.01);
    check(
      'every stored row is inside the job radius',
      outside.length === 0,
      outside.length === 0
        ? `${rows.length} rows`
        : outside.map((row) => `${row.name}: ${distanceKm(CENTER, row).toFixed(2)} km`).join('; '),
    );
    check(
      'rows carry a real name',
      Boolean(rows[0]?.name) && rows[0].name.length > 1,
      rows[0]?.name ?? 'none',
    );
    check(
      'rows carry a Google place id',
      Boolean(rows[0]?.place_id) && rows[0].place_id.length > 10,
      rows[0]?.place_id ?? 'none',
    );
    check(
      'rows carry coordinates',
      Boolean(rows[0] && (rows[0].lat !== 0 || rows[0].lng !== 0)),
      rows[0] ? `${rows[0].lat},${rows[0].lng}` : 'none',
    );
    // M8 / J-08b: the index probe showed the category lives at `detail[13]`
    // while `detail[76]` is null, so the `types` column used to be empty in
    // every row. This is the end-to-end proof that the re-map landed.
    check(
      'the category column is populated',
      Array.isArray(rows[0]?.types) && rows[0].types.length > 0,
      JSON.stringify(rows[0]?.types ?? null),
    );

    // M8 / J-08c: the new columns must be filled from the real payload, not
    // just exist. Each field is checked across the whole page, because a
    // single business may legitimately lack one of them.
    const addressed = rows.filter(
      (row) => row.street && row.city && row.state && row.postal_code && row.country,
    );
    check(
      'the structured address columns are populated',
      addressed.length > 0,
      addressed.length
        ? `${addressed.length}/${rows.length} rows, e.g. ${addressed[0].street}, ${addressed[0].city}, ` +
          `${addressed[0].state} ${addressed[0].postal_code}, ${addressed[0].country}`
        : `0/${rows.length} rows`,
    );

    const zoned = rows.filter((row) => row.timezone && row.data_id);
    check(
      'the timezone and data id columns are populated',
      zoned.length > 0,
      zoned.length ? `${zoned.length}/${rows.length}, e.g. ${zoned[0].timezone} / ${zoned[0].data_id}` : 'none',
    );

    const withHours = rows.filter(
      (row) => Array.isArray(row.open_hours) && row.open_hours.length > 0,
    );
    check(
      'the opening hours are structured per weekday',
      withHours.length > 0 &&
        typeof withHours[0].open_hours[0].day === 'string' &&
        Array.isArray(withHours[0].open_hours[0].periods),
      withHours.length ? JSON.stringify(withHours[0].open_hours[0]) : 'none',
    );

    const owned = rows.filter((row) => row.owner_name);
    check(
      'the owner name is stored without the role tag',
      owned.length > 0 && owned.every((row) => !row.owner_name.includes('(Owner)')),
      owned.length ? owned[0].owner_name : 'none',
    );

    const withAbout = rows.filter((row) => Array.isArray(row.about) && row.about.length > 0);
    check(
      'the about block is stored as label/value pairs',
      withAbout.length > 0 &&
        withAbout.every((row) => row.about.every((entry) => entry.key && entry.label)),
      withAbout.length ? JSON.stringify(withAbout[0].about) : 'none',
    );

    const sample = rows.slice(0, 5).map((row) => `${row.name} (${row.phone || 'no phone'})`);
    note(`sample: ${sample.join(' | ')}`);

    // ---- M8 / J-08b: the probe's automatic path --------------------------
    // The probe snapshots the first row of every parsed batch. A real scrape
    // is the only thing that can prove that path works — the deterministic
    // suite never parses a real body.
    const probe = JSON.parse(
      await evalMaps('JSON.stringify(window.__placemillIndexProbe())'),
    );
    check(
      'J-08b: a real batch left a probe snapshot behind',
      probe.ready === true && Array.isArray(probe.records) && probe.records.length > 0,
      probe.ready ? `${probe.records.length} records` : JSON.stringify(probe),
    );

    const probeStep = (want) => {
      const record = (probe.records || []).find((item) => item.want === want);
      return record ? record.steps[record.steps.length - 1] : null;
    };
    const nameStep = probeStep('name');
    check(
      'J-08b: the real payload answers the baseline paths',
      nameStep !== null && nameStep.kind === 'string' && nameStep.sample.length > 0,
      JSON.stringify(nameStep),
    );

    // The rest is information, not an assertion: what the real payload puts
    // at each candidate path is exactly what `docs/parser.md` has
    // to record, and a candidate that comes back empty is a fact about the
    // payload rather than a failure of the code.
    const probeLine = (probe.records || []).map((record) => {
      const last = record.steps[record.steps.length - 1];
      const sample = last.sample === undefined ? '' : `("${String(last.sample).slice(0, 44)}")`;
      return `${record.want}=${last.kind}${sample}[${record.filled}/${record.rows}]`;
    });
    note(`probe (${probeLine.length} candidates):`);
    for (let i = 0; i < probeLine.length; i += 6) {
      note(`  ${probeLine.slice(i, i + 6).join('  ')}`);
    }
  } finally {
    panel?.close();
    closeMaps();
    await stopApp();
    if (snapshot) {
      check('database restored to its pre-run state', restoreDatabase(snapshot));
    }
  }

  const ok = printSummary();
  if (!ok) devLog();
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
