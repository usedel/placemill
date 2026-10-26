#!/usr/bin/env node
/**
 * E2E acceptance for task-centric collection (P0-P2).
 *
 * What it proves, against the real app over CDP:
 *   P0/T-01  a place stored by task A is still visible in task B
 *   P0/T-02  the task filter and "unassigned" run in SQL, one entity per place
 *   P1/T-07  the panel renders the collect view with one card per task
 *   P1/T-08  opening a card shows the task detail with its three tabs
 *   P2/T-10  deleting a task removes only the places no other task saw
 *   P2/T-11  an export pinned to a task contains exactly that task's rows, and
 *            moving the watermark makes "only new" empty
 *   single   one task owns the map: every other start button is disabled, the
 *            queued card names who it waits for, and the create dialog offers
 *            "queue" instead of "start"
 *
 * Rows are injected through the same `business-data` event the injected script
 * emits, so the Rust listener, the membership table and the query path all run
 * for real — no Google request and no mocked IPC.
 *
 * Usage:
 *   node scripts/e2e/tasks.mjs
 *   node scripts/e2e/tasks.mjs --keep-data
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  backupDatabase,
  check,
  closeMaps,
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
  waitFor,
} from './harness.mjs';

const KEEP_DATA = process.argv.includes('--keep-data');
const RUN = Date.now();
const CENTER = { lat: 34.0522, lng: -118.2437 };

const findJob = (jobs, id) => jobs.find((job) => job.id === id);

/** A `Business` with every non-default field filled in. */
const row = (placeId, name) => ({
  name,
  address: '1 E2E St',
  phone: '+1 555 0100',
  rating: 4.5,
  reviews_total: 10,
  lat: CENTER.lat,
  lng: CENTER.lng,
  place_id: placeId,
  website: 'https://example.com',
  types: ['dentist'],
});

/** Same event the injected script emits, including the batch metadata. */
function emitBatch(panel, jobId, rows) {
  const payload = { businesses: rows, sourceQuery: 'e2e', jobId, tileId: '' };
  return evalIn(
    panel,
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
      event: 'business-data',
      payload,
    })})`,
  );
}

async function phaseData(panel) {
  const call = api(panel);

  // Leave no jobs behind from a previous suite; rows are cleared separately.
  const existing = await call('list_jobs');
  for (const job of existing) {
    if (job.status === 'running') await call('pause_job', { id: job.id }).catch(() => {});
    await call('delete_job', { id: job.id }).catch(() => {});
  }
  await call('clear_data');
  await sleep(400);

  const create = (keyword) =>
    call('create_jobs', {
      request: {
        entries: [
          { keyword, city: 'E2E', centerLat: CENTER.lat, centerLng: CENTER.lng },
        ],
        radiusKm: 1,
        cellKm: 5,
      },
    }).then((jobs) => jobs[0]);

  const a = await create(`e2e-a-${RUN}`);
  const b = await create(`e2e-b-${RUN}`);
  check(
    'both tasks carry a generated name',
    Boolean(a?.name) && Boolean(b?.name),
    `${a?.name} / ${b?.name}`,
  );

  const pA = `e2e-only-a-${RUN}`;
  const pB = `e2e-only-b-${RUN}`;
  const pShared = `e2e-shared-${RUN}`;

  await emitBatch(panel, a.id, [row(pA, 'Only A'), row(pShared, 'Shared')]);
  await emitBatch(panel, b.id, [row(pB, 'Only B'), row(pShared, 'Shared')]);
  // The listener stores on its own task; give it a beat before asserting.
  await sleep(800);

  const pageA = await call('query_businesses', {
    request: { jobId: a.id, page: 1, pageSize: 50 },
  });
  const pageB = await call('query_businesses', {
    request: { jobId: b.id, page: 1, pageSize: 50 },
  });
  const all = await call('query_businesses', { request: { page: 1, pageSize: 50 } });

  check('task A sees its two places', pageA.total === 2, String(pageA.total));
  check(
    'task B sees a place task A stored first',
    pageB.total === 2,
    String(pageB.total),
  );
  check('both tasks share one entity per place', all.total === 3, String(all.total));
  check(
    'the shared place is attributed to both jobs',
    pageB.jobRefs.filter((ref) => ref.placeId === pShared).length === 2,
    JSON.stringify(pageB.jobRefs.filter((ref) => ref.placeId === pShared)),
  );

  const jobs = await call('list_jobs');
  check(
    'foundCount counts attribution, not first-writer inserts',
    findJob(jobs, a.id)?.foundCount === 2 && findJob(jobs, b.id)?.foundCount === 2,
    `${findJob(jobs, a.id)?.foundCount}/${findJob(jobs, b.id)?.foundCount}`,
  );

  const unassigned = await call('query_businesses', {
    request: { unassigned: true, page: 1, pageSize: 50 },
  });
  check('nothing is unassigned while every row has a task', unassigned.total === 0);

  const preview = await call('job_delete_preview', { id: a.id });
  check(
    'delete preview splits exclusive and shared places',
    preview.exclusive === 1 && preview.shared === 1,
    JSON.stringify(preview),
  );

  return { a, b };
}

async function phaseExport(panel, a) {
  const call = api(panel);
  const dir = join(tmpdir(), `placemill-e2e-export-${RUN}`);
  mkdirSync(dir, { recursive: true });

  await call('update_settings', {
    patch: { exportDir: dir, exportSaveMode: 'auto', openExportFolder: false },
  });

  const file = await call('export_csv', {
    businesses: [],
    filter: { jobId: a.id },
    fileName: `e2e-task-${RUN}`,
    saveAs: false,
  });
  check('export writes a file for the pinned task', Boolean(file) && existsSync(file), String(file));

  const content =
    file && existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
  const lines = content.trim() ? content.trim().split(/\r?\n/).length : 0;
  check('the CSV holds the header plus exactly the task rows', lines === 3, `${lines} lines`);

  await call('mark_job_exported', { id: a.id, at: Date.now() });
  const stored = findJob(await call('list_jobs'), a.id);
  check('the export watermark is persisted', stored?.lastExportedAt > 0, String(stored?.lastExportedAt));

  const newer = await call('query_businesses', {
    request: {
      jobId: a.id,
      jobSeenSince: Date.now() + 1000,
      page: 1,
      pageSize: 50,
    },
  });
  check('only-new is empty right after an export', newer.total === 0, String(newer.total));

  return dir;
}

async function phaseDelete(panel, a, b) {
  const call = api(panel);
  await call('delete_job', { id: a.id, deleteExclusive: true });

  const all = await call('query_businesses', { request: { page: 1, pageSize: 50 } });
  check(
    'deleting a task drops only its exclusive place',
    all.total === 2,
    String(all.total),
  );

  const pageB = await call('query_businesses', {
    request: { jobId: b.id, page: 1, pageSize: 50 },
  });
  check('the other task keeps both of its rows', pageB.total === 2, String(pageB.total));

  const jobs = await call('list_jobs');
  check('the deleted task is gone', findJob(jobs, a.id) === undefined);
  check('the surviving task still exists', findJob(jobs, b.id) !== undefined);
}

async function phaseUi(panel) {
  // Reload so the panel re-reads a job list it did not create through its own UI.
  await evalIn(panel, 'location.reload()').catch(() => undefined);
  await waitFor(panel, 'document.querySelector(".app-shell") !== null', 60_000, 'panel remount');
  await waitFor(panel, 'document.querySelectorAll(".task-card").length >= 1', 30_000, 'task cards');

  check(
    'the header exposes collect/data views',
    (await evalIn(panel, 'document.querySelector(".view-switch") !== null')) === true,
  );

  const cards = await evalIn(panel, 'document.querySelectorAll(".task-card").length');
  check('the collect view renders one card for the surviving task', cards === 1, String(cards));

  const statuses = await evalIn(
    panel,
    'Array.from(document.querySelectorAll(".task-card .task-card-status")).map((el) => el.textContent)',
  );
  check('the card shows a status label', Array.isArray(statuses) && statuses.length === 1, String(statuses));

  await evalIn(panel, 'document.querySelector(".task-card").click()');
  await waitFor(panel, 'document.querySelector(".task-detail") !== null', 10_000, 'task detail');

  const tabs = await evalIn(
    panel,
    'document.querySelectorAll(".task-detail .ant-tabs-tab").length',
  );
  check('the task detail has overview, results and runs tabs', tabs === 3, String(tabs));

  const title = await evalIn(panel, 'document.querySelector(".task-detail-name").textContent');
  check('the detail header shows the task name', Boolean(title && title.trim()), String(title));

  // Results tab: the 50-row preview scrolls with the pane, like the overview and
  // runs tabs. It used to pin antd's body to `scroll.y: 320`, which showed ~8 of
  // the rows and left the rest of the pane blank.
  await evalIn(panel, 'document.querySelectorAll(".task-detail .ant-tabs-tab")[1].click()');
  const resultsTable = await pollValue(
    panel,
    `(() => {
       if (!document.querySelector('.task-detail-results .ant-table')) return null;
       return {
         nestedBody:
           document.querySelectorAll('.task-detail-results .ant-table-body').length,
       };
     })()`,
    10_000,
    200,
  );
  check(
    'the results preview scrolls with the pane, not inside a fixed-height body',
    resultsTable !== null && resultsTable.nestedBody === 0,
    JSON.stringify(resultsTable),
  );

  // Back to the list.
  await evalIn(panel, 'document.querySelector(".task-detail-head button").click()');
  await waitFor(
    panel,
    'document.querySelector(".task-card") !== null && document.querySelector(".task-detail") === null',
    10_000,
    'back to the task list',
  );

  // Data view: the table and its task picker must be there.
  await evalIn(
    panel,
    'document.querySelectorAll(".view-switch .ant-segmented-item")[1].click()',
  );
  await waitFor(panel, 'document.querySelector(".table-wrap") !== null', 15_000, 'data view');
  check(
    'the data view keeps a task picker',
    (await evalIn(panel, 'document.querySelector(".filter-bar") !== null')) === true,
  );
  // `pageSize >= 100` (a user setting this suite inherits) switches the table to
  // antd's virtual body, which has no `.ant-table-tbody` — so accept both shapes.
  check(
    'the table shows the surviving rows',
    (await pollValue(
      panel,
      `document.querySelectorAll(
         '.ant-table-tbody tr.ant-table-row, .ant-table-tbody-virtual [data-row-key]',
       ).length`,
      5_000,
      200,
    )) > 0,
  );
}

/**
 * Single-flight is a product rule (one map, lower ban risk), so the panel must
 * make it visible: a disabled start button with a reason, a queue position line,
 * and a create dialog that offers "queue" rather than "start".
 */
async function phaseSingleFlight(panel) {
  const call = api(panel);

  // phaseUi left the panel on the data view; the cards live in the collect view.
  await evalIn(panel, 'document.querySelectorAll(".view-switch .ant-segmented-item")[0].click()');
  await waitFor(panel, 'document.querySelector(".task-card") !== null', 10_000, 'collect view');

  // One cell: the runner only needs to claim the map, not fill a grid.
  const [c] = await call('create_jobs', {
    request: {
      entries: [
        { keyword: `e2e-c-${RUN}`, city: 'E2E', centerLat: CENTER.lat, centerLng: CENTER.lng },
      ],
      radiusKm: 1,
      cellKm: 5,
    },
  });
  await call('start_job', { id: c.id });

  const runningCards = await pollValue(
    panel,
    'document.querySelectorAll(".task-card .task-card-status.is-running").length',
    25_000,
  );
  check('starting a task makes it the running one', runningCards === 1, String(runningCards));

  const queued = await evalIn(
    panel,
    `(() => {
       const card = [...document.querySelectorAll('.task-card')]
         .find((el) => el.querySelector('.task-card-status.is-queued'));
       if (!card) return null;
       const start = [...card.querySelectorAll('.task-card-actions button')]
         .find((button) => button.querySelector('.anticon-play-circle'));
       return {
         disabled: start ? start.disabled : null,
         waiting: (card.querySelector('.task-waiting') || {}).textContent || '',
       };
     })()`,
  );
  check(
    'the queued task cannot be started while another runs',
    queued?.disabled === true,
    JSON.stringify(queued),
  );
  check('the queued card names the task it waits for', Boolean(queued?.waiting?.trim()), queued?.waiting);

  const note = await evalIn(
    panel,
    '(document.querySelector(".task-single-flight") || {}).textContent || ""',
  );
  check('the list explains the single-task rule', Boolean(note.trim()), note);

  const runningHasStart = await evalIn(
    panel,
    `(() => {
       const card = [...document.querySelectorAll('.task-card')]
         .find((el) => el.querySelector('.task-card-status.is-running'));
       return card ? Boolean(card.querySelector('.anticon-play-circle')) : null;
     })()`,
  );
  check('the running card offers pause, not start', runningHasStart === false, String(runningHasStart));

  // The manual collection switch is gone: check it did not survive the rewrite.
  const manualSwitch = await evalIn(
    panel,
    `(() => {
       const buttons = [...document.querySelectorAll('.collect-view button')];
       return buttons.filter((button) => /采集|collecting|recolectar/i.test(button.innerText)).length;
     })()`,
  );
  check('the collect view has no manual collection switch', manualSwitch === 0, String(manualSwitch));

  // The create dialog must not promise a start that the backend will reject.
  // Ctrl+N opens it from anywhere, the header button opens it from the bar:
  // same window, and the suite checks both entries.
  await evalIn(
    panel,
    `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true })); true`,
  );
  await waitFor(panel, 'document.querySelector(".grid-field") !== null', 10_000, 'ctrl+n dialog');
  check('Ctrl+N opens the new task dialog', true);
  await evalIn(panel, 'document.querySelector(".ant-modal-close")?.click()');

  await evalIn(panel, 'document.querySelector(".icon-btn")?.click()');
  await waitFor(panel, 'document.querySelector(".grid-field") !== null', 10_000, 'grid dialog');
  const primary = await evalIn(
    panel,
    '(document.querySelector(".ant-modal-footer .ant-btn-primary") || {}).innerText || ""',
  );
  check('creating a task offers a queue while another runs', /排队|queue/i.test(primary), primary);
  await evalIn(panel, 'document.querySelector(".ant-modal-close")?.click()');
  // antd keeps the dialog body mounted after closing; no need to wait for it.

  // Locating navigates the map; it must be refused while the runner owns it.
  // The reason is read inside the page: a rejected Tauri invoke arrives here as
  // an anonymous "Uncaught (in promise)" that drops the error string.
  const locate = await evalIn(
    panel,
    `(async () => {
       try {
         await window.__TAURI_INTERNALS__.invoke('navigate_maps', {
           keyword: 'e2e-locate',
           lat: ${CENTER.lat},
           lng: ${CENTER.lng},
           zoom: 17,
         });
         return 'ok';
       } catch (error) {
         return String(error && error.message ? error.message : error);
       }
     })()`,
  );
  check('the map cannot be navigated away while a task runs', locate.includes('map_busy'), locate);

  // The reported bug: the switch was turned off while the task kept running.
  // The backend now treats that as a pause, so it must not wait for the
  // dry-streak watchdog.
  await call('set_listening', { enabled: false });
  const paused = await pollValue(
    panel,
    `(async () => {
       const jobs = await window.__TAURI_INTERNALS__.invoke('list_jobs');
       const job = jobs.find((candidate) => candidate.id === ${JSON.stringify(c.id)});
       return job ? job.status === 'paused' : false;
     })()`,
    15_000,
  );
  check('turning the switch off pauses the running task', paused === true);

  await call('cancel_job', { id: c.id });
  const cleared = await pollValue(
    panel,
    'document.querySelectorAll(".task-card .task-card-status.is-running").length === 0',
    15_000,
  );
  check('cancelling releases the single-flight lock', cleared === true);

  const unblocked = await evalIn(
    panel,
    `(() => {
       const card = [...document.querySelectorAll('.task-card')]
         .find((el) => el.querySelector('.task-card-status.is-queued'));
       const start = card && [...card.querySelectorAll('.task-card-actions button')]
         .find((button) => button.querySelector('.anticon-play-circle'));
       return start ? start.disabled : null;
     })()`,
  );
  check('the queued task can start again', unblocked === false, String(unblocked));
}

async function main() {
  await preflight();
  note(`task-centric e2e run ${RUN}`);

  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (!KEEP_DATA && !snapshot) {
    throw new Error('refusing to run: no database snapshot, and the suite clears data');
  }

  let panel = null;
  let exportDir = null;

  try {
    await launchApp();
    panel = await openPanel();

    const { a, b } = await phaseData(panel);
    exportDir = await phaseExport(panel, a);
    await phaseDelete(panel, a, b);
    await phaseUi(panel);
    await phaseSingleFlight(panel);
  } finally {
    panel?.close();
    closeMaps();
    await stopApp();
    if (exportDir) rmSync(exportDir, { recursive: true, force: true });
    if (snapshot) check('database restored to its pre-run state', restoreDatabase(snapshot));
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
