#!/usr/bin/env node
/**
 * E2E acceptance for adaptive quadtree subdivision (roadmap M4).
 *
 * Two behaviours, both against the real app over CDP:
 *
 *   J-04b  a cell with no results ends as `empty` (already true since M2, but
 *          M4 changes what happens to the *other* outcome, so both are pinned
 *          down in one place)
 *   J-04a  a cell that hits the split threshold is replaced by four children of
 *          half the size, marked `split`, with the children queued right after
 *   J-04c  progress counts leaf tiles: after a split the job has 4 tiles, not 5,
 *          so the bar cannot jump backwards
 *
 * The split has to be triggered by a genuinely dense search — a synthetic batch
 * proves the plumbing but cannot prove the threshold fires on a real cap. This
 * suite therefore hits Google once (`dentist` in downtown LA, ~120 rows) and is
 * network-dependent in the same way as `e2e:real`.
 *
 * Usage:
 *   npm run e2e:split
 *   npm run e2e:split -- --keep-data
 */
import {
  api,
  backupDatabase,
  check,
  devLog,
  launchApp,
  note,
  openPanel,
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
/**
 * Split threshold for this suite, lower than the 100 default.
 *
 * Since the write path drops rows outside the job radius, what reaches a cell
 * is "rows inside the circle", and Google caps one search at ~120 rows in
 * total. Measured on downtown LA: a 1 km circle keeps 13, a 3 km circle keeps
 * 56. A threshold of 100 would need the whole feed to be inside the circle,
 * which only happens for very large radii; 40 keeps the suite testing the
 * split mechanism instead of the neighbourhood's dentist density. The value is
 * within the product's own range (20–120).
 */
const THRESHOLD = 40;
const EMPTY_TIMEOUT_MS = 90_000;
const SPLIT_TIMEOUT_MS = 240_000;

/** Tiles of one job, quoted into a pollable expression. */
const tilesExpr = (jobId) => `(async () => {
  const tiles = await window.__TAURI_INTERNALS__.invoke('get_job_tiles', {
    id: ${JSON.stringify(jobId)},
  });
  return tiles;
})()`;

async function main() {
  await preflight();
  note(
    'the split half of this suite needs a genuinely dense search (~120 rows); ' +
      'a consent page or a thin result list will fail it',
  );

  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (!snapshot && !KEEP_DATA) {
    throw new Error('could not snapshot the database; refusing to write real rows');
  }

  let panel = null;

  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);

    // Leave only our jobs in the queue so `start_job` cannot be blocked by a
    // leftover running entry.
    for (const job of await call('list_jobs')) {
      if (job.status === 'running') await call('pause_job', { id: job.id }).catch(() => {});
      await call('delete_job', { id: job.id }).catch(() => {});
    }

    const create = (keyword, radiusKm = 1, cellKm = 5) =>
      call('create_jobs', {
        request: {
          entries: [
            {
              keyword,
              city: 'E2E',
              centerLat: CENTER.lat,
              centerLng: CENTER.lng,
            },
          ],
          radiusKm,
          cellKm,
          splitThreshold: THRESHOLD,
        },
      });

    // ---- J-04b: no results -> empty --------------------------------------
    const [emptyJob] = await create(`e2e-empty-${RUN}`);
    await call('start_job', { id: emptyJob.id });

    const emptyTiles = await pollValue(
      panel,
      `(async () => {
         const tiles = await ${tilesExpr(emptyJob.id)};
         const done = tiles[0] && ['empty', 'done', 'skipped'].includes(tiles[0].status);
         return done ? tiles : null;
       })()`,
      EMPTY_TIMEOUT_MS,
      1000,
    );
    check(
      'a cell with no results ends as empty',
      emptyTiles?.[0]?.status === 'empty',
      emptyTiles?.[0] ? `${emptyTiles[0].status} / ${emptyTiles[0].resultCount} rows` : 'timeout',
    );
    check(
      'the empty cell did not split',
      emptyTiles?.length === 1 && emptyTiles[0].status === 'empty',
      `${emptyTiles?.length ?? 0} tiles`,
    );

    // Wait for the job itself to close: the runner releases its slot a moment
    // later, and a "start" click in between used to be rejected as job_running.
    const emptyClosed = await pollValue(
      panel,
      `(async () => {
         const jobs = await window.__TAURI_INTERNALS__.invoke('list_jobs');
         const job = jobs.find((item) => item.id === ${JSON.stringify(emptyJob.id)});
         return job && job.status === 'completed' ? job : null;
       })()`,
      15_000,
      500,
    );
    check(
      'the empty job completes before the next one starts',
      emptyClosed?.status === 'completed',
      emptyClosed?.status ?? 'timeout',
    );

    // ---- J-04a: a dense cell splits into four ----------------------------
    // 3 km radius at an 8 km cell is a single tile (radius + half a cell is
    // 7 km, so the four neighbours at 8 km fall outside), and `zoom_for_cell`
    // floors 8 km to zoom 14. Cell 10 km would floor to zoom 13, and that wide
    // a viewport measurably changes what Google returns for the same keyword
    // (36 vs ~60 places inside 3 km), so the suite stays on the tighter cell.
    // Downtown LA keeps ~56 rows inside 3 km, which clears `THRESHOLD`.
    const [splitJob] = await create('dentist', 3, 8);
    await call('start_job', { id: splitJob.id });

    const splitTiles = await pollValue(
      panel,
      `(async () => {
         const tiles = await ${tilesExpr(splitJob.id)};
         const parent = tiles.find((tile) => tile.status === 'split');
         return parent ? tiles : null;
       })()`,
      SPLIT_TIMEOUT_MS,
      1000,
    );

    const parent = splitTiles?.find((tile) => tile.status === 'split');
    if (!parent) {
      // A timeout here is either "Google returned fewer rows than the threshold"
      // or a real regression; the tile row tells the two apart.
      const current = await call('get_job_tiles', { id: splitJob.id });
      const diagnostic =
        current.map((tile) => `${tile.id}:${tile.status}/${tile.resultCount}`).join(',') ||
        'no tiles';
      check('a cell at the result cap splits', false, diagnostic);
    } else {
      check(
        'the parent reached the split threshold',
        parent.resultCount >= THRESHOLD,
        `${parent.resultCount} rows`,
      );
      check('the parent is marked split', parent.status === 'split', parent.status);

      const children = splitTiles.filter((tile) => tile.depth === 1);
      check('four children are queued', children.length === 4, String(children.length));
      check(
        'children are half-size (depth 1) and pending or running',
        children.every(
          (tile) =>
            tile.depth === 1 &&
            ['pending', 'running', 'done', 'empty'].includes(tile.status),
        ),
        children.map((tile) => `${tile.status}@${tile.depth}`).join(','),
      );
      check(
        'children hang off the parent id',
        children.every((tile) => tile.id.startsWith(`${parent.id}-q`)),
        children.map((tile) => tile.id).join(','),
      );

      // J-04c: the interior node leaves the denominator.
      const job = (await call('list_jobs')).find((item) => item.id === splitJob.id);
      check(
        'progress counts leaf tiles only',
        job?.totalTiles === 4,
        String(job?.totalTiles),
      );
      check(
        'progress did not run past the new total',
        Boolean(job) && job.doneTiles + job.failedTiles <= job.totalTiles,
        job ? `${job.doneTiles}+${job.failedTiles}/${job.totalTiles}` : 'missing',
      );
    }

    const cancelled = await call('cancel_job', { id: splitJob.id });
    check(
      'a splitting job can be cancelled',
      cancelled.status === 'cancelled',
      cancelled.status,
    );
    await sleep(2000);
  } finally {
    panel?.close();
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
