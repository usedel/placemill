#!/usr/bin/env node
/**
 * Feasibility spike for TIER-2 detail enrichment (the gosom teardown §5.3).
 *
 * Tier-2 = per-business detail visit: navigate the maps pane to the place
 * page, read the place-detail payload out of `APP_INITIALIZATION_STATE[3]`
 * (the same positional array gosom parses as `jd[6]`), and extract the fields
 * the search payload never fills (price level, business status, plus_code,
 * description, rating distribution, photos, popular times, menus, cid…).
 *
 * The open question is the same one M8 answered for the search payload, now
 * for the DETAIL payload: which of gosom's indices actually carry values?
 * This spike answers it with the shipped index probe — no new parser code:
 *
 *   1. navigate to a place page;
 *   2. scan APP_INITIALIZATION_STATE[3] (gosom-style: every nested string
 *      that starts with the XSSI prefix), identify the place-detail payload
 *      (the one whose `jd[6][11]` is the place name);
 *   3. feed `jd[6]` into `__placemillIndexProbeRows` — the same 61 candidate
 *      paths documented in `docs/parser.md` §2, because the detail array is
 *      structurally the same array the search payload carries;
 *   4. walk the top-level `jd` for cid-shaped values (long digit strings —
 *      gosom reads `jd[25][3][0][13][0][0][1]` in ITS payload);
 *   5. save the payload as a fixture for the future parser's e2e;
 *   6. repeat on a second business type (a restaurant — price levels and
 *      popular times are business-type dependent).
 *
 * Run: node scripts/e2e/spike-detail-enrichment.mjs
 */
import { writeFileSync } from 'node:fs';

import {
  backupDatabase,
  evalMaps,
  launchApp,
  openPanel,
  pollMaps,
  preflight,
  restoreDatabase,
  sleep,
  stopApp,
  withTimeout,
} from './harness.mjs';

const PLACE_URL =
  'https://www.google.com/maps/place/?q=place_id:ChIJI7IvT70zjoARVt733pqF6Uc'; // Capitol Nissan
const SECOND_SEARCH_URL =
  'https://www.google.com/maps/search/starbucks/@37.33,-121.89,14z?hl=en';

const startedAt = Date.now();
const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
function step(label) {
  console.log('[' + elapsed() + 's] ' + label);
}
async function guard(label, promise, ms = 40_000) {
  return withTimeout(promise, ms, label);
}

const snapshot = backupDatabase();
let failed = false;

function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  [' + String(detail).slice(0, 240) + ']');
  if (!ok) failed = true;
}

/// Navigate the maps pane and wait for the page to settle.
async function gotoMaps(url, settleMs) {
  await guard(
    'navigate',
    evalMaps('location.href = ' + JSON.stringify(url) + '; true'),
    20_000,
  );
  await sleep(settleMs);
}

/// On a search page, click the first place link. Returns the link's own href —
/// the SPA panel does NOT change `location.href` (measured), so the anchor
/// attribute is the only reliable place URL on this page.
async function clickFirstPlaceResult() {
  return String(
    await guard(
      'click-result',
      evalMaps(
        '(function () {' +
          '  const link = document.querySelector(\'a[href*="/maps/place/"]\');' +
          '  if (!link) return JSON.stringify({ clicked: false });' +
          '  const href = link.href;' +
          '  link.click();' +
          '  return JSON.stringify({ clicked: true, href: href });' +
          '})()',
      ),
      15_000,
    ),
  );
}

/// Scan APP_INITIALIZATION_STATE[3] for XSSI-prefixed payload strings and
/// identify the place-detail one (jd[6][11] is the place name). Read-only.
async function findDetailPayload() {
  return JSON.parse(
    await guard(
      'scan-state',
      evalMaps(
        '(function () {' +
          '  const state = window.APP_INITIALIZATION_STATE;' +
          '  const bucket = state && state[3];' +
          '  if (!bucket) return JSON.stringify({ error: "no state[3]" });' +
          '  const found = [];' +
          '  const scan = function (node, path, depth) {' +
          '    if (depth > 8 || found.length > 12) return;' +
          '    if (typeof node === "string") {' +
          '      if (node.slice(0, 4) === ")]}\'" && node.length > 2000) {' +
          '        found.push({ path: path, bytes: node.length, head: node.slice(0, 60) });' +
          '      }' +
          '      return;' +
          '    }' +
          '    if (Array.isArray(node)) {' +
          '      for (let i = 0; i < node.length; i++) scan(node[i], path + "[" + i + "]", depth + 1);' +
          '      return;' +
          '    }' +
          '    if (node && typeof node === "object") {' +
          '      for (const k in node) scan(node[k], path + "." + k, depth + 1);' +
          '    }' +
          '  };' +
          '  scan(bucket, "$[3]", 0);' +
          '  return JSON.stringify({ candidates: found });' +
          '})()',
      ),
      20_000,
    ),
  );
}

/// For the place-detail payload: parse it, verify the identity (jd[6][11] is
/// the place name), return { matches, first: { path, bytes, name, detail } }
/// where detail is jd[6]. The direct `Dg[6]` slot is tried first (the slot
/// both place samples used); a bounded scan is the fallback — a
/// place-over-search page holds several multi-hundred-KB payloads and parsing
/// them all in one eval timed out (measured). Raw control bytes are stripped
/// exactly the way the shipping sanitizer does before JSON.parse.
async function identifyAndExtract() {
  return JSON.parse(
    await guard(
      'extract-detail',
      evalMaps(
        '(function () {' +
          '  const state = window.APP_INITIALIZATION_STATE;' +
          '  const bucket = state && state[3];' +
          '  if (!bucket) return JSON.stringify({ error: "no state[3]" });' +
          '  const stripped = function (text) { return text.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/g, ""); };' +
          '  const check = function (text, path) {' +
          '    let jd = null;' +
          '    try { jd = JSON.parse(stripped(text.slice(5))); } catch (e) { return null; }' +
          '    if (jd && Array.isArray(jd[6]) && typeof jd[6][11] === "string") {' +
          '      return { path: path, bytes: text.length, name: jd[6][11], detail: jd[6] };' +
          '    }' +
          '    return null;' +
          '  };' +
          '  let match = null;' +
          '  if (bucket.Dg && typeof bucket.Dg[6] === "string" && bucket.Dg[6].slice(0, 4) === ")]}\'") {' +
          '    match = check(bucket.Dg[6], "$[3].Dg[6]");' +
          '  }' +
          '  if (!match) {' +
          '    const scan = function (node, path, depth) {' +
          '      if (match || depth > 8) return;' +
          '      if (typeof node === "string") {' +
          '        if (node.slice(0, 4) === ")]}\'" && node.length > 2000) {' +
          '          match = check(node, path);' +
          '        }' +
          '        return;' +
          '      }' +
          '      if (Array.isArray(node)) {' +
          '        for (let i = 0; i < node.length && !match; i++) scan(node[i], path + "[" + i + "]", depth + 1);' +
          '        return;' +
          '      }' +
          '      if (node && typeof node === "object") {' +
          '        for (const k in node) { if (match) break; scan(node[k], path + "." + k, depth + 1); }' +
          '      }' +
          '    };' +
          '    scan(bucket, "$[3]", 0);' +
          '  }' +
          '  return JSON.stringify({ matches: match ? 1 : 0, first: match });' +
          '})()',
      ),
      60_000,
    ),
  );
}

/// Walk the parsed top-level jd for cid-shaped values (15–25 digit strings)
/// plus the gosom path, so we learn whether cid lives anywhere reachable.
async function scanCid(detailName) {
  return JSON.parse(
    await guard(
      'scan-cid',
      evalMaps(
        '(function () {' +
          '  const state = window.APP_INITIALIZATION_STATE;' +
          '  const bucket = state && state[3];' +
          '  const needle = ' + JSON.stringify(detailName) + ';' +
          '  let target = null;' +
          '  const find = function (node, path, depth) {' +
          '    if (target || depth > 8) return;' +
          '    if (typeof node === "string") {' +
          '      if (node.slice(0, 4) === ")]}\'" && node.indexOf(needle) !== -1) target = node;' +
          '      return;' +
          '    }' +
          '    if (Array.isArray(node)) {' +
          '      for (let i = 0; i < node.length && !target; i++) find(node[i], path + "[" + i + "]", depth + 1);' +
          '      return;' +
          '    }' +
          '    if (node && typeof node === "object") {' +
          '      for (const k in node) { if (target) break; find(node[k], path + "." + k, depth + 1); }' +
          '    }' +
          '  };' +
          '  if (bucket) find(bucket, "$[3]", 0);' +
          '  if (!target) return JSON.stringify({ error: "payload not found" });' +
          '  let jd = null;' +
          '  try { jd = JSON.parse(target.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/g, "").slice(5)); } catch (e) {' +
          '    return JSON.stringify({ error: "parse: " + (e && e.message ? e.message : e) });' +
          '  }' +
          '  const out = { gosomPath: null, cidShaped: [] };' +
          '  try { out.gosomPath = (jd[25] && jd[25][3] && jd[25][3][0] && jd[25][3][0][13] && jd[25][3][0][13][0] && jd[25][3][0][13][0][0] && jd[25][3][0][13][0][0][1]) || null; } catch (e) { /* path absent */ }' +
          '  const walk = function (node, path, depth) {' +
          '    if (depth > 12 || out.cidShaped.length >= 5) return;' +
          '    if (typeof node === "string") {' +
          '      if (/^\\d{15,25}$/.test(node)) out.cidShaped.push({ path: path, value: node });' +
          '      return;' +
          '    }' +
          '    if (Array.isArray(node)) {' +
          '      for (let i = 0; i < node.length; i++) walk(node[i], path + "[" + i + "]", depth + 1);' +
          '      return;' +
          '    }' +
          '    if (node && typeof node === "object") {' +
          '      for (const k in node) walk(node[k], path + "." + k, depth + 1);' +
          '    }' +
          '  };' +
          '  walk(jd, "jd", 0);' +
          '  return JSON.stringify(out);' +
          '})()',
      ),
      30_000,
    ),
  );
}

/// Poll for the detail payload: after an SPA navigation the state rebuilds
/// asynchronously, so one scan right after the click misses it.
async function waitForDetailPayload(budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = { matches: 0, first: null, error: 'no scan' };
  while (Date.now() < deadline) {
    last = await identifyAndExtract();
    if (last.first) return last;
    await sleep(2000);
  }
  return last;
}

try {
  step('preflight');
  await guard('preflight', preflight(), 20_000);
  step('launchApp');
  await guard('launchApp', launchApp(), 240_000);
  step('openPanel');
  await guard('openPanel', openPanel(), 180_000);
  step('等待 maps 页注入');
  await guard('maps-ready', pollMaps('typeof window.__placemillIndexProbeRows === "function"', 60_000), 70_000);

  const samples = [];

  // ---- sample 1: the known-good place --------------------------------------
  step('样本 1：Capitol Nissan（进 place 页）');
  await gotoMaps(PLACE_URL, 10_000);
  {
    const candidates = await findDetailPayload();
    console.log('    XSSI 载荷候选 =', JSON.stringify((candidates.candidates || []).map((c) => ({ path: c.path, bytes: c.bytes }))));
    const found = await waitForDetailPayload(10_000);
    console.log(
      '    详情载荷 =',
      found.matches,
      '个匹配 | 名称 =',
      found.first && found.first.name,
      '| 路径 =',
      found.first && found.first.path,
      '| 字节 =',
      found.first && found.first.bytes,
    );
    check('样本 1：place 页状态里有详情载荷（jd[6] 同构）', Boolean(found.first), found.error || '无');
    if (found.first) {
      const cid = await scanCid(found.first.name);
      console.log(
        '    cid 扫描 = gosomPath:',
        JSON.stringify(cid.gosomPath),
        '| 15–25 位数字串 =',
        JSON.stringify((cid.cidShaped || []).map((c) => c.path + '=' + String(c.value).slice(0, 20))),
      );
      samples.push({ label: 'capitol-nissan', found: found.first, cid: cid });
    }
  }

  // ---- sample 2: a restaurant (search → click first result) ----------------
  step('样本 2：餐厅（搜索 → 点击拿链接 href → 硬导航 → 轮询详情载荷）');
  await gotoMaps(SECOND_SEARCH_URL, 8_000);
  const clicked = JSON.parse(await clickFirstPlaceResult());
  console.log('    点击结果 =', clicked.clicked, '| 链接 href =', String(clicked.href || '').slice(0, 110));
  if (!clicked.clicked || !clicked.href) {
    check('样本 2：搜索结果里有可点的 place 链接', false, 'no link');
  }
  // The click is SPA navigation and does NOT rebuild APP_INITIALIZATION_STATE
  // (measured). Tier-2 enrichment hard-navigates each place URL anyway (the
  // collector's `__placemillGoto` contract), so prove exactly that: take the
  // anchor's own href, hard-navigate to it, and the payload must appear.
  const placeHref = String(clicked.href || '');
  if (placeHref) {
    await gotoMaps(placeHref, 6_000);
    const found = await waitForDetailPayload(20_000);
    console.log(
      '    详情载荷 =',
      found.matches,
      '个匹配 | 名称 =',
      found.first && found.first.name,
      '| 字节 =',
      found.first && found.first.bytes,
    );
    check('样本 2：硬导航后餐厅详情载荷出现（富化导航契约成立）', Boolean(found.first), found.error || '无');
    if (found.first) {
      const cid = await scanCid(found.first.name);
      console.log(
        '    cid 扫描 = gosomPath:',
        JSON.stringify(cid.gosomPath),
        '| 15–25 位数字串 =',
        JSON.stringify((cid.cidShaped || []).map((c) => c.path + '=' + String(c.value).slice(0, 20))),
      );
      samples.push({ label: 'restaurant', found: found.first, cid: cid });
    }
  }

  // ---- probe: run the shipped index probe over both detail arrays ----------
  if (samples.length) {
    step('索引探针：' + samples.length + ' 个详情数组过 61 条候选路径');
    const detailArraysJson = JSON.stringify(samples.map((s) => s.found.detail));
    // The probe wants real arrays; cross the eval boundary as a JSON string
    // and parse it inside the page.
    const probe = JSON.parse(
      await guard(
        'probe',
        evalMaps(
          '(function () { return JSON.stringify(window.__placemillIndexProbeRows(JSON.parse(' +
            JSON.stringify(detailArraysJson) +
            '))); })()',
        ),
        30_000,
      ),
    );
    check('探针：跑通 ' + samples.length + ' 个样本', probe.ready === true, probe.error || (probe.records || []).length + ' 条路径');
    const records = probe.records || [];
    // Compact fill table: one line per candidate path.
    console.log('');
    console.log('==== 详情载荷填充率（' + samples.length + ' 个样本） ====');
    for (const record of records) {
      const inRange = record.inRange ?? 0;
      const filled = record.filled ?? 0;
      const rows = record.rows ?? samples.length;
      if (filled === 0 && inRange === 0) continue; // not even in range — uninteresting
      const firstShape =
        record.steps && record.steps.length
          ? record.steps.map((s) => s.at.join('.') + ':' + s.kind + (s.sample !== undefined ? '(' + String(s.sample).slice(0, 24) + ')' : '')).join(' ')
          : '';
      console.log(
        (filled > 0 ? '  ✔ ' : '  · ') +
          String(record.want).padEnd(26) +
          ' ' +
          filled + '/' + rows + ' filled, ' + inRange + '/' + rows + ' inRange' +
          (firstShape ? '  | ' + firstShape.slice(0, 150) : ''),
      );
    }
    // Save each payload as a parser fixture (M8/M9 practice).
    for (const sample of samples) {
      const fixture = JSON.stringify(sample.found.detail);
      const name = 'scripts/e2e/fixtures/detail-place-payload-' + sample.label + '.json';
      writeFileSync(name, fixture);
      console.log('    已存夹具 ' + name + '（', fixture.length, '字符 ✅）');
    }
  }
} catch (e) {
  console.log('尖峰中止:', e && e.message ? e.message : e);
  failed = true;
  try {
    const state = await withTimeout(
      evalMaps(
        'JSON.stringify({ url: location.href, title: document.title, text: (document.body.innerText || "").slice(0, 200) })',
      ),
      8000,
      'stall-dump',
    );
    console.log('现场:', state);
  } catch (inner) {
    console.log('现场取不到:', inner && inner.message ? inner.message : inner);
  }
  process.exitCode = 1;
} finally {
  step('收尾');
  await withTimeout(stopApp(), 60_000, 'stopApp').catch((e) => console.log('stopApp:', e.message));
  try {
    restoreDatabase(snapshot);
  } catch (e) {
    console.log('restoreDatabase:', e.message);
  }
  step('结束');
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: PASSED');
}
