#!/usr/bin/env node
/**
 * E2E acceptance for area collection (roadmap milestone M2).
 *
 * What it proves, against the real app over CDP:
 *   J-02a  `plan_grid` geometry through the real IPC path (tile counts, zoom,
 *          the too-large guard)
 *   J-02b  the runner navigates the Maps webview to the first tile and finishes
 *          the job when the injected script reports the cell as done
 *   J-02c  `__placemillGoto` + the sessionStorage tile context survive the
 *          navigation, and `maps:view` reaches Rust
 *   cancel  `cancel_grid_job` wins the race: the job stays cancelled and is not
 *          flipped to completed by the runner
 *
 * The keyword is randomised so the tile almost certainly has no results. That
 * exercises the `no-results` path (~15 s) instead of waiting for Google to load
 * a real result list, and it keeps the run independent of what Maps returns
 * today. Per-tile row counting is fed by a synthetic `business-data` batch.
 *
 * Usage:
 *   npm run e2e:grid
 *   npm run e2e:grid -- --keep-data   # leave synthetic rows in place
 */
import {
  api,
  backupDatabase,
  check,
  connect,
  devLog,
  evalIn,
  launchApp,
  note,
  openPanel,
  pollValue,
  preflight,
  printSummary,
  restoreDatabase,
  skip,
  sleep,
  stopApp,
  waitForMapsTarget,
} from './harness.mjs';

const KEEP_DATA = process.argv.includes('--keep-data');
const RUN = Date.now();
const KEYWORD = `e2e-grid-${RUN}`;
const CENTER = { lat: 34.0522, lng: -118.2437 };
const PLACE_ID = `E2E_GRID_${RUN}`;

const TILE_TIMEOUT_MS = 90_000;

let panel = null;
let maps = null;
let mapsWs = null;

/** (Re)attach to the Maps target; a full navigation may hand us a new one. */
async function connectMaps() {
  const target = await waitForMapsTarget();
  if (maps && mapsWs === target.webSocketDebuggerUrl) return maps;
  maps?.close();
  maps = await connect(target.webSocketDebuggerUrl);
  mapsWs = target.webSocketDebuggerUrl;
  return maps;
}

/** Evaluate in the Maps page, re-attaching once if the context was replaced. */
async function evalMaps(expression) {
  try {
    return await evalIn(await connectMaps(), expression);
  } catch (error) {
    maps?.close();
    maps = null;
    mapsWs = null;
    return evalIn(await connectMaps(), expression);
  }
}

/**
 * Poll the Maps page across navigations. A plain `pollValue` would give up on
 * the first destroyed execution context, which is exactly what a tile
 * navigation causes.
 */
async function pollMaps(expression, timeoutMs, intervalMs = 400) {
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

async function main() {
  await preflight();

  note(
    'synthetic keyword by design: this suite proves the queue/state machine, ' +
      'not the scrape. Run `npm run e2e:real` for a genuine search.',
  );
  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (KEEP_DATA) note('--keep-data: synthetic rows will stay in the database');
  const canIsolate = Boolean(snapshot);

  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);

    if (canIsolate) {
      await call('clear_data');
      await sleep(400);
    } else {
      skip('deterministic starting state', 'no database snapshot, refusing to clear real rows');
    }

    // ---- J-02c: map view reporting ---------------------------------------
    // Navigate to a known camera first: the home URL has no `@lat,lng,zoom`, so
    // there would be nothing to parse and the check would test the wrong thing.
    await pollMaps('typeof window.__placemillAutoScroll === "object"', 45_000);
    await evalMaps(
      `location.href = 'https://www.google.com/maps/@${CENTER.lat},${CENTER.lng},15z?hl=en'`,
    ).catch(() => {});
    await sleep(2500);
    await pollMaps('typeof window.__placemillAutoScroll === "object"', 45_000);
    await evalMaps('window.__placemillReportView && window.__placemillReportView()').catch(() => {});

    const view = await pollValue(
      panel,
      `window.__TAURI_INTERNALS__.invoke('get_map_view')`,
      15_000,
    );
    check(
      'maps:view reaches Rust',
      Boolean(view && Math.abs(view.lat - CENTER.lat) < 0.05 && Math.abs(view.lng - CENTER.lng) < 0.05),
      view ? `${view.lat.toFixed(4)}, ${view.lng.toFixed(4)} z${view.zoom}` : 'no view',
    );

    // ---- J-02a: plan_grid -------------------------------------------------
    const plan = await call('plan_grid', {
      centerLat: CENTER.lat,
      centerLng: CENTER.lng,
      radiusKm: 5,
      cellKm: 2,
    });
    check(
      'plan_grid returns a realistic tile count',
      plan.tiles >= 15 && plan.tiles <= 40,
      `${plan.tiles} tiles`,
    );
    check('plan_grid picks the matching zoom', plan.zoom === 16, String(plan.zoom));
    check(
      'plan_grid estimates a duration',
      plan.estimatedSeconds === plan.tiles * 20,
      `${plan.estimatedSeconds}s`,
    );

    const tooLarge = await evalIn(
      panel,
      `(async () => {
         try {
           await window.__TAURI_INTERNALS__.invoke('plan_grid', {
             centerLat: 0, centerLng: 0, radiusKm: 20, cellKm: 0.5,
           });
           return 'NO_ERROR';
         } catch (e) { return 'ERR:' + String(e); }
       })()`,
    );
    check(
      'plan_grid rejects an oversized area',
      String(tooLarge).includes('grid_too_large'),
      String(tooLarge).slice(0, 60),
    );

    // ---- Dialog wiring ----------------------------------------------------
    // The dialog is thin over the commands, but the command names and argument
    // shapes are exactly the kind of thing that breaks silently, so open it for
    // real and read the preview line it rendered.
    const opened = await evalIn(
      panel,
      `(() => {
         const icon = document.querySelector('.brand-bar .anticon-plus');
         const button = icon && icon.closest('button');
         if (!button) return false;
         button.click();
         return true;
       })()`,
    );
    check('header button opens the area dialog', opened === true);

    const planLine = await pollValue(
      panel,
      `(document.querySelector('.grid-plan') || {}).textContent || ''`,
      15_000,
    );
    check(
      'dialog previews the tile count and duration',
      typeof planLine === 'string' && /\d/.test(planLine),
      String(planLine),
    );
    // The preview must not report a zero-minute estimate: with 29 cells it took
    // the keyword count as 0 and rendered "· 0 min".
    check(
      'the preview duration is not zero',
      typeof planLine === 'string' && !/·\s*0\s*(min|分钟)/.test(planLine),
      String(planLine),
    );

    const closed = await evalIn(
      panel,
      `(() => {
         const modal = document.querySelector('.ant-modal');
         const close = modal && modal.querySelector('.ant-modal-close');
         if (!close) return false;
         close.click();
         return true;
       })()`,
    );
    check('dialog can be closed', closed === true);
    await sleep(500);

    // ---- J-02b: create + start a one-tile job ----------------------------
    // radius 1 km with 5 km cells collapses to exactly one tile at the centre.
    const created = await call('create_jobs', {
      request: {
        entries: [
          { keyword: KEYWORD, city: 'E2E', centerLat: CENTER.lat, centerLng: CENTER.lng },
        ],
        radiusKm: 1,
        cellKm: 5,
      },
    });
    const job = created[0];
    check('create_jobs creates a single-tile job', job.totalTiles === 1, String(job.totalTiles));
    check('a new job starts queued', job.status === 'queued', job.status);

    // The queue list relies on this event; polling alone would still pass if the
    // emit silently disappeared.
    await evalIn(
      panel,
      `window.__e2eJobEvents = [];
       void window.__TAURI__.event.listen('job:progress', (e) => window.__e2eJobEvents.push(e.payload));
       true`,
    );

    const startedJob = await call('start_job', { id: job.id });
    check('start_job flips the job to running', startedJob.status === 'running', startedJob.status);

    const href = await pollMaps(
      `location.href.includes('/maps/search/') ? location.href : ''`,
      30_000,
    );
    check(
      'runner navigates to the tile search',
      typeof href === 'string' && href.includes('/maps/search/') && href.includes(',14z'),
      String(href).slice(0, 90),
    );

    const context = await pollMaps(`sessionStorage.getItem('placemill.tileContext')`, 30_000);
    // Tile ids are `{jobId}-t{seq}` since M3, so matching the bare `t0` would
    // accept a context from a different job.
    let parsedContext = null;
    try {
      parsedContext = JSON.parse(context);
    } catch {
      parsedContext = null;
    }
    check(
      'tile context survives the navigation',
      parsedContext?.tileId === `${job.id}-t0`,
      String(context),
    );

    // Feed the current tile so the job's `received` counter has something to
    // show. Not a scraping assertion: Google's own results are out of scope.
    if (canIsolate) {
      await evalMaps(
        `window.__TAURI__.event.emit('business-data', {
           businesses: [{
             name: 'E2E_GRID_ROW', address: '1 E2E Street', phone: '+1 555 0100',
             rating: 4.1, reviews_total: 7, lat: ${CENTER.lat}, lng: ${CENTER.lng},
             place_id: '${PLACE_ID}', website: '', types: ['e2e']
           }],
           sourceQuery: '${KEYWORD}', jobId: ${JSON.stringify(job.id)},
           tileId: ${JSON.stringify(parsedContext?.tileId ?? `${job.id}-t0`)}
         })`,
      ).catch(() => {});

      const counted = await pollValue(
        panel,
        `(async () => {
           const jobs = await window.__TAURI_INTERNALS__.invoke('list_jobs');
           const job = jobs.find((item) => item.id === ${JSON.stringify(job.id)});
           return job && job.inserted > 0;
         })()`,
        15_000,
      );
      check('rows are attributed to the running job', counted === true);

      // The radius is enforced in Rust, not by the grid: Google's result feed
      // keeps loading further away as the page scrolls, so a 1 km job really
      // does receive rows kilometres out. This row is 10 km out and must be
      // counted as dropped rather than stored.
      const outsideTileId = JSON.stringify(parsedContext?.tileId ?? job.id + '-t0');
      await evalMaps(
        `window.__TAURI__.event.emit('business-data', {
           businesses: [{
             name: 'E2E_OUTSIDE_ROW', address: '10 km out', phone: '',
             rating: 0, reviews_total: 0,
             lat: ${CENTER.lat + 0.1}, lng: ${CENTER.lng},
             place_id: 'E2E_OUTSIDE_${RUN}', website: '', types: ['e2e']
           }],
           sourceQuery: '${KEYWORD}', jobId: ${JSON.stringify(job.id)},
           tileId: ${outsideTileId}
         })`,
      ).catch(() => {});
      await sleep(2000);
      const afterOutside = (await call('list_jobs')).find((item) => item.id === job.id);
      check(
        'a row outside the job radius is dropped',
        Boolean(afterOutside) && afterOutside.inserted === 1,
        afterOutside ? `inserted=${afterOutside.inserted}` : '',
      );
    }

    const finished = await pollValue(
      panel,
      `(async () => {
         const jobs = await window.__TAURI_INTERNALS__.invoke('list_jobs');
         const job = jobs.find((item) => item.id === ${JSON.stringify(job.id)});
         return job && job.status !== 'running' ? job : null;
       })()`,
      TILE_TIMEOUT_MS,
      1000,
    );
    check(
      'job completes when the cell reports done',
      Boolean(finished && finished.status === 'completed'),
      finished ? finished.status : 'timeout',
    );
    check(
      'completed job counts the tile',
      Boolean(finished && finished.doneTiles === 1 && finished.failedTiles === 0),
      finished ? `${finished.doneTiles} done / ${finished.failedTiles} failed` : '',
    );

    const tiles = await call('get_job_tiles', { id: job.id });
    check(
      'the tile is persisted as done',
      tiles.length === 1 && tiles[0].status === 'done',
      tiles.map((tile) => `${tile.id}:${tile.status}`).join(','),
    );

    const progressEvents = await evalIn(
      panel,
      `(window.__e2eJobEvents || []).filter((event) => event.id === ${JSON.stringify(job.id)}).length`,
    );
    check(
      'job:progress reaches the panel',
      typeof progressEvents === 'number' && progressEvents > 0,
      String(progressEvents),
    );

    // ---- cancel wins the race --------------------------------------------
    const secondCreated = await call('create_jobs', {
      request: {
        entries: [
          {
            keyword: `${KEYWORD}-cancel`,
            city: 'E2E',
            centerLat: CENTER.lat,
            centerLng: CENTER.lng,
          },
        ],
        radiusKm: 1,
        cellKm: 5,
      },
    });
    const second = await call('start_job', { id: secondCreated[0].id });
    check('second job was created and started', second.status === 'running', second.status);

    const cancelled = await call('cancel_job', { id: second.id });
    check(
      'cancel marks the job as cancelled',
      cancelled.status === 'cancelled',
      cancelled.status,
    );
    await sleep(4000);
    const afterwards = (await call('list_jobs')).find((item) => item.id === second.id);
    check(
      'a cancelled job stays cancelled',
      afterwards?.status === 'cancelled',
      afterwards?.status ?? 'missing',
    );
    check(
      'cancel keeps the tile tally',
      Boolean(afterwards) && afterwards.doneTiles + afterwards.failedTiles <= 1,
    );
  } finally {
    maps?.close();
    panel?.close();
    await stopApp();
    if (KEEP_DATA) {
      note('--keep-data: database left as it is');
    } else if (snapshot) {
      check('database restored to its pre-run state', restoreDatabase(snapshot));
    } else {
      note('no snapshot existed before the run: nothing to restore');
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
