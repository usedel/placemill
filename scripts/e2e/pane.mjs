#!/usr/bin/env node
/**
 * E2E acceptance for maps-pane ownership (C-01 / C-02 / C-08).
 *
 * Five commands replace the Maps document, so exactly one of them may own it at
 * a time. This suite proves the two directions that the older suites did not
 * cover: a reviews fetch refuses a task start, a running task refuses a reviews
 * fetch, and an enrichment run refuses a map-language change. It also proves
 * the slot is released when the fetch's timed sequence ends, and that a review
 * row belonging to another place is dropped instead of stored.
 *
 * No Google results are needed: the checks are about refusals and about the
 * store path, so a consent page or an empty feed does not fail them.
 *
 * Usage:
 *   npm run e2e:pane
 *   npm run e2e:pane -- --keep-data
 */
import {
  api,
  backupDatabase,
  check,
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
} from './harness.mjs';

const KEEP_DATA = process.argv.includes('--keep-data');
const RUN = Date.now();
const PLACE = `e2e-pane-${RUN}`;
/** `0x…:0x…` — the tail `abc123` is what a review row must carry. */
const DATA_ID = '0x8848:0xabc123';
/** The reviews fetch sequence is 4.5 s + 3 s + 4 s; the slot covers it all. */
const SEQUENCE_MS = 11_500;
const CENTER = { lat: 34.0522, lng: -118.2437 };

function seedRow() {
  return {
    place_id: PLACE,
    name: `E2E Pane ${RUN}`,
    address: '1 Test Street',
    phone: '+1 555 0199',
    rating: 4.5,
    reviews_total: 3,
    lat: CENTER.lat,
    lng: CENTER.lng,
    website: 'https://example.com',
    types: ['dentist'],
  };
}

/**
 * Run a command and normalise success/failure so a check can read either.
 *
 * The catch has to live *inside* the page: a rejected `invoke` surfaces over
 * CDP as a bare "Uncaught (in promise)" with the message stripped, which is
 * exactly the code we are asserting on.
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

async function main() {
  await preflight();
  note(`C-01/C-02/C-08 · maps-pane ownership (run ${RUN})`);

  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (!KEEP_DATA && !snapshot) {
    throw new Error('refusing to run: no database snapshot, and the suite clears data');
  }

  let panel = null;
  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);

    // Leave no job or row from a previous run behind.
    for (const job of await call('list_jobs')) {
      if (job.status === 'running') await call('pause_job', { id: job.id }).catch(() => {});
      await call('delete_job', { id: job.id }).catch(() => {});
    }
    await call('clear_data');
    // Stopping the switch opens a 3 s grace window (`SWITCH_OFF_GRACE`) during
    // which `store_businesses` still accepts in-flight batches and every pane
    // check answers `session_active`. Wait it out, or the refusals below would
    // be attributed to the wrong owner.
    await sleep(3_600);
    await call('on_business_data', { businesses: [seedRow()] });
    await sleep(300);

    const [job] = await call('create_jobs', {
      request: {
        entries: [
          {
            keyword: `e2e-pane-${RUN}`,
            city: 'E2E',
            centerLat: CENTER.lat,
            centerLng: CENTER.lng,
          },
        ],
        radiusKm: 1,
        cellKm: 5,
      },
    });
    check('a one-tile task is queued for the refusal checks', Boolean(job?.id), String(job?.id));

    // ---- C-01: a reviews fetch owns the pane -----------------------------
    const requested = await attempt(panel, 'fetch_business_reviews', { placeId: PLACE });
    check(
      'the reviews fetch is accepted on an idle pane',
      requested.ok && requested.value === 'requested',
      JSON.stringify(requested),
    );

    const startWhileFetching = await attempt(panel, 'start_job', { id: job.id });
    check(
      'starting a task mid-fetch is refused with reviews_busy',
      !startWhileFetching.ok && startWhileFetching.error.includes('reviews_busy'),
      JSON.stringify(startWhileFetching),
    );

    const enrichWhileFetching = await attempt(panel, 'enrich_businesses', { placeIds: [PLACE] });
    check(
      'starting an enrichment mid-fetch is refused with reviews_busy',
      !enrichWhileFetching.ok && enrichWhileFetching.error.includes('reviews_busy'),
      JSON.stringify(enrichWhileFetching),
    );

    const locateWhileFetching = await attempt(panel, 'navigate_maps', {
      keyword: 'e2e-pane-locate',
      lat: CENTER.lat,
      lng: CENTER.lng,
      zoom: 17,
    });
    check(
      'locating a business mid-fetch is refused with reviews_busy',
      !locateWhileFetching.ok && locateWhileFetching.error.includes('reviews_busy'),
      JSON.stringify(locateWhileFetching),
    );

    // ---- C-01: the slot is released when the sequence ends ---------------
    await sleep(SEQUENCE_MS + 1_500);
    const startedAfter = await attempt(panel, 'start_job', { id: job.id });
    check(
      'the slot is released once the timed sequence ends',
      startedAfter.ok,
      JSON.stringify(startedAfter),
    );

    // ---- C-01: a running task owns the pane ------------------------------
    if (startedAfter.ok) {
      const fetchWhileRunning = await attempt(panel, 'fetch_business_reviews', {
        placeId: PLACE,
      });
      check(
        'fetching reviews while a task runs is refused with map_busy',
        !fetchWhileRunning.ok && fetchWhileRunning.error.includes('map_busy'),
        JSON.stringify(fetchWhileRunning),
      );
      await call('pause_job', { id: job.id }).catch(() => {});
      // Pausing turns the switch off too, so the same 3 s grace applies before
      // the enrichment step can own the pane.
      await sleep(3_600);
    }

    // ---- C-08: an enrichment run owns the pane ---------------------------
    const enrichStart = await attempt(panel, 'enrich_businesses', { placeIds: [PLACE] });
    check('enrichment starts on the released pane', enrichStart.ok, JSON.stringify(enrichStart));
    await sleep(500);

    const localeWhileEnriching = await attempt(panel, 'update_settings', {
      patch: { mapLanguage: 'zh-CN' },
    });
    check(
      'changing the map language mid-enrichment is refused with enrich_busy',
      !localeWhileEnriching.ok && localeWhileEnriching.error.includes('enrich_busy'),
      JSON.stringify(localeWhileEnriching),
    );

    const startWhileEnriching = await attempt(panel, 'start_job', { id: job.id });
    check(
      'starting a task mid-enrichment is refused with enrich_busy',
      !startWhileEnriching.ok && startWhileEnriching.error.includes('enrich_busy'),
      JSON.stringify(startWhileEnriching),
    );

    await call('enrich_stop').catch(() => {});
    // The runner checks the flag between places and at every poll (1.5 s).
    await sleep(2_500);

    // ---- C-02: a review row of another place is dropped -------------------
    const emitReviews = (payload) =>
      evalIn(
        panel,
        `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
          event: 'business-reviews',
          payload,
        })})`,
      );

    await emitReviews({
      placeId: PLACE,
      dataId: DATA_ID,
      channel: 'state_cache',
      reviews: [
        {
          review_id: `r-other-${RUN}`,
          payload_place_id: '0x0:0xdeadbeef',
          author: 'Someone Else',
        },
      ],
    });
    await sleep(600);
    const afterOther = await call('get_business_reviews', { placeId: PLACE });
    check(
      'a review belonging to another place is dropped',
      Array.isArray(afterOther) && afterOther.length === 0,
      JSON.stringify(afterOther?.length ?? null),
    );

    await emitReviews({
      placeId: PLACE,
      dataId: DATA_ID,
      channel: 'state_cache',
      reviews: [
        {
          review_id: `r-own-${RUN}`,
          payload_place_id: '0x0:0xabc123',
          author: 'Right Place',
        },
      ],
    });
    await sleep(600);
    const afterOwn = await call('get_business_reviews', { placeId: PLACE });
    check(
      'a review of the requested place is stored',
      Array.isArray(afterOwn) && afterOwn.length === 1 && afterOwn[0].author === 'Right Place',
      JSON.stringify(afterOwn?.map((row) => row.author) ?? null),
    );

    // ---- P2-5: every payload ends the sequence ---------------------------
    // The bug was that `reviews:updated` was emitted only when rows were
    // *inserted*: a zero-review business (or an aborted fetch, or a failed one)
    // left the drawer spinning until its own 15 s timeout, with the whole panel
    // disabled. The listener now answers every payload; these two are the ones
    // that used to be silent.
    await evalIn(
      panel,
      `window.__e2eReviewEvents = [];
       void window.__TAURI__.event.listen('reviews:updated', (e) => window.__e2eReviewEvents.push(e.payload));
       true`,
    );

    await emitReviews({ placeId: PLACE, dataId: DATA_ID, channel: 'state_cache', reviews: [] });
    const zeroRow = await pollValue(
      panel,
      `(function () {
         var hit = window.__e2eReviewEvents.find(function (e) {
           return e && e.placeId === ${JSON.stringify(PLACE)};
         });
         return hit ? JSON.stringify(hit) : '';
       })()`,
      5_000,
    );
    let zeroRowEvent = null;
    try {
      zeroRowEvent = JSON.parse(zeroRow);
    } catch {
      zeroRowEvent = null;
    }
    check(
      'a zero-row payload still reports completion',
      zeroRowEvent?.count === 0,
      String(zeroRow),
    );

    // An aborted sequence (place mismatch, consent page, captcha) carries no
    // rows at all — that branch used to emit nothing.
    const abortedPlace = `e2e-pane-aborted-${RUN}`;
    await emitReviews({
      placeId: abortedPlace,
      dataId: DATA_ID,
      error: 'place-mismatch:0x0:0x11112222',
    });
    const aborted = await pollValue(
      panel,
      `(function () {
         var hit = window.__e2eReviewEvents.find(function (e) {
           return e && e.placeId === ${JSON.stringify(abortedPlace)};
         });
         return hit ? JSON.stringify(hit) : '';
       })()`,
      5_000,
    );
    let abortedEvent = null;
    try {
      abortedEvent = JSON.parse(aborted);
    } catch {
      abortedEvent = null;
    }
    check(
      'a failed fetch still reports completion',
      abortedEvent?.count === 0,
      String(aborted),
    );

    // ---- C-14: debug builds keep the fixture switch ----------------------
    const fixtureSwitch = await attempt(panel, 'set_listening', { enabled: true });
    const collector = await call('get_collector_state');
    check(
      'debug builds can still drive the switch for fixtures',
      fixtureSwitch.ok && collector.listening === true,
      JSON.stringify({ fixtureSwitch, listening: collector.listening }),
    );
    await call('set_listening', { enabled: false }).catch(() => {});
    // The fixture switch leaves the same 3 s grace behind; the race below would
    // otherwise be refused with `session_active` instead of by the slot.
    await sleep(3_600);

    // ---- P2-1: check-and-claim is one step -------------------------------
    // Both commands are fired in the same tick. Reading three slots and then
    // claiming one let them *both* pass the check and both navigate the pane;
    // with a single owner exactly one may win.
    const raceRaw = await evalIn(
      panel,
      `(async () => {
         const invoke = window.__TAURI_INTERNALS__.invoke;
         const settle = (p) => p.then(
           (value) => ({ ok: true, value: value === undefined ? null : value }),
           (error) => ({ ok: false, error: String(error && error.message ? error.message : error) })
         );
         const results = await Promise.all([
           settle(invoke('fetch_business_reviews', { placeId: ${JSON.stringify(PLACE)} })),
           settle(invoke('start_job', { id: ${JSON.stringify(job.id)} })),
         ]);
         return JSON.stringify(results);
       })()`,
    );
    const race = JSON.parse(raceRaw);
    const winners = race.filter((entry) => entry.ok);
    check(
      'two commands fired together cannot both own the pane',
      winners.length === 1,
      String(raceRaw),
    );
    const loser = race.find((entry) => !entry.ok);
    check(
      'the losing command is told who owns the pane',
      Boolean(
        loser &&
          (loser.error.includes('reviews_busy') ||
            loser.error.includes('map_busy') ||
            loser.error.includes('job_running')),
      ),
      String(loser?.error ?? 'no refusal'),
    );
    // Clean up whichever won, so `stopApp` does not kill a running task.
    await call('pause_job', { id: job.id }).catch(() => {});
  } finally {
    panel?.close();
    await stopApp();
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
