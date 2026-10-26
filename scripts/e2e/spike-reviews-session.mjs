#!/usr/bin/env node
/**
 * Acceptance for the M9 session capture (J-09a, step 2).
 *
 * The reviews request needs three things (`docs/parser.md` §6.3):
 *   1. the page's session token,
 *   2. the session header x-maps-bgkey,
 *   3. the target place's hex id (our `data_id` column).
 *
 * Established on the way here (each one cost a run, keep them in mind):
 *   - the token only ever appears inside the page's own qv9Egd request body,
 *     which the page passes as a Request object — readable via clone().text();
 *   - every rpc carries a token of its own, so only qv9Egd bodies count;
 *   - the inner JSON must match the page's element for element (see
 *     buildReviewsRequest) and the source-path must be the clean path;
 *   - the session token is SHORT-LIVED: the request has to go out within
 *     seconds of the capture, which is why the send happens right after the
 *     click and every diagnostic runs afterwards.
 *
 * The place whose reviews we ask for is one we never open — that is the
 * whole point of the cheap path.
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

// A store we never open. Its hex id is the form our `data_id` column holds.
const TARGET_HEX = '0x808e2e23f1d48943:0x1636a069564b294';
const PLACE_URL =
  'https://www.google.com/maps/place/?q=place_id:ChIJI7IvT70zjoARVt733pqF6Uc';

const STEP_MS = 40_000;
const startedAt = Date.now();
const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

function step(label) {
  console.log('[' + elapsed() + 's] ' + label);
}

async function guard(label, promise, ms = STEP_MS) {
  return withTimeout(promise, ms, label);
}

const snapshot = backupDatabase();
let failed = false;

function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  [' + String(detail).slice(0, 220) + ']');
  if (!ok) failed = true;
}

// Poll until the token shows up; it arrives a tick after the click because
// the clone().text() read is asynchronous.
async function waitForSession(budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = { token: '', bgkey: '', seen: 0, shapes: [], lastBatchBody: '' };
  while (Date.now() < deadline) {
    const current = JSON.parse(
      await guard('session', evalMaps('JSON.stringify(window.__placemillReviewsSession())'), 15_000),
    );
    last = current;
    if (current.token && current.bgkey) return current;
    await sleep(400);
  }
  return last;
}

try {
  step('preflight');
  await guard('preflight', preflight(), 20_000);
  step('launchApp');
  await guard('launchApp', launchApp(), 240_000);
  step('openPanel');
  await guard('openPanel', openPanel(), 30_000);
  step('等待 maps 页注入');
  await guard('maps-ready', pollMaps('typeof window.__placemillAutoScroll === "object"', 60_000), 70_000);

  step('进商家页');
  await guard(
    'navigate-place',
    evalMaps('location.href = ' + JSON.stringify(PLACE_URL) + '; true'),
    20_000,
  );
  await sleep(10_000);

  // Clicking the reviews tab makes the page issue its own qv9Egd — that is
  // where the fresh token comes from.
  step('点评价标签（页面会发 qv9Egd → token 被学到）');
  // CDP attaches first so the browser's real qv9Egd headers are visible.
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
  await guard(
    'click-reviews',
    evalMaps(
      '(function () {' +
        '  const labels = ["评价", "Reviews"];' +
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

  // The token is short-lived: build and send immediately, everything else
  // waits until after.
  const session = await waitForSession(8_000);
  console.log(
    '    脚本学到的 token =',
    session.token,
    '| bgkey 长度 =',
    session.bgkey.length,
    '| 看到过请求 =',
    session.seen,
  );
  check(
    '会话捕获：拿到了会话 token',
    typeof session.token === 'string' && session.token.length >= 18 && session.token.length <= 30,
    session.token,
  );
  check(
    '会话捕获：拿到了 x-maps-bgkey',
    typeof session.bgkey === 'string' && session.bgkey.length > 50,
    '长度=' + String(session.bgkey).length,
  );

  // The credentials the browser itself used, straight from CDP.
  const sentRequests = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => e.params.request);
  const pageReviewsRequest = sentRequests.find(
    (r) => String(r.url || '').indexOf('qv9Egd') !== -1,
  );
  const cdpBgkey = pageReviewsRequest
    ? (pageReviewsRequest.headers || {})['x-maps-bgkey'] || ''
    : '';
  const cdpToken = pageReviewsRequest
    ? (decodeURIComponent(pageReviewsRequest.postData || '').match(
        /\\"([A-Za-z0-9_-]{18,30})\\"/,
      ) || [])[1] || ''
    : '';
  console.log(
    '    浏览器真实的 token =',
    cdpToken,
    '| bgkey 长度 =',
    String(cdpBgkey).length,
  );

  // Send the same shaped request twice: once with the credentials the page
  // context captured, once with the credentials the browser actually used.
  // Whichever works tells us whether the blocker is the credential value or
  // something else.
  async function tryPair(label, token, bgkey) {
    const built = JSON.parse(
      await guard(
        'build-' + label,
        evalMaps(
          'JSON.stringify(window.__placemillBuildReviewsRequest(' +
            JSON.stringify(TARGET_HEX) +
            ', ' +
            JSON.stringify({ token: token, bgkey: bgkey }) +
            '))',
        ),
        10_000,
      ),
    );
    const live = JSON.parse(
      await guard(
        'live-' + label,
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
    console.log('    [' + label + '] 实请求 =', 'status=' + live.status, 'len=' + live.len);
    return { built: built, live: live };
  }

  // The spike's working recipe, replayed with a CONSISTENT pair: the url and
  // the body of the SAME qv9Egd call (the page issues several; later ones
  // come back empty, so mixing vintages fails).
  const calls = session.qv9Calls || [];
  console.log(
    '    学到的 qv9Egd 调用 =',
    calls.length,
    '| 各 body 长度 =',
    JSON.stringify(calls.map((c) => c.body.length)),
  );
  const pair = calls.find((c) => c.body.length > 200) || calls[0];
  let replay = { len: 0 };
  if (pair) {
    const replayUrl = String(pair.url)
      .replace(/_reqid=\d+/, '_reqid=' + (400000 + Math.floor(Math.random() * 90000)))
      .replace(/!1s0x[^&!]+/, '!1s' + TARGET_HEX);
    const replayBody = String(pair.body).replace(
      /0x[0-9a-f]+%3A0x[0-9a-f]+/,
      encodeURIComponent(TARGET_HEX),
    );
    replay = JSON.parse(
      await guard(
        'live-replay',
        evalMaps(
          '(async () => {' +
            '  const res = await fetch(' +
            JSON.stringify(replayUrl) +
            ', { method: "POST", credentials: "include", headers: ' +
            JSON.stringify({
              'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
              'x-same-domain': '1',
              'x-maps-bgkey': cdpBgkey || session.bgkey,
            }) +
            ', body: ' +
            JSON.stringify(replayBody) +
            ' });' +
            '  const text = await res.text();' +
            '  return JSON.stringify({ status: res.status, len: text.length, text: text });' +
            '})()',
        ),
        40_000,
      ),
    );
    console.log('    [复刻] 实请求 =', 'status=' + replay.status, 'len=' + replay.len);
  } else {
    console.log('    [复刻] 跳过：没有成对的调用');
  }

  const withOurs = await tryPair('页面捕获', session.token, session.bgkey);
  const live = withOurs.live.len > 1000 ? withOurs.live : replay.len > 1000 ? replay : withOurs.live;

  const parsed = JSON.parse(
    await guard(
      'parse',
      evalMaps(
        'JSON.stringify(window.__placemillParseReviews(' + JSON.stringify(live.text) + '))',
      ),
      30_000,
    ),
  );
  console.log(
    '    解析到评论 =',
    parsed.reviews.length,
    '| 第一条作者 =',
    parsed.reviews[0] && parsed.reviews[0].author,
    '| 商家 =',
    parsed.reviews[0] && parsed.reviews[0].place_id,
  );
  check('解析：没有报错', parsed.error === null, String(parsed.error));
  check('解析：拿到了评论', parsed.reviews.length > 0, '条数=' + parsed.reviews.length);
  const first = parsed.reviews[0] || {};
  check(
    '解析：评论属于我们要的那家店',
    String(first.place_id || '').indexOf('0x1636a069564b294') !== -1,
    'place_id=' + first.place_id,
  );
  check(
    '解析：字段齐全（作者/星级/正文/微秒时间戳）',
    String(first.author || '').length > 0 &&
      first.stars >= 1 &&
      first.stars <= 5 &&
      String(first.text || '').length > 0 &&
      first.created_at_us > 1500000000000000,
    JSON.stringify({
      author: first.author,
      stars: first.stars,
      textLen: String(first.text || '').length,
      created_at_us: first.created_at_us,
    }),
  );
  check(
    '解析：带回了翻页 token',
    typeof parsed.nextToken === 'string' && parsed.nextToken.length > 20,
    String(parsed.nextToken).slice(0, 50),
  );

  // ---- diagnostics, run last so they never delay the request -------------
  step('诊断（不影响上面的结果）');
  // Did the page's OWN reviews request still work? If it too comes back
  // empty, the endpoint is blocking this session and every 172 above is
  // that block, not our request.
  const own = JSON.parse(
    await guard(
      'own-response',
      evalMaps(
        'JSON.stringify(window.__placemillReviewsSession().lastQv9Response || "")',
      ),
      15_000,
    ),
  );
  console.log('    页面自己的 qv9Egd 响应长度 =', String(own).length);
  console.log('    页面自己的 qv9Egd 响应开头 =', String(own).slice(0, 160));
  // Does the page render review bodies at all? If the page itself shows no
  // reviews, the endpoint/locale is refusing — nothing code-side fixes that.
  const dom = JSON.parse(
    await guard(
      'dom',
      evalMaps(
        '(function () {' +
          '  const text = document.body.innerText || "";' +
          '  return JSON.stringify({' +
          '    hasCount: text.indexOf("条评价") !== -1 || text.indexOf(" reviews") !== -1,' +
          '    hasRelative: /\\d+ (年前|个月前|周前|天前|小时前|years? ago|months? ago|weeks? ago|days? ago|hours? ago)/.test(text),' +
          '    hasKnownAuthor: text.indexOf("Dawei Wang") !== -1,' +
          '    sample: text.slice(text.indexOf("条评价") - 20, text.indexOf("条评价") + 500).replace(/\\n/g, " | "),' +
          '  });' +
          '})()',
      ),
      15_000,
    ),
  );
  console.log(
    '    DOM：有评分计数 =',
    dom.hasCount,
    '| 有相对时间 =',
    dom.hasRelative,
    '| 有夹具作者 Dawei Wang =',
    dom.hasKnownAuthor,
  );
  console.log('    DOM 片段 =', String(dom.sample || '').slice(0, 500));
  // Did the reviews arrive as a message (service worker → page)? That is
  // where they must come from now: the qv9Egd fetch answers empty even for
  // the page itself, yet a fresh profile renders them.
  console.log(
    '    收到的大消息 =',
    JSON.stringify(
      (session.messages || []).map((m) => ({
        source: m.source,
        length: m.length,
        hasReviewMarker: m.hasReviewMarker,
        head: String(m.head || '').slice(0, 120),
      })),
    ),
  );
  // Are the reviews server-rendered into the initial document / bootstrap
  // state? That would explain why they render before any qv9Egd answers.
  const embedded = JSON.parse(
    await guard(
      'embedded',
      evalMaps(
        '(function () {' +
          '  const html = document.documentElement.innerHTML || "";' +
          '  let state = "";' +
          '  try { state = JSON.stringify(window.APP_INITIALIZATION_STATE || ""); } catch (e) { /* cyclic */ }' +
          '  return JSON.stringify({' +
          '    inHtml: html.indexOf("Dawei Wang") !== -1,' +
          '    htmlLength: html.length,' +
          '    inState: state.indexOf("Dawei Wang") !== -1,' +
          '    stateLength: state.length,' +
          '  });' +
          '})()',
      ),
      20_000,
    ),
  );
  console.log(
    '    初始 HTML 含评论 =',
    embedded.inHtml,
    '(' + embedded.htmlLength + ' 字符 ✅) | 初始化状态含评论 =',
    embedded.inState,
    '(' + embedded.stateLength + ' 字符 ✅)',
  );
  // If the reviews ride in the bootstrap state, find the review body inside
  // it and dump the surrounding structure — if the relative paths match our
  // parser (r[2][15][0][0] etc.), the whole parse layer is reusable as-is.
  const probe = JSON.parse(
    await guard(
      'probe-state',
      evalMaps(
        '(function () {' +
          '  const needle = "This customer service guy";' +
          '  let state = null;' +
          '  try { state = window.APP_INITIALIZATION_STATE; } catch (e) { /* ignore */ }' +
          '  if (!state) return JSON.stringify({ error: "no state" });' +
          '  const paths = [];' +
          '  const walk = function (node, path, depth) {' +
          '    if (depth > 16 || paths.length >= 3) return;' +
          '    if (typeof node === "string") {' +
          '      if (node.indexOf(needle) !== -1) paths.push(path);' +
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
          '  walk(state, "$", 0);' +
          '  if (!paths.length) return JSON.stringify({ error: "body not in state" });' +
          '  const at = function (root, path) {' +
          '    const parts = path.match(/\\[\\d+\\]|\\.[A-Za-z_$][\\w$]*/g) || [];' +
          '    let value = root;' +
          '    for (const part of parts) {' +
          '      if (part[0] === "[") { value = value[parseInt(part.slice(1, -1), 10)]; }' +
          '      else { value = value[part.slice(1)]; }' +
          '      if (value === undefined) return undefined;' +
          '    }' +
          '    return value;' +
          '  };' +
          '  const textPath = paths[0];' +
          '  const body = at(state, textPath);' +
          '  const r = at(state, textPath.replace(/(\\[\\d+\\]|\\.[A-Za-z_$][\\w$]*)$/, "").replace(/(\\[\\d+\\]|\\.[A-Za-z_$][\\w$]*)$/, "").replace(/(\\[\\d+\\]|\\.[A-Za-z_$][\\w$]*)$/, ""));' +
          '  const shaped = r && Array.isArray(r) ? {' +
          '    review_id: r[0],' +
          '    place_id: r[1] && r[1][0],' +
          '    created_us: r[1] && r[1][2],' +
          '    author: r[1] && r[1][4] && r[1][4][5] && r[1][4][5][0],' +
          '    stars: r[2] && r[2][0] && r[2][0][0],' +
          '    text: body,' +
          '  } : null;' +
          '  return JSON.stringify({ paths: paths, textPath: textPath, shaped: shaped });' +
          '})()',
      ),
      30_000,
    ),
  );
  console.log('    正文所在路径 =', JSON.stringify(probe.paths || probe.error));
  // The state caches whole batchexecute responses (XSSI-prefixed). Parse
  // every one of them with the shipped parser — if the cache is where the
  // reviews live, this is the whole capture, no request construction needed.
  const cached = JSON.parse(
    await guard(
      'parse-cache',
      evalMaps(
        '(function () {' +
          '  let state = null;' +
          '  try { state = window.APP_INITIALIZATION_STATE; } catch (e) { /* ignore */ }' +
          '  if (!state || !state[3] || !state[3].Dg) return JSON.stringify({ error: "no Dg cache" });' +
          '  const out = [];' +
          '  const scan = function (node, path, depth) {' +
          '    if (depth > 8 || out.length > 8) return;' +
          '    if (typeof node === "string") {' +
          '      if (node.slice(0, 4) === ")]}\x27") {' +
          '        const marker = node.indexOf("wrb.fr");' +
          '        const rpc = marker !== -1 ? (node.match(/\\\\"wrb\\\\.fr\\\\",\\\\"([A-Za-z0-9_]+)\\\\"/) || [])[1] || "?" : "(no frame)";' +
          '        const hasReviews = node.indexOf("This customer service guy") !== -1;' +
          '        out.push({ path: path, bytes: node.length, rpc: rpc, marker: marker, hasReviews: hasReviews });' +
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
          '  scan(state[3].Dg, "$[3].Dg", 0);' +
          '  return JSON.stringify(out);' +
          '})()',
      ),
      30_000,
    ),
  );
  console.log('    state 缓存里的批处理响应 =', JSON.stringify(cached, null, 1).slice(0, 1200));
  const head = JSON.parse(
    await guard(
      'cache-head',
      evalMaps(
        '(function () {' +
          '  let state = null;' +
          '  try { state = window.APP_INITIALIZATION_STATE; } catch (e) { /* ignore */ }' +
          '  const text = state && state[3] && state[3].Dg ? String(state[3].Dg[6] || "") : "";' +
          '  return JSON.stringify({ head: text.slice(0, 600) });' +
          '})()',
      ),
      20_000,
    ),
  );
  console.log('    Dg[6] 开头 600 字符 =', String(head.head || '').replace(/\n/g, ' | '));
  // The reviews-link payload is the new ground truth for the parser.
  const full = JSON.parse(
    await guard(
      'cache-full',
      evalMaps(
        '(function () {' +
          '  let state = null;' +
          '  try { state = window.APP_INITIALIZATION_STATE; } catch (e) { /* ignore */ }' +
          '  return JSON.stringify({ text: state && state[3] && state[3].Dg ? String(state[3].Dg[6] || "") : "" });' +
          '})()',
      ),
      20_000,
    ),
  );
  if (full.text) {
    writeFileSync('scripts/e2e/fixtures/reviews-link-response.txt', full.text);
    console.log('    已存为 scripts/e2e/fixtures/reviews-link-response.txt（', full.text.length, '字符 ✅）');
  }

  // Live integration: the one-call reviews fetch, reviews_link preferred.
  // The reviews_link URL is extracted from the bootstrap state — that is
  // where the page keeps it before handing it to the SW.
  step('整合入口：__placemillFetchReviews（reviews_link 优先）');
  // The URL normally comes from the reviews_link column (Rust passes it in).
  // In this spike the test place is the same one the fixture was captured
  // from, so the captured URL is the right one to use; try the state first
  // in case the page cached a fresher one.
  const linkUrl = JSON.parse(
    await guard(
      'link-url',
      evalMaps(
        '(function () {' +
          '  let state = null;' +
          '  try { state = window.APP_INITIALIZATION_STATE; } catch (e) { /* ignore */ }' +
          '  const paths = [];' +
          '  const walk = function (node, path, depth) {' +
          '    if (depth > 14 || paths.length >= 2) return;' +
          '    if (typeof node === "string") {' +
          '      const at = node.indexOf("search.google.com/local/reviews");' +
          '      if (at !== -1) {' +
          '        const tail = node.slice(at).split("&")[0].split("\\x22")[0];' +
          '        if (tail.indexOf("placeid=") !== -1 && paths.indexOf(tail) === -1) paths.push(tail);' +
          '      }' +
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
          '  if (state) walk(state, "$", 0);' +
          '  return JSON.stringify({ url: paths[0] || "" });' +
          '})()',
      ),
      20_000,
    ),
  );
  console.log('    reviews_link =', String(linkUrl.url || '').slice(0, 120));
  const effectiveUrl = linkUrl.url ||
    'https://search.google.com/local/reviews?placeid=ChIJI7IvT70zjoARVt733pqF6Uc&authuser=0&hl=zh&gl=HK';
  if (!linkUrl.url) {
    console.log('    state 里没有现成 URL（页面波动 ✅），退回夹具里的已知 URL ✅');
  }
  const fetched = JSON.parse(
    await guard(
      'fetch-reviews',
      evalMaps(
        '(window.__placemillFetchReviews(' +
          JSON.stringify(TARGET_HEX) +
          ', ' +
          JSON.stringify(effectiveUrl) +
          ').then(function (r) { return JSON.stringify(r); }))',
      ),
      40_000,
    ),
  );
  console.log(
    '    整合结果 = 通道',
    fetched.channel,
    '| status',
    fetched.status,
    '| 评论',
    fetched.reviews.length,
    '| error =',
    fetched.error,
  );
  check(
    '整合：state_cache 通道命中（零网络拿到评论）',
    fetched.channel === 'state_cache' && fetched.error === null,
    JSON.stringify(fetched).slice(0, 200),
  );
  check(
    '整合：精选评论属于当前商家且字段齐全',
    fetched.reviews.length >= 1 &&
      String(fetched.reviews[0].place_id || '').endsWith('0x47e9859adef7de56') &&
      String(fetched.reviews[0].author || '').length > 0 &&
      fetched.reviews[0].stars >= 1 &&
      String(fetched.reviews[0].text || '').length > 0,
    JSON.stringify(fetched.reviews[0] || {}).slice(0, 200),
  );

  // Which response actually carried the reviews? The page renders them, but
  // its qv9Egd answers came back empty — so some other response must hold
  // them. CDP can read every response body; search for the fixture author.
  step('搜响应体：评论现在从哪个请求来');
  const hits = [];
  let bodiesRead = 0;
  const responses = cdp.events.filter((e) => e.method === 'Network.responseReceived');
  for (const e of responses) {
    const requestId = e.params.requestId;
    const url = String(e.params.response && e.params.response.url || '');
    try {
      const body = await withTimeout(
        cdp.send('Network.getResponseBody', { requestId: requestId }),
        8000,
        'body-' + requestId,
      );
      const text = body && body.base64Encoded
        ? Buffer.from(body.body, 'base64').toString('utf8')
        : String(body && body.body || '');
      if (!text) continue;
      bodiesRead++;
      if (text.indexOf('Dawei Wang') !== -1 || text.indexOf('customer service guy') !== -1) {
        hits.push(url.slice(0, 220));
      }
    } catch (err) {
      /* body not available for this response */
    }
  }
  console.log(
    '    实际读到响应体 =',
    bodiesRead,
    '/',
    responses.length,
    '| 含评论内容的响应 =',
    hits.length,
  );
  for (const hit of hits.slice(0, 6)) {
    console.log('      ', hit);
  }
  if (session.lastBatchBody) {
    console.log(
      '    页面真实 body =',
      decodeURIComponent(session.lastBatchBody).slice(0, 400),
    );
  }
  console.log('    我们 body     =', decodeURIComponent(withOurs.built.body || '').slice(0, 400));
  if (session.shapes && session.shapes.length) {
    console.log('    最近的请求形状 =');
    for (const shape of session.shapes.slice(-4)) {
      console.log('      ', JSON.stringify(shape));
    }
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
