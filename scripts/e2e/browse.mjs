#!/usr/bin/env node
/**
 * E2E acceptance for paged browsing (roadmap M6).
 *
 * The panel no longer loads the table into memory: it asks for one page, and
 * SQLite filters, sorts and counts. This suite drives that path with 120
 * synthetic rows:
 *
 *   - the first page shows `pageSize` rows and the pagination knows the total
 *   - turning to page 2 shows the next slice (not a re-render of page 1)
 *   - typing in the search box filters in SQL and resets to page 1
 *   - clicking a sortable header sorts the whole table, not the current page
 *   - the diagnostics drawer has a p95 for the page queries (J-06d)
 *
 * Synthetic rows go through `on_business_data`, so no network is involved.
 *
 * Usage:
 *   npm run e2e:browse
 *   npm run e2e:browse -- --keep-data
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
const ROWS = 120;

/** Native setter + input event: React ignores `element.value = x`. */
const TYPE_INTO = (selector, value) => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  ).set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const tableRowCount = `document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length`;

const tableText = `document.querySelector('.ant-table-tbody')?.innerText || ''`;

const ratings = `[...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')]
  .map((row) => row.querySelector('.rating-cell')?.textContent || '')`;

function buildRows() {
  const rows = [];
  for (let index = 0; index < ROWS; index += 1) {
    const suffix = String(index).padStart(3, '0');
    rows.push({
      place_id: `e2e-${RUN}-${suffix}`,
      name: `E2E Row ${suffix}`,
      address: `${index} Test Street`,
      // Two decimals so the rating column has one; every tenth row is 0.
      phone: `+1 555 ${String(1000 + index)}`,
      rating: (index % 50) / 10,
      reviews_total: index,
      lat: 34.05,
      lng: -118.24,
      // R-24: the first row carries hostile values in both URL fields. They are
      // scraped data, so they must render as text, never as `href`.
      website: index === 0 ? 'javascript:alert(1)' : 'https://example.com',
      socials: index === 0 ? ['javascript:alert(2)'] : [],
      types: index % 10 === 0 ? ['dentist'] : ['plumber'],
    });
  }
  return rows;
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

    // P1 split the panel into collect/data views. This suite drives the table,
    // so it has to open the data view first — the default is the task list.
    await evalIn(
      panel,
      'document.querySelectorAll(".view-switch .ant-segmented-item")[1].click()',
    );
    await pollValue(panel, 'document.querySelector(".table-wrap") !== null', 15_000);

    if (snapshot) {
      await call('clear_data');
      await sleep(400);
    }

    // Page size is a user setting, but this suite drives a 50-row, fully
    // rendered page (a saved 100/200 switches on antd's virtual body, which has
    // a different DOM: no `.ant-table-tbody`, no `.ant-table-body` to measure).
    // Pin it instead of inheriting the machine's value; the database snapshot
    // puts the original back.
    await call('update_settings', { patch: { pageSize: 50 } });
    await sleep(300);

    const pageSize = await evalIn(
      panel,
      `(async () => {
         const settings = await window.__TAURI_INTERNALS__.invoke('get_settings');
         return settings.pageSize;
       })()`,
    );
    check('the suite runs against 50-row pages', pageSize === 50, String(pageSize));

    await call('on_business_data', { businesses: buildRows() });

    // ---- page 1 ----------------------------------------------------------
    const firstPage = await pollValue(panel, tableRowCount, 20_000, 300);
    check('the first page is full', firstPage === pageSize, `${firstPage} rows`);

    // The table body used to keep the `scroll.y` of the very first render: the
    // height was measured in an effect with `[]`, which ran before the data view
    // (and therefore `.table-wrap`) existed, so the value stayed at its 400 px
    // initial state and the rest of the card rendered blank below the rows.
    // Measuring from the DOM is the part that regresses silently, so assert it:
    // the body must sit exactly between the header and the pagination.
    const geometry = await evalIn(
      panel,
      `(() => {
         const wrap = document.querySelector('.table-wrap');
         const body = wrap && wrap.querySelector('.ant-table-body');
         const header = wrap && wrap.querySelector('.ant-table-thead');
         const footer = wrap && wrap.querySelector('.ant-table-pagination');
         if (!wrap || !body || !header || !footer) return null;
         // The pagination carries margin: 8px 12px (App.css), so 16px of it is
         // part of the card's fixed furniture.
         const available =
           wrap.clientHeight - header.offsetHeight - footer.offsetHeight - 16;
         return {
           available,
           content: body.scrollHeight,
           // offsetHeight, not clientHeight: the body has a horizontal
           // scrollbar (scroll.x is set), and scroll.y is a max-height that
           // includes it — clientHeight leaves those ~15px out.
           bodyBox: body.offsetHeight,
           scrollbar: body.offsetHeight - body.clientHeight,
         };
       })()`,
    );
    check(
      'the table body fills the card instead of leaving it blank',
      geometry !== null &&
        Math.abs(
          Math.min(geometry.content + geometry.scrollbar, geometry.available) -
            geometry.bodyBox,
        ) <= 2,
      JSON.stringify(geometry),
    );

    const totalText = await evalIn(
      panel,
      `document.querySelector('.ant-pagination-total-text')?.textContent || ''`,
    );
    check(
      'the pagination knows the total from SQL',
      String(totalText).includes(String(ROWS)),
      String(totalText),
    );

    const stats = await call('query_businesses', {
      request: { page: 1, pageSize },
    });
    check('the query reports both totals', stats.total === ROWS && stats.all === ROWS,
      `${stats.total}/${stats.all}`);

    // R-24: row 000 carries `javascript:` in `website` and `socials`. Whichever
    // column renders them they must stay text: an anchor here would execute in
    // the panel, which holds the Tauri IPC bridge.
    const hostileAnchors = await evalIn(
      panel,
      `document.querySelectorAll('a[href^="javascript:"], a[href^="data:"]').length`,
    );
    check(
      'scraped javascript: URLs never become links',
      hostileAnchors === 0,
      String(hostileAnchors),
    );

    // The drawer is where a user actually clicks a website, and it renders at
    // every panel width (the website column only exists on wide layouts).
    const detailOpened = await evalIn(
      panel,
      `(() => {
         const row = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')]
           .find((tr) => tr.innerText.includes('E2E Row 000'));
         // Skip the selection column: a click there is swallowed by the row
         // handler on purpose (checkbox clicks must not open the drawer).
         const cell = row && row.querySelectorAll('td')[2];
         if (!cell) return false;
         cell.click();
         return true;
       })()`,
    );
    const drawerReady = await pollValue(
      panel,
      `document.querySelector('.ant-drawer .ant-descriptions') !== null`,
      10_000,
      200,
    );
    const drawerText = await evalIn(
      panel,
      `(document.querySelector('.ant-drawer-body') || {}).innerText || ''`,
    );
    const drawerAnchors = await evalIn(
      panel,
      `document.querySelectorAll('.ant-drawer a[href^="javascript:"]').length`,
    );
    check(
      'the detail drawer shows a hostile URL as text',
      detailOpened === true &&
        drawerReady === true &&
        String(drawerText).includes('javascript:alert(1)') &&
        drawerAnchors === 0,
      String(drawerText).slice(0, 80),
    );
    await evalIn(
      panel,
      `(() => { const close = document.querySelector('.ant-drawer-close'); if (close) close.click(); return true; })()`,
    );
    await sleep(400);

    // R-23: the panel refreshes its selection snapshot through this command
    // after a bulk write (email mining is the routine case). Proving the
    // channel returns the *new* row is the part a stale ref would break.
    await call('update_settings', { patch: { duplicateStrategy: 'update' } });
    const rewritten = { ...buildRows()[0], phone: '+1 555 0000' };
    await call('on_business_data', { businesses: [rewritten] });
    await sleep(600);
    const refreshed = await call('selected_businesses', {
      placeIds: [rewritten.place_id],
    });
    check(
      'the selection refresh channel returns the newest row',
      Array.isArray(refreshed) &&
        refreshed.length === 1 &&
        refreshed[0].phone === '+1 555 0000',
      JSON.stringify(refreshed[0]?.phone ?? null),
    );
    await call('update_settings', { patch: { duplicateStrategy: 'ignore' } });

    // ---- page 2 ----------------------------------------------------------
    const turned = await evalIn(
      panel,
      `(() => {
         const item = document.querySelector('.ant-pagination-item-2 a');
         if (!item) return false;
         item.click();
         return true;
       })()`,
    );
    check('the pagination offers a second page', turned === true);

    const secondPageReady = await pollValue(
      panel,
      `${tableRowCount} === ${pageSize} && document.querySelector('.ant-table-tbody').innerText.includes('E2E Row ${String(pageSize).padStart(3, '0')}')`,
      15_000,
      300,
    );
    check('page 2 shows the next slice', secondPageReady === true);

    // ---- server-side text filter -----------------------------------------
    await evalIn(panel, `(() => { const item = document.querySelector('.ant-pagination-item-1 a'); if (item) item.click(); return true; })()`);
    await pollValue(panel, `${tableRowCount} === ${pageSize}`, 10_000, 200);

    const typed = await evalIn(panel, TYPE_INTO('.filter-search input', 'Row 01'));
    check('the search box accepts input', typed === true);

    // `tableRowCount` alone is truthy at 50, so poll for the filtered count.
    const filteredRows = await pollValue(panel, `${tableRowCount} === 10`, 10_000, 300);
    check(
      'the text filter runs in SQL and resets the page',
      filteredRows === true,
      'expected 10 rows',
    );
    check(
      'the filter dropped the other rows from the DOM',
      (await evalIn(panel, tableText)).includes('E2E Row 010') &&
        !(await evalIn(panel, tableText)).includes('E2E Row 020'),
      'checked first/last match',
    );
    check(
      'blanking the filter restores the full set',
      await pollValue(
        panel,
        `(() => {
           const input = document.querySelector('.filter-search input');
           if (!input) return false;
           const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
           setter.call(input, '');
           input.dispatchEvent(new Event('input', { bubbles: true }));
           return ${tableRowCount} === ${pageSize};
         })()`,
        10_000,
        300,
      ) === true,
    );

    // ---- sort whole table, not the page ----------------------------------
    const clickRating = `(() => {
      const headers = [...document.querySelectorAll('.ant-table-thead th.ant-table-column-has-sorters')];
      const target = headers.find((th) => th.innerText.trim().length > 0 && th !== headers[0]) ||
        headers[1];
      if (!target) return false;
      target.click();
      return true;
    })()`;
    check('the rating header is sortable', (await evalIn(panel, clickRating)) === true);

    const ascending = await pollValue(
      panel,
      `${ratings}[0] === '—' || ${ratings}[0] === ''`,
      10_000,
      300,
    );
    check('ascending sort puts the unrated row first', ascending === true);

    await evalIn(panel, clickRating);
    // 4.9 is the top rating in this data set (50 steps of 0.1), not 5.0.
    const descending = await pollValue(panel, `${ratings}[0] === '4.9'`, 10_000, 300);
    check(
      'descending sort starts at the highest rating in the table',
      descending === true,
    );
    const sortedText = await evalIn(panel, tableText);
    check(
      'sorting is not limited to the current page',
      sortedText.includes('E2E Row 049') && !sortedText.includes('E2E Row 050'),
      'row 049 (4.9) is on page 1, row 050 (0.0) is not',
    );

    // ---- R-18: 100-row pages render through the virtual body -------------
    // The table only virtualizes at 100+ rows per page; smaller pages keep the
    // full DOM. Switch the page size through the pager, then check that the
    // virtual body took over and the first row is still the right one.
    await evalIn(
      panel,
      `(() => {
         const selector = document.querySelector('.ant-pagination-options .ant-select-selector');
         if (!selector) return false;
         selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         selector.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
         selector.click();
         return true;
       })()`,
    );
    await sleep(400);
    const pickedSize = await evalIn(
      panel,
      `(() => {
         const option = [...document.querySelectorAll('.ant-select-item-option')]
           .find((el) => el.textContent.trim().startsWith('100'));
         if (!option) return false;
         option.click();
         return true;
       })()`,
    );
    check('the pager offers a 100-row page size', pickedSize === true);

    const virtualDom = `document.querySelectorAll('.ant-table-tbody-virtual [data-row-key]').length`;
    const virtualBody = await pollValue(
      panel,
      `document.querySelectorAll('.ant-table-tbody-virtual').length === 1`,
      10_000,
      300,
    );
    check('a 100-row page renders through the virtual body', virtualBody === true);
    const bounded = await pollValue(
      panel,
      `(() => { const n = ${virtualDom}; return n > 0 && n < 100; })()`,
      10_000,
      300,
    );
    check('virtual rendering keeps the DOM bounded', bounded === true, `${await evalIn(panel, virtualDom)} rows`);
    // The rating sort from above is still active, so the first visible row is
    // the 4.9 one; the virtual body must render it like the plain body did.
    const virtualText = await evalIn(panel, tableText);
    check(
      'the virtual body renders the top of the current page',
      virtualText.includes('E2E Row 049'),
      'row 049 (4.9) leads the descending sort',
    );

    // Back to 50/page so the remaining checks see the same table as before.
    await evalIn(
      panel,
      `(() => {
         const selector = document.querySelector('.ant-pagination-options .ant-select-selector');
         if (!selector) return false;
         selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         selector.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
         selector.click();
         return true;
       })()`,
    );
    await sleep(400);
    await evalIn(
      panel,
      `(() => {
         const option = [...document.querySelectorAll('.ant-select-item-option')]
           .find((el) => el.textContent.trim().startsWith('50'));
         if (!option) return false;
         option.click();
         return true;
       })()`,
    );
    await pollValue(
      panel,
      `document.querySelectorAll('.ant-table-tbody-virtual').length === 0`,
      10_000,
      300,
    );

    // ---- diagnostics p95 -------------------------------------------------
    const diag = await call('get_diagnostics');
    check(
      'the diagnostics drawer has a query p95',
      typeof diag.query_p95_ms === 'number' && diag.query_p95_ms >= 0,
      `${diag.query_p95_ms} ms / ${diag.query_samples} samples`,
    );

    note(`p95 across ${diag.query_samples} page queries: ${diag.query_p95_ms} ms`);

    // ---- R-13: clear -> undo round trip through the SQL snapshot ---------
    // The snapshot now lives in `*_backup` tables inside the database, so the
    // undo path is: commands -> AppState window -> SQL restore -> panel
    // refresh. Everything below stays inside the 10 s window.
    await call('clear_data');
    await sleep(400);
    const afterClear = await call('query_businesses', {
      request: { page: 1, pageSize: 1 },
    });
    check('the clear empties the table', afterClear.total === 0, `${afterClear.total} rows`);

    const restored = await call('undo_clear');
    check('undo restores every cleared row', restored === ROWS, `${restored} rows`);
    const afterUndo = await call('query_businesses', {
      request: { page: 1, pageSize: 1 },
    });
    check(
      'the restored rows are queryable again',
      afterUndo.total === ROWS,
      `${afterUndo.total} rows`,
    );
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
