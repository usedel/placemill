#!/usr/bin/env node
/**
 * E2E acceptance for the interceptor rework: one injection, no self-nesting,
 * no timer per XHR, no clone/parse while collection is off, a health probe that
 * actually trips, and a degraded-parse alert.
 *
 * Deterministic, no network scraping: the maps webview is driven through CDP
 * while the real injected script runs. What is checked:
 *
 *   - the script injected exactly once and its globals exist
 *   - R-12: `window.fetch = window.fetch` ten times does not re-wrap the
 *     interceptor (identity comparison through the defineProperty setter)
 *   - R-09: an XHR with `responseType = 'json'` still runs the page's own
 *     callback — the old hook read `responseText` unconditionally, threw
 *     InvalidStateError and swallowed the callback
 *   - R-11: no pending-flush polling timer while the IPC bridge is ready
 *   - R-10: three empty parses of a real search body raise the degraded
 *     streak and reach the health channel; the panel shows the red
 *     "collection stopped working" card **while a collection is running**
 *     (the collector switch is the gate) and a good parse clears it (via the
 *     `__placemillNoteParsedBatch` test hook)
 *
 * "Collection still produces rows on a real search" (R-08 without perf
 * profiling) is `npm run e2e:real`; run it after this suite.
 *
 * Usage:
 *   npm run e2e:interceptor
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  api,
  check,
  devLog,
  evalIn,
  evalMaps,
  launchApp,
  note,
  openPanel,
  pollMaps,
  pollValue,
  preflight,
  printSummary,
  stopApp,
} from './harness.mjs';

// A URL the script's own `isTargetUrl` accepts, so `noteParsedBatch` treats
// the synthetic batch as a real search body (the >= 500 byte gate too).
const TARGET_URL = 'https://www.google.com/search?tbm=map&x=e2e';
// The degraded title in all three panel languages; the DOM check must not
// depend on which language the settings carry.
const DEGRADED_TITLE_RE =
  /采集已失效|Collection stopped working|La recolecci\u00f3n dej\u00f3 de funcionar/;

const cardText = `document.querySelector('.listen-card')?.innerText || ''`;

/**
 * N empty parses in **one** page-side call. The streak has to reach three,
 * and three separate round trips could be interrupted by a real response
 * arriving in between (the event loop is single-threaded, so a single call
 * cannot be).
 */
async function noteEmptyParses(count) {
  await evalMaps(
    `(() => { for (let i = 0; i < ${count}; i += 1) { ` +
      `window.__placemillNoteParsedBatch(0, 5000, ${JSON.stringify(TARGET_URL)}, 'e2e'); ` +
      `} return true; })()`,
  );
}

/** One good parse — the recovery path of the degradation detector. */
async function noteGoodParse() {
  await evalMaps(
    `window.__placemillNoteParsedBatch(1, 5000, ${JSON.stringify(TARGET_URL)}, 'e2e'); true`,
  );
}

async function main() {
  await preflight();

  let panel = null;

  try {
    await launchApp();
    panel = await openPanel();

    // ---- the script is live on the maps page -----------------------------
    const scriptLive = await pollMaps(
      'typeof window.__placemillAutoScroll === "object"',
      45_000,
    );
    check(
      'the injected script is live on the maps page',
      scriptLive === true,
    );
    check(
      'the injection guard is set (exactly one run)',
      (await evalMaps('window.__placemillInjected === true')) === true,
    );

    // ---- R-12: self-assignment must not re-wrap --------------------------
    await evalMaps('window.__e2eFetchMarker = window.fetch; true');
    await evalMaps(
      'for (let i = 0; i < 10; i += 1) { window.fetch = window.fetch; } true',
    );
    const sameWrapper = await evalMaps('window.fetch === window.__e2eFetchMarker');
    check(
      'R-12: window.fetch = window.fetch ten times keeps the same interceptor',
      sameWrapper === true,
    );

    // ---- R-09: the page keeps its own callbacks --------------------------
    // `responseType = 'json'` is the shape that used to throw inside the hook
    // (InvalidStateError on responseText) and skip the page's handler.
    await evalMaps(`(() => {
      window.__e2ePageCallbackRan = false;
      const xhr = new XMLHttpRequest();
      xhr.open('GET', location.origin + location.pathname, true);
      xhr.responseType = 'json';
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) window.__e2ePageCallbackRan = true;
      };
      xhr.send();
      return true;
    })()`);
    const callbackRan = await pollMaps('window.__e2ePageCallbackRan === true', 20_000);
    check(
      'R-09: a responseType="json" XHR still runs the page own callback',
      callbackRan === true,
    );

    // ---- R-11: no idle polling timers ------------------------------------
    // The pending-flush timer only exists while the IPC bridge is missing;
    // over CDP the bridge is up, so it must never have been started.
    check(
      'R-11: no pending-flush polling timer while the IPC bridge is ready',
      (await evalMaps('window.__placemillTimer === undefined')) === true,
    );

    // ---- R-10: degraded -> panel alert -> recovery ------------------------
    // The notice belongs to a running collection: the panel's health listener
    // drops the event unless the collector switch is on, and the page only
    // probes while it is on. So the trip is driven twice — once with the
    // switch off (the event is emitted and dropped: no card) and once with it
    // on (the card must appear).
    //
    // A listener of our own is registered in the panel as well: it is the only
    // way to see that the event *was* emitted while the card stayed away,
    // which is the whole point of the first half.
    await evalIn(
      panel,
      `window.__e2eHealth = [];
       void window.__TAURI__.event.listen('maps:health', (e) => window.__e2eHealth.push(e.payload.state));
       true`,
    );
    const call = api(panel);

    const statusBefore = await evalMaps(
      'JSON.stringify(window.__placemillFieldMapStatus())',
    );
    check(
      'the run starts with a clean parse streak',
      JSON.parse(statusBefore).degradedBatches === 0,
      statusBefore,
    );

    await noteEmptyParses(3);
    // Two legitimate outcomes: a remote map was active and got reset to the
    // built-in one (which zeroes the counter by design), or the built-in map
    // was already active and the streak shows directly. Both mean the
    // degraded path tripped.
    const statusAfter = JSON.parse(
      await evalMaps('JSON.stringify(window.__placemillFieldMapStatus())'),
    );
    const degradedTripped =
      statusAfter.degradedBatches === 3 ||
      (JSON.parse(statusBefore).source !== 'builtin' && statusAfter.source === 'builtin');
    check(
      'R-10: three empty parses trip the degraded path',
      degradedTripped,
      `streak=${statusAfter.degradedBatches} source=${JSON.parse(statusBefore).source} -> ${statusAfter.source}`,
    );

    // The event is on the wire...
    const degradedEvent = await pollValue(
      panel,
      `window.__e2eHealth.includes('parse-degraded')`,
      5_000,
      200,
    );
    check(
      'R-10: the degradation reaches the health channel',
      degradedEvent === true,
    );

    // ...but no collection is running, so the panel must not light a card for
    // a map nothing is collecting from.
    const quietWhileIdle = await pollValue(
      panel,
      `!${DEGRADED_TITLE_RE}.test(${cardText})`,
      3_000,
      250,
    );
    check('R-10: no card while no collection is running', quietWhileIdle === true);

    // A good parse clears the streak. The built-in map has nothing to reset,
    // so the batch counter goes back to 0 via the recovery path in
    // `noteParsedBatch` — and the next trip starts from zero again.
    await noteGoodParse();
    const clearedStreak = await evalMaps(
      'window.__placemillFieldMapStatus().degradedBatches === 0',
    );
    check('R-10: a good parse resets the streak', clearedStreak === true);

    // ---- the same trip, now with a collection running --------------------
    // The collector switch is the panel's gate. Turning it on also starts the
    // page's health probe, which speaks once — it was silent while the
    // switch was off, so its first tick carries 'ok' — and that one event
    // would clear the card again. So the probe's first tick is waited out
    // before the trip: after it the probe stays quiet (it only emits on a
    // change).
    //
    // The recovery's own 'ok' is waited for first, so the clearing below
    // cannot eat it by accident.
    await pollValue(
      panel,
      `window.__e2eHealth.includes('ok')`,
      5_000,
      200,
    );
    await evalIn(panel, 'window.__e2eHealth.length = 0; true');
    await call('set_listening', { enabled: true });
    const probeSpoke = await pollValue(
      panel,
      `window.__e2eHealth.includes('ok')`,
      15_000,
      200,
    );
    check(
      'R-10: the page probe speaks once the switch is on',
      probeSpoke === true,
    );

    await noteEmptyParses(3);

    const alertShown = await pollValue(
      panel,
      `${DEGRADED_TITLE_RE}.test(${cardText})`,
      10_000,
      250,
    );
    check(
      'R-10: the panel shows the red "collection stopped working" card',
      alertShown === true,
    );

    // A good parse clears the alert.
    await noteGoodParse();
    const alertGone = await pollValue(
      panel,
      `!${DEGRADED_TITLE_RE}.test(${cardText})`,
      10_000,
      250,
    );
    check('R-10: the panel alert clears on recovery', alertGone === true);

    // The switch off again: the page must be quiet for the rest of the suite.
    await call('set_listening', { enabled: false });

    // ---- M8 / J-08a: optional field keys --------------------------------
    // The nine original keys stay required: a config without one of them
    // means the layout really changed, so the map must be rejected and the
    // app must fall back to the built-in one. Every key added later is
    // optional — a config published before the field existed stays valid,
    // and a remote config that sets one overrides exactly that one.
    const builtinStatus = JSON.parse(
      await evalMaps('JSON.stringify(window.__placemillFieldMapStatus())'),
    );
    check(
      'J-08a: the built-in map carries the new optional keys',
      builtinStatus.map.priceRange === 4 && builtinStatus.map.timezone === 30,
      JSON.stringify(builtinStatus.map),
    );

    // Derived from the built-in map, so it cannot drift from the source.
    const requiredKeys = {};
    for (const key of [
      'resultsIndex',
      'name',
      'address',
      'phone',
      'website',
      'types',
      'coords',
      'placeId',
      'rating',
      'reviews',
    ]) {
      requiredKeys[key] = builtinStatus.map[key];
    }

    async function pushFieldMap(map, version) {
      await evalMaps(
        `window.__placemillApplySettings(Object.assign({}, window.__placemillSettings || {}, ` +
          `{ fieldMap: ${JSON.stringify(map)}, fieldMapVersion: ${JSON.stringify(version)} })); true`,
      );
      return JSON.parse(
        await evalMaps('JSON.stringify(window.__placemillFieldMapStatus())'),
      );
    }

    // A config that predates the new keys: still accepted, and the built-in
    // values still apply to the fields it says nothing about.
    const legacyStatus = await pushFieldMap(requiredKeys, 'e2e-legacy');
    check(
      'J-08a: a config without the new keys is still accepted',
      legacyStatus.source === 'remote:e2e-legacy',
      JSON.stringify(legacyStatus.source),
    );
    check(
      'J-08a: the accepted map carries no optional key it did not set',
      legacyStatus.map.priceRange === undefined &&
        legacyStatus.map.timezone === undefined,
      JSON.stringify(legacyStatus.map),
    );
    check(
      'J-08a: an unset optional key resolves to the built-in index',
      legacyStatus.effective.priceRange === 4 &&
        legacyStatus.effective.timezone === 30,
      JSON.stringify(legacyStatus.effective),
    );

    // A config that sets the new keys: applied, and only those.
    const extendedStatus = await pushFieldMap(
      { ...requiredKeys, priceRange: 4, timezone: 30 },
      'e2e-extended',
    );
    check(
      'J-08a: a config that sets the new keys is accepted and applied',
      extendedStatus.source === 'remote:e2e-extended' &&
        extendedStatus.map.priceRange === 4 &&
        extendedStatus.effective.timezone === 30,
      JSON.stringify(extendedStatus.map),
    );

    // A malformed optional key costs that key only. The whole map is still
    // applied — the opposite of the old all-or-nothing behaviour.
    const brokenStatus = await pushFieldMap(
      { ...requiredKeys, priceRange: 99999, timezone: 30 },
      'e2e-broken',
    );
    check(
      'J-08a: a malformed optional key is dropped without rejecting the map',
      brokenStatus.source === 'remote:e2e-broken' &&
        brokenStatus.map.priceRange === undefined &&
        brokenStatus.map.timezone === 30 &&
        brokenStatus.effective.priceRange === 4,
      JSON.stringify(brokenStatus.map),
    );

    // Regression guard: the original nine keys are still required.
    const incomplete = { ...requiredKeys };
    delete incomplete.name;
    const rejectedStatus = await pushFieldMap(incomplete, 'e2e-incomplete');
    check(
      'J-08a: a map missing a required key is still rejected',
      rejectedStatus.source === 'remote:e2e-broken' &&
        rejectedStatus.map.name === 11,
      JSON.stringify(rejectedStatus.source),
    );

    // Leave the app with the map it started with.
    await pushFieldMap(builtinStatus.map, '');

    // ...and drop the field-map mirror, so the next run does not start from a
    // stale remote map. The mirror lives in the webview's localStorage, which
    // the DB snapshot does not cover.
    await evalMaps(
      `(() => {
        localStorage.removeItem('placemill.fieldMap');
        const raw = localStorage.getItem('placemill.settings');
        if (raw) {
          const settings = JSON.parse(raw);
          delete settings.fieldMap;
          delete settings.fieldMapVersion;
          localStorage.setItem('placemill.settings', JSON.stringify(settings));
        }
        return true;
      })()`,
    );

    // ---- M8 / J-08b: the index probe ------------------------------------
    // The probe answers "what shape sits at this index", which is what turns
    // picking an index from guesswork into a reading task. It is fed a
    // synthetic detail array here, so the answers are deterministic and no
    // real search is needed.
    const SYNTHETIC_DETAIL = (() => {
      const detail = [];
      detail[4] = [null, null, '$$', null, null, null, null, 4.5, 12];
      detail[10] = 'data' + String.fromCharCode(0) + 'id';
      detail[11] = 'Probe Cafe';
      detail[18] = 'Probe Cafe, 1 Main St';
      detail[30] = 'America/Los_Angeles';
      detail[203] = [['Monday', null, null, ['9 AM - 5 PM']]];
      return detail;
    })();
    // The same shape without the high indices: the array stops at 30, so
    // index 84 is out of range rather than present-and-null.
    const SYNTHETIC_SHORT = SYNTHETIC_DETAIL.slice(0, 31);

    const probe = JSON.parse(
      await evalMaps(
        `JSON.stringify(window.__placemillIndexProbe(${JSON.stringify(SYNTHETIC_DETAIL)}))`,
      ),
    );
    check(
      'J-08b: the probe answers for a detail array',
      probe.ready === true,
      JSON.stringify(probe).slice(0, 200),
    );
    check(
      'J-08b: the probe covers every candidate path',
      probe.candidates === probe.records.length && probe.candidates > 20,
      `${probe.candidates} candidates`,
    );

    const recordFor = (want, source = probe) =>
      source.records.find((r) => r.want === want);
    const finalStep = (record) => record.steps[record.steps.length - 1];

    const priceRange = recordFor('price_range');
    check(
      'J-08b: the probe reads the value at a nested path',
      priceRange !== undefined &&
        finalStep(priceRange).kind === 'string' &&
        finalStep(priceRange).sample === '$$' &&
        JSON.stringify(priceRange.path) === '[4,2]',
      JSON.stringify(priceRange && priceRange.steps),
    );

    // The sub-paths are the ones a target column would actually use.
    const weekday = recordFor('open_hours_weekday');
    const slots = recordFor('open_hours_slots');
    check(
      'J-08b: the probe reaches the documented sub-path of a nested field',
      weekday !== undefined &&
        finalStep(weekday).kind === 'string' &&
        finalStep(weekday).sample === 'Monday' &&
        slots !== undefined &&
        finalStep(slots).kind === 'array' &&
        finalStep(slots).len === 1 &&
        finalStep(slots).first.kind === 'string',
      JSON.stringify([weekday && finalStep(weekday), slots && finalStep(slots)]),
    );

    // A slot that is present but empty is null; a slot beyond the array is
    // missing. The two must not be confused.
    const nullSlot = recordFor('popular_times');
    check(
      'J-08b: a slot that is present but empty is reported as null',
      nullSlot !== undefined && finalStep(nullSlot).kind === 'null',
      JSON.stringify(nullSlot && finalStep(nullSlot)),
    );

    const shortProbe = JSON.parse(
      await evalMaps(
        `JSON.stringify(window.__placemillIndexProbe(${JSON.stringify(SYNTHETIC_SHORT)}))`,
      ),
    );
    const missingSlot = recordFor('popular_times', shortProbe);
    check(
      'J-08b: a slot beyond the array is reported as missing',
      missingSlot !== undefined && finalStep(missingSlot).kind === 'missing',
      JSON.stringify(missingSlot && finalStep(missingSlot)),
    );

    const dataId = recordFor('data_id');
    check(
      'J-08b: the probe flags a NUL byte inside a string',
      dataId !== undefined && finalStep(dataId).nul === true,
      JSON.stringify(dataId && finalStep(dataId)),
    );

    // ---- J-08f: a payload with a raw control byte still parses ------------
    // Google occasionally puts a raw NUL inside a field. A raw control byte is
    // invalid inside a JSON string, so an unguarded `JSON.parse` throws and
    // the *whole* response is lost: one byte, and the batch is gone — exactly
    // the "scrolling forever, zero rows" failure the R-10 card is about.
    //
    // The wrapper format holds the real payload as a JSON string (`d`), so a
    // byte inside a business field can sit in two places: raw in the wire
    // text, or escaped in the wire text and raw again in the inner payload
    // once the wrapper was parsed. Both have to survive.
    const NUL = String.fromCharCode(0);
    const ESC = '\\u0000'; // how a JSON encoder writes the byte
    const ESC2 = '\\\\' + 'u0000'; // ... and how the wrapper escapes it again
    const tinyDetail = [];
    tinyDetail[11] = 'Probe Cafe' + NUL;
    const tinyInner = [];
    tinyInner[64] = [[null, tinyDetail]];
    const innerText = JSON.stringify(tinyInner);
    // The wrapper, with the inner payload as its `d` string. The inner's
    // quotes are escaped, and so is the byte.
    const wrapperText = '{"c":0,"d":' + JSON.stringify(innerText) + '}';
    // ... and the same text with the byte written raw, as it comes off the
    // wire: no JSON parser accepts a control byte inside a string.
    const wireRawText = wrapperText.replace(ESC2, NUL);
    check(
      'J-08f: the wire text really does carry a raw control byte',
      wireRawText.includes(NUL) && !wrapperText.includes(NUL),
      `clean=${wrapperText.includes(NUL) ? 'has' : 'no'} raw=${wireRawText.includes(NUL) ? 'has' : 'no'}`,
    );

    const parseWith = async (text) =>
      JSON.parse(
        await evalMaps(`JSON.stringify(window.__placemillParse(${JSON.stringify(text)}))`),
      );

    // The control: the same payload without the byte at all.
    const clean = await parseWith(wrapperText.replace(ESC2, ''));
    check(
      'J-08f: the control payload parses',
      clean.ok === true && clean.count === 1,
      `count=${clean.count} error=${clean.error ?? ''}`,
    );

    // (a) The byte on the wire.
    const rawOnWire = await parseWith(wireRawText);
    check(
      'J-08f: a payload with a raw control byte still parses',
      rawOnWire.ok === true && rawOnWire.count === 1,
      `count=${rawOnWire.count} error=${rawOnWire.error ?? ''}`,
    );
    check(
      'J-08f: the row that came out of it is clean',
      rawOnWire.rows?.[0]?.name === 'Probe Cafe',
      JSON.stringify(rawOnWire.rows?.[0]?.name ?? null),
    );

    // (b) The byte one level down: the wrapper parses (the escape is legal
    // there), and the inner payload comes back with a raw byte in it.
    const rawInside = await parseWith(wrapperText.replace(ESC2, ESC));
    check(
      'J-08f: a payload with a raw control byte in the inner payload still parses',
      rawInside.ok === true && rawInside.count === 1,
      `count=${rawInside.count} error=${rawInside.error ?? ''}`,
    );
    check(
      'J-08f: the inner row is clean too',
      rawInside.rows?.[0]?.name === 'Probe Cafe',
      JSON.stringify(rawInside.rows?.[0]?.name ?? null),
    );

    // The probe must stay out of the production path: it may read the
    // payload, but it must not emit anything. The patch is verified to be in
    // place and a control emit proves the counter works, so a zero count
    // means "emitted nothing" rather than "the patch did not stick".
    const emission = JSON.parse(
      await evalMaps(
        `(() => {
          const tauri = window.__TAURI__;
          if (!tauri || !tauri.event || typeof tauri.event.emit !== 'function') {
            return JSON.stringify({ installed: false, afterProbe: -1, afterControl: -1 });
          }
          const originalEvent = tauri.event;
          const originalEmit = originalEvent.emit;
          let count = 0;
          const patched = {
            emit: function () { count += 1; return originalEmit.apply(this, arguments); }
          };
          tauri.event = patched;
          const installed = tauri.event === patched;
          window.__placemillIndexProbe(${JSON.stringify(SYNTHETIC_DETAIL)});
          const afterProbe = count;
          patched.emit('e2e-probe-control', {});
          const afterControl = count;
          tauri.event = originalEvent;
          return JSON.stringify({ installed, afterProbe, afterControl });
        })()`,
      ),
    );
    check(
      'J-08b: the probe emits no event',
      emission.installed === true &&
        emission.afterProbe === 0 &&
        emission.afterControl === 1,
      JSON.stringify(emission),
    );

    // Fill rate over several rows. A path that is present in every row but
    // filled in none means the index is right and these businesses simply
    // have no such value; a path that is missing everywhere means the index
    // is wrong. One row cannot tell those apart — which is exactly the
    // question the first real run raised.
    const MULTI_ROWS = [
      SYNTHETIC_DETAIL,
      (() => {
        const detail = [];
        detail[11] = 'Second Cafe';
        detail[30] = 'America/Los_Angeles';
        return detail;
      })(),
      (() => {
        const detail = [];
        detail[11] = 'Third Cafe';
        return detail;
      })(),
    ];
    const multi = JSON.parse(
      await evalMaps(
        `JSON.stringify(window.__placemillIndexProbeRows(${JSON.stringify(MULTI_ROWS)}))`,
      ),
    );
    const multiRecord = (want) => multi.records.find((r) => r.want === want);
    check(
      'J-08b: the probe reports the fill rate over several rows',
      multi.rows === 3 &&
        multiRecord('name').inRange === 3 &&
        multiRecord('name').filled === 3 &&
        multiRecord('timezone').inRange === 2 &&
        multiRecord('timezone').filled === 2 &&
        // The slot is in range in all three rows but only one holds a
        // value: the index is plausible, the businesses differ.
        multiRecord('price_range').inRange === 3 &&
        multiRecord('price_range').filled === 1,
      JSON.stringify({
        name: multiRecord('name'),
        timezone: multiRecord('timezone'),
        price_range: multiRecord('price_range'),
      }),
    );
    check(
      'J-08b: a path that exists but is never filled is told apart from a missing one',
      multiRecord('popular_times').inRange === 1 &&
        multiRecord('popular_times').filled === 0,
      JSON.stringify(multiRecord('popular_times')),
    );

    // ---- J-09a: the reviews parser against a real captured answer --------
    // The fixture is a real `batchexecute?rpcids=qv9Egd` answer (captured
    // 2026-10-25), so the parser is pinned against reality and not against a
    // hand-written guess.
    const reviewsFixture = readFileSync(
      join(__dirname, 'fixtures', 'reviews-response.txt'),
      'utf8',
    );
    const parsedReviews = JSON.parse(
      await evalMaps(
        `JSON.stringify(window.__placemillParseReviews(${JSON.stringify(reviewsFixture)}))`,
      ),
    );
    check(
      'J-09a: the captured reviews answer parses without an error',
      parsedReviews.error === null && Array.isArray(parsedReviews.reviews),
      JSON.stringify(parsedReviews).slice(0, 200),
    );
    const firstReview = (parsedReviews.reviews || [])[0] || {};
    check(
      'J-09a: every review carries id, author, stars, text and a timestamp',
      parsedReviews.reviews.length === 10 &&
        parsedReviews.reviews.every(
          (r) =>
            r.review_id.length > 10 &&
            r.author.length > 0 &&
            r.stars >= 1 &&
            r.stars <= 5 &&
            r.text.length > 0 &&
            r.created_at_us > 1000000000000000,
        ),
      JSON.stringify(parsedReviews.reviews.map((r) => r.review_id)),
    );
    check(
      'J-09a: the parsed review is the one from the capture',
      firstReview.author === 'Ben Hellmoldt' &&
        firstReview.stars === 3 &&
        firstReview.text.startsWith('Buy mostly produce') &&
        firstReview.place_id === '0x0:0x1636a069564b294',
      JSON.stringify(firstReview).slice(0, 200),
    );
    check(
      'J-09a: the answer carries a paging token',
      typeof parsedReviews.nextToken === 'string' && parsedReviews.nextToken.length > 20,
      String(parsedReviews.nextToken).slice(0, 60),
    );
    // The timestamps are microseconds; a parser that read them as seconds
    // would land in the year 55000.
    const firstCreated = firstReview.created_at_us || 0;
    check(
      'J-09a: the review timestamps are microseconds',
      firstCreated > 1500000000000000 && firstCreated < 2000000000000000,
      String(firstCreated),
    );

    // ---- J-09a: the reviews_link payload (the featured-review channel) ----
    // One review per place, same relative paths, carried in the
    // `search.google.com/local/reviews?placeid=…` answer.
    const linkFixture = readFileSync(
      join(__dirname, 'fixtures', 'reviews-link-response.txt'),
      'utf8',
    );
    const parsedLink = JSON.parse(
      await evalMaps(
        `JSON.stringify(window.__placemillParseReviewsLink(${JSON.stringify(linkFixture)}))`,
      ),
    );
    check(
      'J-09a: the reviews_link payload parses without an error',
      parsedLink.error === null && Array.isArray(parsedLink.reviews),
      JSON.stringify(parsedLink).slice(0, 200),
    );
    const linkFirst = (parsedLink.reviews || [])[0] || {};
    check(
      'J-09a: the featured review is the one from the capture',
      parsedLink.reviews.length === 1 &&
        linkFirst.author === 'Dawei Wang' &&
        linkFirst.stars === 1 &&
        linkFirst.text.startsWith('This customer service guy') &&
        linkFirst.created_at_us === 1567179139665570,
      JSON.stringify(linkFirst).slice(0, 220),
    );

    // ---- J-10 / Tier-2: the place-detail parser, pinned with the two real
    // payloads the spike captured (see `docs/parser.md`). Each fixture is the
    // raw detail array (jd[6]).
    for (const [label, file, hasDescription] of [
      ['capitol-nissan', 'detail-place-payload-capitol-nissan.json', false],
      ['restaurant', 'detail-place-payload-restaurant.json', true],
    ]) {
      const detailFixture = JSON.parse(
        readFileSync(join(__dirname, 'fixtures', file), 'utf8'),
      );
      const parsedPlace = JSON.parse(
        await evalMaps(
          `JSON.stringify(window.__placemillParsePlacePayload(${JSON.stringify(
            JSON.stringify(detailFixture),
          )}))`,
        ),
      );
      check(
        `J-10 (${label}): the detail payload parses and identifies itself`,
        parsedPlace.ok === true &&
          typeof parsedPlace.name === 'string' &&
          parsedPlace.name.length > 0 &&
          typeof parsedPlace.placeId === 'string' &&
          parsedPlace.placeId.length > 0,
        JSON.stringify(parsedPlace).slice(0, 200),
      );
      check(
        `J-10 (${label}): plus_code is filled`,
        typeof parsedPlace.plusCode === 'string' && parsedPlace.plusCode.length > 0,
        parsedPlace.plusCode,
      );
      check(
        `J-10 (${label}): the rating distribution sums to reviews_total`,
        Array.isArray(parsedPlace.reviewsPerRating) &&
          parsedPlace.reviewsPerRating.length === 5 &&
          parsedPlace.reviewsPerRating.reduce((a, b) => a + b, 0) ===
            (detailFixture[4] || [])[8],
        JSON.stringify(parsedPlace.reviewsPerRating),
      );
      check(
        `J-10 (${label}): photos collected across the containers`,
        Array.isArray(parsedPlace.photos) && parsedPlace.photos.length > 0,
        'photos=' + (parsedPlace.photos || []).length,
      );
      check(
        `J-10 (${label}): description ${hasDescription ? 'is filled' : 'stays empty (business-type dependent)'}`,
        hasDescription
          ? typeof parsedPlace.description === 'string' && parsedPlace.description.length > 0
          : parsedPlace.description === '',
        parsedPlace.description.slice(0, 120),
      );
    }

    note('all interceptor checks are deterministic; run "npm run e2e:real" for a real scrape');
  } finally {
    // The R-10 block turns the collector switch on; an early failure must
    // not leave the page collecting for the next suite.
    if (panel) {
      await api(panel)('set_listening', { enabled: false }).catch(() => {});
    }
    panel?.close();
    await stopApp();
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
