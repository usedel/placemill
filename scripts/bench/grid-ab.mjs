#!/usr/bin/env node
/**
 * A/B benchmark for roadmap M4's second acceptance item (network-dependent):
 *
 *   A ("blind densification"): a fixed grid at half the base cell size, split
 *                             threshold pinned at the maximum.
 *   B ("adaptive quadtree"):  the base cell size, splitting at 100 results.
 *
 * Same area, same keyword, cleared database before each run, so `inserted` per
 * job is that strategy's unique yield and the tile visits are its request count.
 * Visits count `attempts`, so a retried tile costs what it actually cost.
 *
 * Honesty notes:
 *   - Google cannot be told to stop rewriting URLs mid-scroll, and a 1 km cell
 *     downtown can legitimately hit the viewport cap, so strategy A may split
 *     too (the threshold maxes out at 120). That only makes A cheaper, so the
 *     "B needs fewer requests" conclusion stays conservative. Splits in A are
 *     counted and reported, never hidden.
 *   - One run of each strategy is a sample, not a distribution. Numbers go into
 *     the roadmap as a single measurement, not as a law.
 *
 * Usage:
 *   npm run bench:grid-ab
 */
import {
  api,
  backupDatabase,
  check,
  closeMaps,
  devLog,
  launchApp,
  note,
  openPanel,
  pollMaps,
  preflight,
  printSummary,
  restoreDatabase,
  sleep,
  stopApp,
} from '../e2e/harness.mjs';

const KEYWORD = 'dentist';
const CITY = 'Los Angeles';
const CENTER = { lat: 34.0522, lng: -118.2437 };
const RADIUS_KM = 2;
const BASE_CELL_KM = 2;

const STRATEGIES = [
  {
    name: 'A blind (fixed 1 km grid)',
    cellKm: BASE_CELL_KM / 2,
    splitThreshold: 120,
  },
  {
    name: 'B adaptive (2 km + quadtree)',
    cellKm: BASE_CELL_KM,
    splitThreshold: 100,
  },
];

function budgetFor(plannedTiles) {
  // 45 s per tile covers a slow viewport; the floor keeps one-tile runs honest.
  return Math.max(15 * 60_000, plannedTiles * 45_000 + 300_000);
}

function summarize(tiles, job, planned, elapsedMs) {
  const leaves = tiles.filter((tile) => tile.status !== 'split');
  const visited = leaves.filter((tile) =>
    ['done', 'empty', 'skipped'].includes(tile.status),
  );
  const attempts = visited.reduce((sum, tile) => sum + (tile.attempts || 1), 0);
  const doneWithRows = visited.filter((tile) => tile.status === 'done');
  const maxResultCount = Math.max(0, ...visited.map((tile) => tile.resultCount || 0));
  return {
    plannedTiles: planned,
    leaves: leaves.length,
    visits: visited.length,
    attempts,
    splitTiles: tiles.length - leaves.length,
    failed: leaves.filter((tile) => tile.status === 'skipped').length,
    rows: job.inserted,
    maxResultCount,
    capped: doneWithRows.filter((tile) => (tile.resultCount || 0) >= 100).length,
    elapsedMinutes: Math.round(elapsedMs / 6000) / 10,
  };
}

function printRow(name, stats) {
  console.log(
    `${name.padEnd(28)} tiles=${String(stats.visits).padStart(3)}` +
      ` (attempts ${String(stats.attempts).padStart(3)})` +
      ` rows=${String(stats.rows).padStart(5)}` +
      ` splits=${stats.splitTiles}` +
      ` failed=${stats.failed}` +
      ` capped=${stats.capped}` +
      ` max=${stats.maxResultCount}` +
      ` ${stats.elapsedMinutes} min`,
  );
}

/** Hard ceiling for one strategy, however much the quadtree grows. */
const MAX_RUN_MS = 30 * 60_000;

/**
 * Wait for a job to leave `running`, printing a heartbeat so long runs do not
 * look (and get killed as) dead. Every 2 s a cheap `list_jobs`; every 20 s a
 * one-line progress report.
 *
 * The deadline extends whenever M4 grows the leaf count — a budget planned from
 * the base grid would kill a healthy job mid-flight — but never past
 * `MAX_RUN_MS`. A self-paused job (dead-page watchdog) is a hard error: the
 * numbers would be garbage and the page needs a human.
 */
async function waitForJob(call, jobId, budgetMs, label) {
  const started = Date.now();
  const hardDeadline = started + MAX_RUN_MS;
  let deadline = started + budgetMs;
  let lastBeat = 0;
  let lastLeaves = 0;
  for (;;) {
    const job = (await call('list_jobs')).find((item) => item.id === jobId);
    if (job && job.status !== 'running') {
      if (job.status === 'paused') {
        throw new Error(
          `${label}: the job paused itself (dead-page watchdog) — the maps page ` +
            'stopped responding; handle that page and rerun the benchmark',
        );
      }
      return job;
    }

    const tiles = await call('get_job_tiles', { id: jobId });
    const leaves = tiles.filter((tile) => tile.status !== 'split').length;
    if (leaves > lastLeaves) {
      lastLeaves = leaves;
      deadline = Math.min(hardDeadline, Math.max(deadline, Date.now() + budgetFor(leaves)));
    }

    const now = Date.now();
    if (now > deadline) {
      await call('cancel_job', { id: jobId }).catch(() => {});
      throw new Error(`${label}: exceeded its time budget (${leaves} leaves)`);
    }
    if (now - lastBeat > 20_000) {
      lastBeat = now;
      const visited = tiles.filter((tile) =>
        ['done', 'empty', 'skipped'].includes(tile.status),
      ).length;
      console.log(
        `TICK  ${label}: ${visited}/${leaves} leaves visited, ` +
          `${job?.inserted ?? 0} rows, ${Math.round((now - started) / 6000) / 10} min`,
      );
    }
    await sleep(2000);
  }
}

async function runStrategy(call, panel, strategy) {
  const plan = await call('plan_grid', {
    centerLat: CENTER.lat,
    centerLng: CENTER.lng,
    radiusKm: RADIUS_KM,
    cellKm: strategy.cellKm,
  });
  note(`${strategy.name}: ${plan.tiles} tiles planned, cell ${plan.cellKm} km`);

  const started = Date.now();
  const [job] = await call('create_jobs', {
    request: {
      entries: [
        { keyword: KEYWORD, city: CITY, centerLat: CENTER.lat, centerLng: CENTER.lng },
      ],
      radiusKm: RADIUS_KM,
      cellKm: strategy.cellKm,
      splitThreshold: strategy.splitThreshold,
    },
  });
  await call('start_job', { id: job.id });

  let finished;
  try {
    finished = await waitForJob(
      call,
      job.id,
      budgetFor(plan.tiles),
      strategy.name.slice(0, 1),
    );
  } catch (error) {
    throw new Error(error.message);
  }

  const tiles = await call('get_job_tiles', { id: job.id });
  const stats = summarize(tiles, finished, plan.tiles, Date.now() - started);
  check(
    `${strategy.name}: the job completed`,
    finished.status === 'completed',
    finished.status,
  );
  return stats;
}

/** Reset between strategies so `inserted` and visits are per-strategy. */
async function resetWorkspace(call) {
  for (const job of await call('list_jobs')) {
    if (job.status === 'running') await call('pause_job', { id: job.id }).catch(() => {});
    await call('delete_job', { id: job.id }).catch(() => {});
  }
  // A job that refuses to die means another app instance is driving the map
  // against the same database; the numbers would be meaningless.
  const leftover = (await call('list_jobs')).filter((job) => job.status === 'running');
  if (leftover.length > 0) {
    throw new Error(
      `a job is still running after a pause+delete (${leftover
        .map((job) => job.id)
        .join(', ')}) — close other PlaceMill windows and rerun`,
    );
  }
  await call('clear_data');
  await sleep(500);
}

async function main() {
  await preflight();

  const snapshot = backupDatabase();
  if (!snapshot) {
    throw new Error('could not snapshot the database; refusing to clear real rows');
  }

  const results = [];
  let panel = null;

  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);
    await pollMaps('typeof window.__placemillAutoScroll === "object"', 45_000);

    for (const strategy of STRATEGIES) {
      await resetWorkspace(call);
      const stats = await runStrategy(call, panel, strategy);
      results.push({ name: strategy.name, ...stats });
      printRow(strategy.name, stats);
    }

    const [blind, adaptive] = results;
    const requestDelta = 1 - adaptive.attempts / blind.attempts;
    const coverage = blind.rows > 0 ? adaptive.rows / blind.rows : 0;

    note(
      `requests: ${blind.attempts} (A) vs ${adaptive.attempts} (B) -> ` +
        `${Math.round(requestDelta * 100)}% ${requestDelta >= 0 ? 'fewer' : 'more'}`,
    );
    note(
      `yield: ${blind.rows} (A) vs ${adaptive.rows} (B) -> ` +
        `${Math.round(coverage * 100)}% of the blind grid`,
    );

    // The acceptance line (roadmap M4): at least 30% fewer requests at
    // comparable coverage. Comparable means within 10% of the blind yield —
    // the blind grid is denser by construction, so it may legally find a few
    // extra places in sparse corners.
    check(
      'adaptive needs at least 30% fewer requests than blind densification',
      requestDelta >= 0.3,
      `${Math.round(requestDelta * 100)}%`,
    );
    check(
      'adaptive collects comparable data (>= 90% of blind)',
      coverage >= 0.9,
      `${Math.round(coverage * 100)}%`,
    );
    check(
      'no strategy left cells capped at the viewport limit',
      adaptive.capped === 0,
      `A: ${blind.capped}, B: ${adaptive.capped}`,
    );
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
