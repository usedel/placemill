#!/usr/bin/env node
/**
 * E2E acceptance for the job queue and crash-resume (roadmap M3).
 *
 * What it proves, against the real app over CDP:
 *   J-03a/b  jobs and tiles are written to SQLite and survive a restart
 *   J-03c    a queue is single-flight: finishing job A starts job B, not C
 *   J-03d    a hard kill mid-tile comes back as `paused`, and resume continues
 *            from the next pending tile instead of re-running finished ones
 *   cancel   a resumed job can still be cancelled; a queued job stays queued
 *
 * Tiles are ended by calling `__placemillAutoScroll.stop('idle')` from CDP as
 * soon as they start, so the suite does not wait for Google to exhaust a real
 * result list. The keyword is randomised, so there is usually nothing to scroll
 * at all — the point is the state machine, not the scrape.
 *
 * Usage:
 *   npm run e2e:queue
 *   npm run e2e:queue -- --keep-data
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
const RUN = Date.now();
const CENTER = { lat: 34.0522, lng: -118.2437 };

const findJob = (jobs, id) => jobs.find((job) => job.id === id);

/** End whatever tile is scrolling right now (a no-op before the script starts). */
const stopTile = () =>
  evalMaps(
    `(() => {
       try {
         if (!window.__placemillAutoScroll) return false;
         window.__placemillAutoScroll.stop('idle');
         return true;
       } catch (e) { return false; }
     })()`,
  ).catch(() => false);

/** Poll the queue, ending each tile as soon as it starts, until `predicate` holds. */
async function pumpUntil(call, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let jobs = [];
  while (Date.now() < deadline) {
    await stopTile();
    jobs = await call('list_jobs');
    if (predicate(jobs)) return jobs;
    await sleep(500);
  }
  return jobs;
}

async function phaseQueue(panel) {
  const call = api(panel);

  await call('clear_data');
  await sleep(400);
  await pollMaps('typeof window.__placemillAutoScroll === "object"', 45_000);

  // The database is shared with real usage. Leave it exactly as found: pause a
  // running job so it can be deleted, then drop every job (rows are kept).
  const existing = await call('list_jobs');
  for (const job of existing) {
    if (job.status === 'running') {
      await call('pause_job', { id: job.id }).catch(() => {});
    }
    await call('delete_job', { id: job.id }).catch(() => {});
  }

  const entries = (keyword) => [
    { keyword, city: 'E2E', centerLat: CENTER.lat, centerLng: CENTER.lng },
  ];

  const [a] = await call('create_jobs', {
    request: { entries: entries(`e2e-a-${RUN}`), radiusKm: 1, cellKm: 5 },
  });
  const [b] = await call('create_jobs', {
    request: { entries: entries(`e2e-b-${RUN}`), radiusKm: 0.5, cellKm: 0.5 },
  });
  const [c] = await call('create_jobs', {
    request: { entries: entries(`e2e-c-${RUN}`), radiusKm: 1, cellKm: 5 },
  });

  check('three jobs enqueued', Boolean(a && b && c));
  check(
    'a fresh queue is entirely queued',
    a.status === 'queued' && b.status === 'queued' && c.status === 'queued',
  );
  // radius 1 / cell 5 collapses to the centre tile; radius 0.5 / cell 0.5 keeps
  // the 3x3 block (diagonals are 0.707 km, inside radius + half a cell).
  check(
    'each request generates its own grid size',
    a.totalTiles === 1 && b.totalTiles === 9 && c.totalTiles === 1,
    `${a.totalTiles}/${b.totalTiles}/${c.totalTiles}`,
  );

  await call('start_job', { id: a.id });
  const afterA = await pumpUntil(
    call,
    (jobs) => findJob(jobs, a.id)?.status === 'completed',
    60_000,
  );
  check(
    'the first job completes',
    findJob(afterA, a.id)?.status === 'completed',
    findJob(afterA, a.id)?.status,
  );

  const afterChain = await pumpUntil(
    call,
    (jobs) => findJob(jobs, b.id)?.status === 'running',
    20_000,
  );
  check(
    'the worker chains to the next queued job',
    findJob(afterChain, b.id)?.status === 'running',
    findJob(afterChain, b.id)?.status,
  );
  check(
    'a later queued job is not started early',
    findJob(afterChain, c.id)?.status === 'queued',
    findJob(afterChain, c.id)?.status,
  );
  // The worker owns the switch for the whole queue: finishing A must not leave
  // the chained job B running with collection off (the old code only worked
  // because nothing ever turned it off).
  const chainedState = await call('get_collector_state');
  check(
    'the chained job keeps collecting',
    chainedState.listening === true,
    String(chainedState.listening),
  );

  const beforeKill = await pumpUntil(
    call,
    (jobs) => (findJob(jobs, b.id)?.doneTiles ?? 0) >= 1,
    60_000,
  );
  const doneBeforeKill = findJob(beforeKill, b.id)?.doneTiles ?? 0;
  check(
    'the second job finished a tile before the kill',
    doneBeforeKill >= 1,
    String(doneBeforeKill),
  );

  return { a: a.id, b: b.id, c: c.id, doneBeforeKill };
}

async function phaseResume(panel, ids) {
  const call = api(panel);
  const jobs = await call('list_jobs');

  check(
    'a completed job survives the restart',
    findJob(jobs, ids.a)?.status === 'completed',
    findJob(jobs, ids.a)?.status,
  );
  check(
    'the interrupted job comes back paused',
    findJob(jobs, ids.b)?.status === 'paused',
    findJob(jobs, ids.b)?.status,
  );
  check(
    'recovery does not auto-start the queued job',
    findJob(jobs, ids.c)?.status === 'queued',
    findJob(jobs, ids.c)?.status,
  );
  check(
    'progress survived the restart',
    findJob(jobs, ids.b)?.doneTiles === ids.doneBeforeKill,
    `${findJob(jobs, ids.b)?.doneTiles}/${ids.doneBeforeKill}`,
  );

  const tiles = await call('get_job_tiles', { id: ids.b });
  check(
    'finished tiles stay done',
    tiles
      .slice(0, ids.doneBeforeKill)
      .every((tile) => tile.status === 'done' || tile.status === 'empty'),
    tiles.map((tile) => tile.status).join(','),
  );
  check(
    'the next tile is pending again',
    tiles.find((tile) => tile.seq === ids.doneBeforeKill)?.status === 'pending',
    String(tiles.find((tile) => tile.seq === ids.doneBeforeKill)?.status),
  );

  const banner = await pollValue(
    panel,
    `document.querySelector('.resume-banner') !== null`,
    10_000,
  );
  check('the panel offers to continue the paused job', banner === true);

  const resumed = await call('resume_job', { id: ids.b });
  check('resume flips the job back to running', resumed.status === 'running', resumed.status);

  const expectedSuffix = `-t${ids.doneBeforeKill}`;
  const currentTile = await pollValue(
    panel,
    `(async () => {
       const jobs = await window.__TAURI_INTERNALS__.invoke('list_jobs');
       const job = jobs.find((item) => item.id === ${JSON.stringify(ids.b)});
       return job && job.currentTile;
     })()`,
    30_000,
  );
  check(
    'resume continues from the next pending tile',
    typeof currentTile === 'string' && currentTile.endsWith(expectedSuffix),
    String(currentTile),
  );

  const cancelled = await call('cancel_job', { id: ids.b });
  check('a resumed job can still be cancelled', cancelled.status === 'cancelled', cancelled.status);

  // The reported bug: cancelling a running task left the switch on, so the
  // panel kept saying "collecting" and the liveness card warned about a map
  // nothing was collecting from.
  const afterCancel = await call('get_collector_state');
  check(
    'cancelling a running job turns the switch off',
    afterCancel.listening === false,
    String(afterCancel.listening),
  );

  const after = await call('list_jobs');
  check(
    'cancelling does not start the queued job',
    findJob(after, ids.c)?.status === 'queued',
    findJob(after, ids.c)?.status,
  );
}

async function main() {
  await preflight();

  note(
    'synthetic keyword by design: tiles are ended from CDP so the state machine ' +
      'can be tested in seconds. Run `npm run e2e:real` for a genuine search.',
  );
  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (KEEP_DATA) note('--keep-data: synthetic jobs and rows will stay');
  const canIsolate = Boolean(snapshot);
  if (!canIsolate) {
    throw new Error('this suite deletes jobs to isolate the queue; refusing without a snapshot');
  }

  let panel = null;
  let ids = null;

  try {
    await launchApp();
    panel = await openPanel();
    ids = await phaseQueue(panel);

    // Hard kill in the middle of the second job.
    panel.close();
    panel = null;
    closeMaps();
    check('app killed mid-job', true);
    await stopApp();

    await launchApp();
    panel = await openPanel();
    await phaseResume(panel, ids);
  } finally {
    panel?.close();
    closeMaps();
    await stopApp();
    check('database restored to its pre-run state', restoreDatabase(snapshot));
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
