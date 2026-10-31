#!/usr/bin/env node
/**
 * E2E acceptance for the compact panel (UI-14).
 *
 * Below `BREAKPOINTS.compact` the data view stops being a seven-column table:
 * rows become cards, the filter row collapses behind one trigger, and every
 * drawer shrinks with the panel. None of that is visible at the default split
 * ratio, so this suite shrinks the pane below the breakpoint first and then
 * asserts the narrow layout is the one that rendered. The breakpoint is read
 * from `src/design/breakpoints.ts` rather than copied here.
 *
 * Usage:
 *   npm run e2e:compact
 *   npm run e2e:compact -- --keep-data
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  REPO_ROOT,
  restoreDatabase,
  skip,
  sleep,
  stopApp,
} from './harness.mjs';

const KEEP_DATA = process.argv.includes('--keep-data');
const RUN = Date.now();
const PLACE = `e2e-compact-${RUN}`;
/** The row injected after the list is parked away from the tail. */
const NEW_PLACE = `e2e-compact-new-${RUN}`;

/**
 * Parsed from `src/design/breakpoints.ts` rather than copied: a second literal
 * would keep passing after the layout moved (the suite asserts "narrower than
 * X", so a stale X silently changes what is being tested).
 */
function compactBreakpoint() {
  const source = readFileSync(join(REPO_ROOT, 'src', 'design', 'breakpoints.ts'), 'utf8');
  const match = source.match(/^\s*compact:\s*(\d+),/m);
  if (!match) {
    throw new Error('cannot read BREAKPOINTS.compact from src/design/breakpoints.ts');
  }
  return Number(match[1]);
}

const COMPACT_MAX = compactBreakpoint();

function seedRow(placeId = PLACE) {
  return {
    place_id: placeId,
    name: `E2E Compact ${RUN}`,
    address: '742 Evergreen Terrace, Springfield',
    phone: '+1 555 0142',
    rating: 4.4,
    reviews_total: 12,
    lat: 34.0522,
    lng: -118.2437,
    website: 'https://example.com',
    types: ['cafe'],
  };
}

async function main() {
  await preflight();
  note(`UI-14 · compact panel (run ${RUN})`);

  const snapshot = KEEP_DATA ? null : backupDatabase();
  if (!KEEP_DATA && !snapshot) {
    throw new Error('refusing to run: no database snapshot');
  }

  let panel = null;
  try {
    await launchApp();
    panel = await openPanel();
    const call = api(panel);

    // The panel opens on the collect view, and both the table and the card list
    // live in the data view — without this the suite asserts against a DOM that
    // has neither, and "the table is not mounted" passes for the wrong reason.
    await evalIn(
      panel,
      'document.querySelectorAll(".view-switch .ant-segmented-item")[1].click()',
    );
    await pollValue(panel, 'document.querySelector(".table-wrap") !== null', 15_000);

    // A clean slate: the card list is asserted by place id, and a leftover row
    // from another suite would make "at least one card" pass for the wrong
    // reason.
    for (const job of await call('list_jobs')) {
      if (job.status === 'running') await call('pause_job', { id: job.id }).catch(() => {});
      await call('delete_job', { id: job.id }).catch(() => {});
    }
    await call('clear_data');
    await sleep(3_600);

    // Seed through the real write path rather than the database file: the
    // ingest guard and the dedup layers are part of what the card list shows.
    await call('set_listening', { enabled: true });
    await sleep(300);
    await call('on_business_data', { businesses: [seedRow()] });
    await sleep(800);

    // Narrow the pane past the compact breakpoint. `window.innerWidth` inside
    // the panel webview *is* the pane width, not the window width, and the pane
    // is `window * ratio` — deriving the ratio from the pane width (as this
    // suite did) asked for 560/707, hit the clamp ceiling and made the pane
    // *wider*, so the suite skipped itself on a 1536px display. `set_split_ratio`
    // returns its clamped input, which is also how the lower bound is read
    // without keeping a third copy of it here.
    const originalRatio = Number((await call('get_settings')).splitRatio);
    const minRatio = Number(await call('set_split_ratio', { ratio: 0 }));
    await sleep(400);
    // The pane is at its floor right now, so this measurement *is* the narrowest
    // pane; deriving it again from the estimated window width would only add
    // rounding. The window width itself is needed to pick the target ratio.
    const narrowest = Number(await evalIn(panel, 'window.innerWidth'));
    const windowWidth = Math.round(narrowest / minRatio);
    note(`window ~${windowWidth}px · narrowest pane ${narrowest}px · compact < ${COMPACT_MAX}px`);

    if (narrowest >= COMPACT_MAX) {
      skip(
        'compact layout assertions',
        `the split floor (${narrowest}px) stays wider than the compact breakpoint ` +
          `on this ${windowWidth}px display`,
      );
    } else {
      await call('set_split_ratio', { ratio: Math.max(minRatio, (COMPACT_MAX - 8) / windowWidth) });
      await sleep(600);
      const panelWidth = Number(await evalIn(panel, 'window.innerWidth'));
      check(
        'the pane is narrower than the compact breakpoint',
        panelWidth < COMPACT_MAX,
        `${panelWidth}px < ${COMPACT_MAX}px`,
      );
      const cards = await pollValue(
        panel,
        `(function () {
           var list = document.querySelector('.business-cards');
           if (!list) return '';
           var card = list.querySelector('.business-card[data-place-id="' + ${JSON.stringify(PLACE)} + '"]');
           return card ? String(list.querySelectorAll('.business-card').length) : '';
         })()`,
        10_000,
      );
      check('rows render as cards with a place-id hook', Number(cards) >= 1, String(cards));

      const tableGone = await evalIn(panel, `!document.querySelector('.table-wrap .ant-table')`);
      check('the table is not mounted in compact mode', tableGone === true, String(tableGone));

      const trigger = await evalIn(
        panel,
        `!!document.querySelector('.filter-bar .filter-trigger')`,
      );
      check('the filter row collapses to one trigger', trigger === true, String(trigger));

      // The sheet is a portal, so it is asserted on the document body.
      await evalIn(panel, `document.querySelector('.filter-trigger').click(), true`);
      const sheet = await pollValue(
        panel,
        `document.querySelector('.filter-sheet') ? 'open' : ''`,
        5_000,
      );
      check('the trigger opens the filter sheet', sheet === 'open', String(sheet));
      await evalIn(
        panel,
        `document.querySelector('.ant-drawer-close')?.click(), true`,
      );
      await sleep(400);

      // The detail drawer must fit inside the panel — the whole point of
      // `drawerWidth`.
      await evalIn(
        panel,
        `document.querySelector('.business-card[data-place-id="' + ${JSON.stringify(PLACE)} + '"] .business-card-body').click(), true`,
      );
      // `.detail-title` only exists inside the detail drawer, so it distinguishes
      // "never opened" from "opened but the wrapper has no width". Looking only
      // for `.ant-drawer-content-wrapper` also finds the filter sheet that was
      // just closed.
      const drawer = await pollValue(
        panel,
        `(function () {
           var title = document.querySelector('.ant-drawer .detail-title');
           if (!title) return '';
           var wrapper = title.closest('.ant-drawer-content-wrapper');
           return wrapper ? String(Math.round(wrapper.getBoundingClientRect().width)) : 'no-wrapper';
         })()`,
        5_000,
      );
      const drawerWidth = Number(drawer);
      check('the detail drawer opens from a card', drawer !== '', String(drawer));
      check(
        'the detail drawer fits inside the panel',
        drawerWidth > 0 && drawerWidth <= panelWidth,
        `${drawerWidth}px vs panel ${panelWidth}px`,
      );
      await evalIn(panel, `document.querySelector('.ant-drawer-close')?.click(), true`);
      await sleep(400);

      // Follow-the-tail has to work here too: the card list is the scroll
      // container in compact mode, and while it was not recognised as one the
      // scroll handler never ran, so `followTailRef` stayed at its initial
      // `true` — new batches never moved the list and the "N new" pill never
      // appeared. No error, just a list that silently stopped following.
      await call('on_business_data', {
        businesses: Array.from({ length: 40 }, (_, i) =>
          seedRow(`e2e-compact-fill-${RUN}-${i}`),
        ),
      });
      await sleep(1_200);

      const parked = await evalIn(
        panel,
        `(function () {
           var list = document.querySelector('.business-cards');
           if (!list) return '';
           if (list.scrollHeight - list.clientHeight <= 24) return 'short';
           // A real move in both directions: assigning the value it already
           // holds fires no scroll event, and the handler would never see the
           // gesture.
           list.scrollTop = list.scrollHeight;
           return 'scrolled';
         })()`,
      );
      await sleep(400);
      const atTop = await evalIn(
        panel,
        `(function () {
           var list = document.querySelector('.business-cards');
           if (!list) return '';
           list.scrollTop = 0;
           return String(list.scrollTop === 0);
         })()`,
      );
      await sleep(600);
      check('the card list is long enough to scroll', parked === 'scrolled', String(parked));
      check('the card list parks at the top', atTop === 'true', String(atTop));

      await call('on_business_data', { businesses: [seedRow(NEW_PLACE)] });
      const arrived = await pollValue(
        panel,
        `document.querySelector('.business-card[data-place-id="' + ${JSON.stringify(NEW_PLACE)} + '"]') ? 'yes' : ''`,
        10_000,
      );
      check('the new row reaches the card list', arrived === 'yes', String(arrived));

      const pill = await pollValue(
        panel,
        `(function () {
           var el = document.querySelector('.new-rows-pill');
           return el ? el.textContent : '';
         })()`,
        10_000,
      );
      check('rows arriving while scrolled away raise the "N new" pill', pill !== '', String(pill));

      await evalIn(panel, `document.querySelector('.new-rows-pill')?.click(), true`);
      const followed = await pollValue(
        panel,
        `(function () {
           var list = document.querySelector('.business-cards');
           if (!list) return '';
           return list.scrollHeight - list.scrollTop - list.clientHeight < 24 ? 'bottom' : '';
         })()`,
        5_000,
      );
      check(
        'clicking the pill scrolls the card list to the newest row',
        followed === 'bottom',
        String(followed),
      );
    }

    // Back to the ratio the run started from, so the next suite sees the layout
    // it expects (`DEFAULT_SPLIT_RATIO` lives in Rust and `SplitHandle.tsx`).
    await call('set_split_ratio', { ratio: originalRatio }).catch(() => {});
    await call('set_listening', { enabled: false }).catch(() => {});
    await sleep(1_000);
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
