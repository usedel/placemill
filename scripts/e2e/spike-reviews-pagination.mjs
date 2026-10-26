#!/usr/bin/env node
/**
 * Feasibility spike for M9 review PAGINATION (the last open item of M9).
 *
 * Known today (see `docs/parser.md`;  + the M9 final form):
 *   - the page's own qv9Egd answer is the primary reviews source
 *     (`lastQv9Full`), and `parseReviewsPayload` returns its nextToken —
 *     but nobody has yet shown a request that fetches PAGE 2;
 *   - qv9Egd comes and goes server-side (empty frames for everyone on
 *     2026-10-25 afternoon, alive again later, empty again on the 26th);
 *   - the reviews_link payload (search.google.com/local/reviews) carries a
 *     short first batch (~6 reviews, fixture) plus a `2ahUKE…`-shaped token.
 *
 * Method — the page teaches us, we never guess (the M9 lesson: body diff
 * first, replay second):
 *   1. open a place with thousands of reviews, click the reviews tab;
 *   2. capture page 1 from whatever channel is alive (qv9Egd capture, or the
 *      page's own /local/reviews traffic read via CDP);
 *   3. scroll the reviews panel; every request the page issues for
 *      qv9Egd / /local/reviews is logged with its FULL url (CDP);
 *   4. GROUND TRUTH: diff the page-1 vs page-2 evidence — the qv9Egd inner
 *      JSON elements, or the /local/reviews query params — the differing
 *      slot IS the pagination contract;
 *   5. REPLAY page 2 (and 3) ourselves and verify: new reviews, zero
 *      overlap with page 1, attribution intact.
 *
 * Verdict: "PAGINATION: YES (channel …)" when step 5 demonstrates a second
 * page. If the page's own traffic is empty too, the run says INCONCLUSIVE
 * (soft-block), not failure.
 *
 * Run: node scripts/e2e/spike-reviews-pagination.mjs        (passive only)
 *      node scripts/e2e/spike-reviews-pagination.mjs --post (allow the two
 *      constructed qv9Egd POSTs — NEVER on a logged-in profile: they hit
 *      Google with the account's cookies; the user decided 2026-10-26 that
 *      account risk is not acceptable, so passive is the default)
 */
import { writeFileSync } from 'node:fs';

import {
  backupDatabase,
  evalMaps,
  launchApp,
  listTargets,
  openPanel,
  pollMaps,
  preflight,
  restoreDatabase,
  sleep,
  stopApp,
  withTimeout,
} from './harness.mjs';
import { cdpClient } from './cdp.mjs';

// A place with thousands of reviews (the M9 baseline store).
const PLACE_URL =
  'https://www.google.com/maps/place/?q=place_id:ChIJI7IvT70zjoARVt733pqF6Uc';

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
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  [' + String(detail).slice(0, 220) + ']');
  if (!ok) failed = true;
}

// ---------- helpers ----------

/// Decode a captured f.req body into the inner JSON array (null on
/// truncation; CDP postData is complete, `qv9Calls` keeps 4 KB).
function innerFromBody(body) {
  try {
    const raw = decodeURIComponent(String(body).replace(/^f\.req=/, '').replace(/&+$/, ''));
    const outer = JSON.parse(raw);
    const innerStr = outer && outer[0] && outer[0][0] && outer[0][0][1];
    if (typeof innerStr !== 'string') return null;
    return JSON.parse(innerStr);
  } catch (e) {
    return null;
  }
}

function tokenOf(inner) {
  return inner && Array.isArray(inner[4]) && typeof inner[4][0] === 'string' ? inner[4][0] : null;
}

function diffInner(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const sa = i < a.length ? JSON.stringify(a[i]) : '(absent)';
    const sb = i < b.length ? JSON.stringify(b[i]) : '(absent)';
    if (sa !== sb) out.push({ index: i, page1: sa.slice(0, 180), page2: sb.slice(0, 180) });
  }
  return out;
}

/// Query params of a /local/reviews URL as a map for diffing.
function linkParams(url) {
  const out = {};
  const q = String(url).split('?')[1] || '';
  for (const pair of q.split('&')) {
    const at = pair.indexOf('=');
    if (at === -1) continue;
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

function reviewKey(r) {
  return [r.author, r.created_at_us, r.stars, String(r.text || '').length].join('|');
}

/// Reviews bodies for /local/reviews answers are read via CDP (the page
/// cannot read that origin; the Service Worker may hide some bodies, hence
/// the tolerance for failures).
async function readResponseBody(cdp, requestId) {
  try {
    const r = await withTimeout(cdp.send('Network.getResponseBody', { requestId }), 10_000, 'body');
    return r && typeof r.body === 'string' ? r.body : '';
  } catch (e) {
    return '';
  }
}

/// Poll the session until qv9Calls grows past `seen`; then read the fresh
/// full qv9Egd answer.
async function waitNextQv9(seen, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const s = JSON.parse(
      await guard('session', evalMaps('JSON.stringify(window.__placemillReviewsSession())'), 15_000),
    );
    if ((s.qv9Calls || []).length > seen) {
      await sleep(1500);
      const full = JSON.parse(
        await guard(
          'read-full',
          evalMaps('JSON.stringify(window.__placemillReviewsSession().lastQv9Full || "")'),
          15_000,
        ),
      );
      return { session: s, full: full };
    }
    await sleep(400);
  }
  return { session: null, full: '' };
}

/// Scroll the reviews panel. Tries several anchors, scrolls each first
/// scrollable ancestor; returns a short human-readable report.
async function scrollReviews() {
  return String(
    await guard(
      'scroll',
      evalMaps(
        '(function () {' +
          '  const seen = new Set(); const report = [];' +
          '  const anchors = [];' +
          '  const rev = document.querySelector("[data-review-id], .jftiEf");' +
          '  if (rev) anchors.push(rev);' +
          '  document.querySelectorAll("[role=tabpanel]").forEach(function (t) { anchors.push(t); });' +
          '  const main = document.querySelector("[role=main]");' +
          '  if (main) anchors.push(main);' +
          '  anchors.push(document.scrollingElement);' +
          '  for (const a of anchors) {' +
          '    let el = a;' +
          '    while (el && el.scrollHeight <= el.clientHeight + 40) el = el.parentElement;' +
          '    if (!el || seen.has(el)) continue;' +
          '    seen.add(el);' +
          '    const before = el.scrollTop;' +
          '    el.scrollTop = Math.min(el.scrollHeight, before + el.clientHeight * 0.9);' +
          '    report.push(el.tagName + ":" + before + "->" + el.scrollTop + "/" + el.scrollHeight);' +
          '  }' +
          '  return report.join(" | ") || "no-scrollable";' +
          '})()',
      ),
      15_000,
    ),
  );
}

/// One constructed qv9Egd request: token into inner[4][0], send, parse.
async function postQv9WithToken(hex, token, bgkey) {
  const built = JSON.parse(
    await guard(
      'build',
      evalMaps(
        'JSON.stringify(window.__placemillBuildReviewsRequest(' +
          JSON.stringify(hex) +
          ', ' +
          JSON.stringify({ token: token, bgkey: bgkey }) +
          '))',
      ),
      10_000,
    ),
  );
  if (!built.ok) return { status: 0, len: 0, parsed: null, text: '', error: built.error || 'build failed' };
  const live = JSON.parse(
    await guard(
      'post',
      evalMaps(
        '(async () => {' +
          '  const res = await fetch(' +
          JSON.stringify(built.url) +
          ', { method: "POST", credentials: "include", headers: ' +
          JSON.stringify(built.headers) +
          ', body: ' +
          JSON.stringify(built.body) +
          ' });' +
          '  const text = await res.text();' +
          '  return JSON.stringify({ status: res.status, len: text.length, text: text });' +
          '})()',
      ),
      40_000,
    ),
  );
  const parsed = live.len
    ? JSON.parse(
        await guard(
          'parse',
          evalMaps('JSON.stringify(window.__placemillParseReviews(' + JSON.stringify(live.text) + '))'),
          30_000,
        ),
      )
    : null;
  return { status: live.status, len: live.len, parsed: parsed, text: live.text || '' };
}

/// Fetch a /local/reviews URL from the page (cross-origin: credentials
/// omitted first, then the same-origin www variant — the M9 direct ladder).
async function fetchLinkUrl(url) {
  return JSON.parse(
    await guard(
      'fetch-link',
      evalMaps(
        '(async () => {' +
          '  const variants = [' +
          '    { url: ' + JSON.stringify(url) + ', credentials: "omit" },' +
          '    { url: ' + JSON.stringify(String(url).replace("//search.google.com/", "//www.google.com/")) + ', credentials: "omit" }' +
          '  ];' +
          '  const notes = [];' +
          '  for (let i = 0; i < variants.length; i++) {' +
          '    try {' +
          '      const res = await fetch(variants[i].url, { credentials: variants[i].credentials });' +
          '      const text = await res.text();' +
          '      notes.push("try" + i + ":status=" + res.status + ",len=" + text.length);' +
          '      if (text.length > 500) return JSON.stringify({ status: res.status, len: text.length, text: text, notes: notes.join("|") });' +
          '    } catch (e) { notes.push("try" + i + ":" + (e && e.message ? e.message : e)); }' +
          '  }' +
          '  return JSON.stringify({ status: 0, len: 0, text: "", notes: notes.join("|") });' +
          '})()',
      ),
      40_000,
    ),
  );
}

try {
  step('preflight');
  await guard('preflight', preflight(), 20_000);
  step('launchApp');
  await guard('launchApp', launchApp(), 240_000);
  step('openPanel');
  await guard('openPanel', openPanel(), 180_000); // inner budgets: 60s ipc + 90s react
  step('等待 maps 页注入');
  await guard('maps-ready', pollMaps('typeof window.__placemillAutoScroll === "object"', 60_000), 70_000);

  step('进商家页');
  await guard(
    'navigate-place',
    evalMaps('location.href = ' + JSON.stringify(PLACE_URL) + '; true'),
    20_000,
  );
  await sleep(10_000);

  const targets = await guard('listTargets', listTargets(), 15_000);
  const wsUrl =
    targets.find((t) => t.type === 'webview' && t.url.includes('google.com/maps'))
      ?.webSocketDebuggerUrl ||
    targets.find((t) => t.type === 'page' && t.url.includes('google.com/maps'))
      ?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('no maps target to attach to');
  const cdp = cdpClient(wsUrl);
  await withTimeout(cdp.ready, 15_000, 'cdp-ready');
  await guard('Network.enable', cdp.send('Network.enable'), 15_000);

  step('点评价标签（页面自己发第 1 页请求）');
  await guard(
    'click-reviews',
    evalMaps(
      '(function () {' +
        '  const labels = ["评价", "評價", "Reviews"];' +
        '  const nodes = Array.from(document.querySelectorAll("button, [role=tab], li"));' +
        '  for (const label of labels) {' +
        '    const hit = nodes.find(function (n) { return (n.textContent || "").trim() === label; });' +
        '    if (hit) { hit.click(); return "clicked:" + label; }' +
        '  }' +
        '  return "not-found";' +
        '})()',
    ),
    20_000,
  );
  await sleep(4000);

  // Aliveness retry: the endpoint flaps (§6.5); a second tab open sometimes
  // lands on a warm server. Click away, click back, re-read the capture.
  {
    const quick = String(
      await guard(
        'read-quick',
        evalMaps('JSON.stringify((window.__placemillReviewsSession().lastQv9Full || "").length)'),
        15_000,
      ),
    );
    if (Number(quick) < 1000) {
      console.log('    首次点击的 qv9Egd 响应为空（', quick, '字符）→ 切走再切回，给端点第二次机会');
      await guard(
        'click-away',
        evalMaps(
          '(function () { const hit = Array.from(document.querySelectorAll("button, [role=tab], li")).find(function (n) { return (n.textContent || "").trim() === "概览" || (n.textContent || "").trim() === "Overview"; }); if (hit) { hit.click(); return "ok"; } return "not-found"; })()',
        ),
        15_000,
      );
      await sleep(1200);
      await guard(
        'click-reviews-2',
        evalMaps(
          '(function () { const labels = ["评价", "評價", "Reviews"]; const nodes = Array.from(document.querySelectorAll("button, [role=tab], li")); for (const label of labels) { const hit = nodes.find(function (n) { return (n.textContent || "").trim() === label; }); if (hit) { hit.click(); return "clicked:" + label; } } return "not-found"; })()',
        ),
        15_000,
      );
      await sleep(4000);
    }
  }

  // ---------- snapshot CDP traffic so far (page 1 evidence) ----------------
  const requestsOf = (pattern) =>
    cdp.events
      .filter((e) => e.method === 'Network.requestWillBeSent')
      .map((e) => ({ req: e.params.request, id: e.params.requestId }))
      .filter((x) => String(x.req.url || '').indexOf(pattern) !== -1);

  const qv9All = requestsOf('qv9Egd');
  const linkAll = requestsOf('/local/reviews');
  console.log(
    '    CDP：qv9Egd 请求 =',
    qv9All.length,
    '| /local/reviews 请求 =',
    linkAll.length,
  );
  for (const x of linkAll) console.log('      link:', String(x.req.url).slice(0, 150));

  // Page-1 reviews, channel A: the page's own qv9Egd answer.
  const session = JSON.parse(
    await guard('session-1', evalMaps('JSON.stringify(window.__placemillReviewsSession())'), 15_000),
  );
  const full1 = String(session.lastQv9Full || '');
  const page1 =
    full1.length > 1000
      ? JSON.parse(
          await guard('parse-1', evalMaps('JSON.stringify(window.__placemillParseReviews(' + JSON.stringify(full1) + '))'), 30_000),
        )
      : { reviews: [], nextToken: null, error: 'capture empty' };

  // Page-1 reviews, channel B: the page's own /local/reviews answer via CDP.
  let link1 = { reviews: [], nextToken: null, error: 'no /local/reviews answer' };
  let link1Text = '';
  if (linkAll.length) {
    link1Text = await readResponseBody(cdp, linkAll[linkAll.length - 1].id);
    if (link1Text.length > 500) {
      link1 = JSON.parse(
        await guard(
          'parse-link-1',
          evalMaps('JSON.stringify(window.__placemillParseReviewsLink(' + JSON.stringify(link1Text) + '))'),
          30_000,
        ),
      );
    }
  }
  console.log(
    '    第 1 页：qv9Egd 捕获 =',
    (page1.reviews || []).length,
    '条 | reviews_link(CDP) =',
    (link1.reviews || []).length,
    '条',
  );
  const qv9Alive = (page1.reviews || []).length > 0;
  const linkAlive = (link1.reviews || []).length > 0;
  check('第 1 页：至少一个通道拿到了评论', qv9Alive || linkAlive, 'qv9Egd=' + (page1.reviews || []).length + ' link=' + (link1.reviews || []).length);

  const baseReviews = qv9Alive ? page1.reviews : link1.reviews;
  const seen1 = new Set(baseReviews.map(reviewKey));

  // The opened place's hex id from the page's own qv9Egd source-path.
  const firstCall = (session.qv9Calls || []).find((c) => String(c.url).indexOf('qv9Egd') !== -1);
  const hex =
    (firstCall &&
      (() => {
        const m = decodeURIComponent(String(firstCall.url)).match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/);
        return m ? m[1] : '';
      })()) ||
    '';
  const HEX = hex || '0x808e33bd4f2fb223:0x47e9859adef7de56';
  console.log('    商家 hex =', HEX);
  const bgkey = session.bgkey || '';

  // ---------- scroll rounds: the page fetches pages 2..k itself ------------
  step('滚动评论面板（页面自己翻页，全程录 CDP）');
  let seenQv9 = (session.qv9Calls || []).length;
  const linkBefore = linkAll.length;
  let scrolled = false;
  for (let round = 1; round <= 5; round++) {
    const where = await scrollReviews();
    console.log('    第', round, '轮滚动 →', where);
    if (where !== 'no-scrollable') scrolled = true;
    await sleep(2500);

    const qv9Now = requestsOf('qv9Egd');
    const linkNow = requestsOf('/local/reviews');
    if (qv9Now.length > qv9All.length) {
      const got = await waitNextQv9(seenQv9, 6_000);
      seenQv9 = (got.session ? got.session.qv9Calls : []).length || seenQv9;
      console.log('    → 页面发了新 qv9Egd（第', qv9Now.length - qv9All.length, '条）');
      qv9All.push(...qv9Now.slice(qv9All.length));
    }
    if (linkNow.length > linkBefore) {
      console.log('    → 页面发了新 /local/reviews：');
      for (const x of linkNow.slice(linkBefore)) console.log('      link:', String(x.req.url).slice(0, 180));
      linkAll.push(...linkNow.slice(linkBefore));
    }
    if (qv9Now.length === qv9All.length && linkNow.length === linkBefore) {
      console.log('    → 本轮没有新请求');
    }
  }

  // ---------- GROUND TRUTH: diff page-1 vs page-2 evidence -----------------
  step('diff 翻页证据（qv9Egd 请求体 / reviews_link URL 参数）');
  let qv9TokenSlot = null;
  const qv9Bodies = qv9All.map((x) => x.req.postData || '').filter(Boolean);
  const qv9Inners = qv9Bodies.map(innerFromBody).filter(Boolean);
  if (qv9Inners.length >= 2) {
    const d = diffInner(qv9Inners[0], qv9Inners[1]);
    const t1 = tokenOf(qv9Inners[0]);
    const t2 = tokenOf(qv9Inners[1]);
    console.log('    qv9Egd 两次请求 token =', String(t1 || '').slice(0, 30), '→', String(t2 || '').slice(0, 30));
    console.log('    元素差异 =', JSON.stringify(d.map((x) => x.index)), d.length ? JSON.stringify(d).slice(0, 500) : '');
    if (t1 && t2 && t1 !== t2) qv9TokenSlot = 'inner[4][0]';
    else if (d.length) qv9TokenSlot = 'other';
  } else {
    console.log('    qv9Egd：可解码请求体', qv9Inners.length, '份（不足 2，diff 跳过）');
  }

  let linkTokenParam = null;
  if (linkAll.length >= 2) {
    const p1 = linkParams(linkAll[0].req.url);
    const p2 = linkParams(linkAll[linkAll.length - 1].req.url);
    const keys = new Set([...Object.keys(p1), ...Object.keys(p2)]);
    const diffs = [];
    for (const k of keys) {
      if ((p1[k] || '(缺)') !== (p2[k] || '(缺)')) diffs.push(k + ': ' + String(p1[k] || '(缺)').slice(0, 40) + ' → ' + String(p2[k] || '(缺)').slice(0, 60));
    }
    console.log('    /local/reviews 参数差异 =', diffs.length ? diffs.join(' ; ') : '(无)');
    // The pagination param is the one that appeared/changed and looks like a
    // token or an offset.
    for (const k of Object.keys(p2)) {
      if (p1[k] !== p2[k] && (/^(start|page|token|cursor|pb)/i.test(k) || /^2ahUKE/.test(decodeURIComponent(p2[k] || '')))) {
        linkTokenParam = k;
      }
    }
    if (linkTokenParam) console.log('    ⇒ reviews_link 翻页参数 =', linkTokenParam);
  } else {
    console.log('    /local/reviews 请求共', linkAll.length, '条（不足 2，diff 跳过）');
  }

  // ---------- REPLAY page 2 -------------------------------------------------
  // `--post` opts in to the two constructed qv9Egd POSTs. Default OFF: in a
  // logged-in profile those requests carry the account's cookies, and the
  // user ruled (2026-10-26) that testing pagination at the cost of the
  // account is not acceptable. Passive observation stays default.
  const ALLOW_POST = process.argv.includes('--post');
  step('主动复放第 2 页' + (ALLOW_POST ? '' : '（--post 未给：跳过构造 POST）'));
  let p2reviews = [];
  let p2text = '';
  let replayChannel = '';

  // Path A: qv9Egd alive → token into inner[4][0] (or the slot the diff
  // taught us; only inner[4][0] is constructible today).
  if (!ALLOW_POST) {
    console.log('    构造 POST 已按默认禁用（登录态账号保护）；被动证据见上方 diff');
  } else if (qv9Alive && page1.nextToken) {
    await sleep(1500);
    const page2 = await postQv9WithToken(HEX, page1.nextToken, bgkey);
    p2text = page2.text || '';
    console.log('    qv9Egd 复放 = status', page2.status, '| len', page2.len, '| 评论', page2.parsed ? page2.parsed.reviews.length : 'n/a');
    if (page2.parsed && page2.parsed.reviews.length) {
      p2reviews = page2.parsed.reviews;
      replayChannel = 'qv9Egd';
    }
  } else {
    console.log('    qv9Egd 复放跳过（第 1 页捕获为空或无 nextToken ⇒ 通道今日不可用）');
  }

  // Path B: the page's own scrolled /local/reviews URL, replayed verbatim.
  if (!p2reviews.length && linkAll.length >= 2) {
    const url2 = String(linkAll[linkAll.length - 1].req.url);
    await sleep(1500);
    const got = await fetchLinkUrl(url2);
    console.log('    reviews_link 复放 =', got.notes, '| len', got.len);
    if (got.len > 500) {
      const parsed2 = JSON.parse(
        await guard('parse-link-2', evalMaps('JSON.stringify(window.__placemillParseReviewsLink(' + JSON.stringify(got.text) + '))'), 30_000),
      );
      console.log('    解析 =', parsed2.reviews.length, '条 | error =', parsed2.error);
      if (parsed2.reviews.length) {
        p2reviews = parsed2.reviews;
        p2text = got.text;
        replayChannel = 'reviews_link';
      }
    }
  }

  // Path C: no ground truth → last resort: the base URL again (must equal
  // page 1; if it differs the endpoint is stateful in an unexpected way).
  if (!p2reviews.length && linkAlive) {
    console.log('    无地面真值；对照请求：重放第 1 页 URL（应得到同一批）');
    const url1 = String(linkAll[0].req.url);
    const got = await fetchLinkUrl(url1);
    if (got.len > 500) {
      const parsed2 = JSON.parse(
        await guard('parse-link-ctrl', evalMaps('JSON.stringify(window.__placemillParseReviewsLink(' + JSON.stringify(got.text) + '))'), 30_000),
      );
      const fresh = parsed2.reviews.filter((r) => !seen1.has(reviewKey(r)));
      console.log('    对照 =', parsed2.reviews.length, '条 | 其中新条数 =', fresh.length);
    }
  }

  const overlap = p2reviews.filter((r) => seen1.has(reviewKey(r))).length;
  check('复放：第 2 页拿到评论', p2reviews.length > 0, '通道=' + (replayChannel || '无') + ' 条数=' + p2reviews.length);
  check('复放：与第 1 页零重叠', p2reviews.length > 0 && overlap === 0, '重叠=' + overlap + '/' + p2reviews.length);
  check(
    '复放：归属仍是本店',
    p2reviews.length > 0 && String(p2reviews[0].place_id || '').indexOf(HEX.split(':').pop()) !== -1,
    p2reviews.length ? p2reviews[0].place_id : '-',
  );

  // ---------- REPLAY page 3 (chain) -----------------------------------------
  let p3reviews = [];
  let p3text = '';
  if (replayChannel === 'qv9Egd') {
    const page2 = { nextToken: null };
    // re-parse to get the token we must chain on
    const reparsed = JSON.parse(
      await guard('parse-p2-again', evalMaps('JSON.stringify(window.__placemillParseReviews(' + JSON.stringify(p2text) + '))'), 30_000),
    );
    page2.nextToken = reparsed.nextToken;
    if (page2.nextToken) {
      await sleep(1800);
      const page3 = await postQv9WithToken(HEX, page2.nextToken, bgkey);
      p3text = page3.text || '';
      p3reviews = page3.parsed ? page3.parsed.reviews : [];
      const seen2 = new Set(p2reviews.map(reviewKey));
      const overlap3 = p3reviews.filter((r) => seen2.has(reviewKey(r))).length;
      check('链式：第 3 页有评论且不与第 2 页重叠', p3reviews.length > 0 && overlap3 === 0, '条数=' + p3reviews.length + ' 重叠=' + overlap3);
    } else {
      check('链式：第 3 页可翻', false, '第 2 页无 nextToken');
    }
  } else if (replayChannel === 'reviews_link') {
    // The reviews_link answer carries the next batch's evidence in its own
    // structure; a chain needs the page's next scrolled URL, which the page
    // only issues after the second batch renders — out of scope for a GET
    // replay. Mark as partial.
    console.log('    reviews_link 链式：需要先渲染第 2 批再观察页面的下一条 URL（本次不实测）');
    check('链式：第 3 页可翻', false, 'reviews_link 链式待第 2 批渲染后观察');
  } else {
    check('链式：第 3 页可翻', false, '第 2 页复放未成功');
  }

  // ---------- verdict ---------------------------------------------------------
  console.log('');
  console.log('==== 结论 ====');
  console.log('通道状态：qv9Egd 捕获 =', qv9Alive ? '活' : '空（端点今日关门）', '| reviews_link =', linkAlive ? '活' : '空');
  console.log('token 槽位（地面真值）：qv9Egd =', qv9TokenSlot || '(未观测)', '| reviews_link 参数 =', linkTokenParam || '(未观测)');
  console.log('第 2 页复放 =', replayChannel ? '成功（' + replayChannel + '，' + p2reviews.length + ' 条）' : '失败');
  if (!qv9Alive && !linkAlive) {
    console.log('⇒ 两个通道都空 ⇒ 会话被软封锁，结果视为「未定」，冷却后复跑');
  } else if (!replayChannel) {
    console.log('⇒ 第 1 页有评论但翻页未复现：需要下一轮拿页面滚动后的真实第 2 页请求（本轮滚动是否触发 = ' + scrolled + '）');
  }

  // ---------- fixtures ---------------------------------------------------------
  const pageTexts = [['p1', qv9Alive ? full1 : link1Text], ['p2', p2text], ['p3', p3text]];
  for (const [name, text] of pageTexts) {
    if (text && text.length > 1000) {
      writeFileSync('scripts/e2e/fixtures/reviews-pagination-' + name + '.txt', text);
      console.log('    已存夹具 scripts/e2e/fixtures/reviews-pagination-' + name + '.txt（', text.length, '字符 ✅）');
    }
  }

  // ---------- channel ④: direct GET of the reviews_link (headless first batch)
  // Independent of qv9Egd's mood: if this answers, the app has a stable
  // first-batch channel even on gated days, and the pagination contract of
  // THIS endpoint (2ahUKE token at root[6][1]) becomes the thing to learn.
  step('通道④：直连 reviews_link GET（备用通道今天活不活）');
  const fallbackLink =
    'https://search.google.com/local/reviews?placeid=ChIJI7IvT70zjoARVt733pqF6Uc&authuser=0&hl=zh&gl=HK';
  const direct = await fetchLinkUrl(fallbackLink);
  console.log('    直连结果 =', direct.notes);
  let directReviews = [];
  let directText = '';
  if (direct.len > 500) {
    const parsed = JSON.parse(
      await guard('parse-direct', evalMaps('JSON.stringify(window.__placemillParseReviewsLink(' + JSON.stringify(direct.text) + '))'), 30_000),
    );
    directReviews = parsed.reviews || [];
    directText = direct.text;
    console.log('    解析 =', directReviews.length, '条 | error =', parsed.error);
  }
  check('通道④：直连 reviews_link 可达（无 CORS 拦截）', directReviews.length > 0, directReviews.length + ' 条');
  if (directText.length > 1000) {
    writeFileSync('scripts/e2e/fixtures/reviews-pagination-direct.txt', directText);
    console.log('    已存夹具 scripts/e2e/fixtures/reviews-pagination-direct.txt（', directText.length, '字符 ✅）');
  }

} catch (e) {
  console.log('尖峰中止:', e && e.message ? e.message : e);
  failed = true;
  try {
    const state = await withTimeout(
      evalMaps(
        'JSON.stringify({ url: location.href, title: document.title, text: (document.body.innerText || "").slice(0, 300) })',
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
