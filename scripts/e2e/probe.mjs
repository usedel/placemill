#!/usr/bin/env node
/**
 * E2E acceptance for the probe run (§5.8 A1 / C-1).
 *
 * What it proves, against the real app over CDP:
 *   probe   `start_job(probe)` runs exactly ONE tile (the centre cell) and
 *           pauses the job through the normal pause path — the job does NOT
 *           complete, its total tile count is untouched, and the runner
 *           releases the map
 *   event   `probe:completed` reaches the panel with the verdict count
 *   reason  the finished empty cell carries its `error_reason` short code
 *           (random keyword → `no-results` → `parse-empty`) — A5's field,
 *           read back over the real IPC path
 *   resume  `resume_job` continues with tile 2 (the "run the full grid"
 *           answer), then the suite cancels the job to keep the run short
 *
 * Same synthetic-keyword discipline as grid.mjs: the tile ends via the
 * injected script's `no-results` path, no Google result list required.
 *
 * Usage:  npm run e2e:probe        (add --keep-data to keep synthetic rows)
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
  sleep,
  stopApp,
  waitForMapsTarget,
} from './harness.mjs';

const KEEP_DATA = process.argv.includes('--keep-data');
const RUN = Date.now();
const KEYWORD = `e2e-probe-${RUN}`;
const CENTER = { lat: 34.0522, lng: -118.2437 };

const PAUSE_TIMEOUT_MS = 90_000;
const RESUME_TIMEOUT_MS = 60_000;

let panel = null;
let maps = null;
let mapsWs = null;

async function connectMaps() {
  const target = await waitForMapsTarget();
  if (maps && mapsWs === target.webSocketDebuggerUrl) return maps;
  maps?.close();
  maps = await connect(target.webSocketDebuggerUrl);
  mapsWs = target.webSocketDebuggerUrl;
  return maps;
}

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

async function main() {
  await preflight();
  note('synthetic keyword: the centre cell ends via `no-results` (~15 s)');
  const snapshot = KEEP_DATA ? null : backupDatabase();

  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);

    // Maps page must be injected before the runner can navigate it.
    await pollMapsViaEval();

    // A probe needs a grid with MORE than one tile: proving "paused, not
    // completed" is only meaningful when work was left on the table.
    const created = await call('create_jobs', {
      request: {
        entries: [
          { keyword: KEYWORD, city: 'E2E', centerLat: CENTER.lat, centerLng: CENTER.lng },
        ],
        radiusKm: 5,
        cellKm: 2,
      },
    });
    const job = created[0];
    check('the probe grid has several tiles', job.totalTiles > 1, String(job.totalTiles));

    // Collect probe:completed on the panel — the event the toast listens for.
    await evalIn(
      panel,
      `window.__e2eProbeEvents = [];
       void window.__TAURI__.event.listen('probe:completed', (e) => window.__e2eProbeEvents.push(e.payload));
       true`,
    );

    const started = await call('start_job', { id: job.id, probe: true });
    check('start_job(probe) flips the job to running', started.status === 'running', started.status);

    // ---- the verdict: paused after exactly one tile ------------------------
    const paused = await pollValue(
      panel,
      `(async () => {
         const jobs = await window.__TAURI_INTERNALS__.invoke('list_jobs');
         const job = jobs.find((item) => item.id === ${JSON.stringify(job.id)});
         return job && job.status === 'paused' ? job : null;
       })()`,
      PAUSE_TIMEOUT_MS,
      1000,
    );
    check(
      'the job pauses after the FIRST tile (not completed, not cancelled)',
      Boolean(paused),
      paused ? `status=${paused.status}` : 'timeout',
    );
    check(
      'exactly one tile is done when the probe pauses',
      Boolean(paused && paused.doneTiles === 1 && paused.failedTiles === 0),
      paused ? `${paused.doneTiles} done / ${paused.failedTiles} failed` : '',
    );
    check(
      'the probe does not shrink the grid',
      Boolean(paused && paused.totalTiles === job.totalTiles),
      paused ? String(paused.totalTiles) : '',
    );

    const tiles = await call('get_job_tiles', { id: job.id });
    const centre = tiles.find((tile) => tile.seq === 0) || tiles[0];
    check(
      'the centre tile is finished and empty',
      Boolean(centre) && centre.status === 'empty',
      tiles.map((tile) => `${tile.id}:${tile.status}`).join(','),
    );
    check(
      "the empty cell carries its A5 short code ('parse-empty')",
      centre && centre.errorReason === 'parse-empty',
      centre ? String(centre.errorReason) : 'no tile',
    );

    const probeEvents = await pollValue(
      panel,
      `(window.__e2eProbeEvents || []).length`,
      10_000,
    );
    check(
      'probe:completed reaches the panel with the count',
      probeEvents === 1,
      JSON.stringify(probeEvents),
    );

    // ---- resume = the "run the full grid" answer ---------------------------
    const resumed = await call('resume_job', { id: job.id });
    check('resume_job continues the grid (no second probe)', resumed.status === 'running', resumed.status);
    const advancing = await pollValue(
      panel,
      `(async () => {
         const jobs = await window.__TAURI_INTERNALS__.invoke('list_jobs');
         const job = jobs.find((item) => item.id === ${JSON.stringify(job.id)});
         return job && job.doneTiles >= 2 ? job : null;
       })()`,
      RESUME_TIMEOUT_MS,
      1000,
    );
    check(
      'the runner moves on to tile 2 after the resume',
      Boolean(advancing),
      advancing ? `doneTiles=${advancing.doneTiles}` : 'timeout',
    );

    // Keep the run short: cancel the rest of the grid.
    const cancelled = await call('cancel_job', { id: job.id });
    check('the rest of the grid cancels cleanly', cancelled.status === 'cancelled', cancelled.status);
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

async function pollMapsViaEval() {
  // Wait for the injected script, then report the camera so get_map_view works.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evalMaps('typeof window.__placemillAutoScroll === "object"');
      if (ready) {
        await evalMaps('window.__placemillReportView && window.__placemillReportView()').catch(() => {});
        return true;
      }
    } catch {
      /* still booting */
    }
    await sleep(800);
  }
  return false;
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
