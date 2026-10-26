// M9 评论 RPC 尖峰探针（2026-10-25）
//
// 目的：确认"评论到底怎么拿"。做法是让页面自己点开"评价"标签，用 CDP 抓它
// 真实发出的那条 batchexecute 请求（方法/头/body），再原样复现。
// performance 条目只有 URL，单靠 URL 复现会 400。
//
// 已知结论（见 `docs/parser.md` 6.1）：
//   - 旧端点 listugcposts 已死（403）；
//   - 活着的端点是 POST /maps/_/MapsWizUi/data/batchexecute?rpcids=qv9Egd，
//     必须带会话头 x-maps-bgkey，否则 200 但响应是空的；
//   - 响应是长度前缀分块流里的 wrb.fr 帧，帧内是嵌套 JSON 字符串。
//
// 这个脚本自带看门狗：每一步都有时限，卡住会打印现场（页面 URL/文本 + 已抓到
// 的请求）并收尾，绝不留一个开着的窗口在那边空等。
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

const PLACE_ID = process.argv[2] || 'ChIJI7IvT70zjoARVt733pqF6Uc';

// Watchdog: the whole spike may not run longer than this, and every step
// has its own budget. A stalled step prints what the page looked like at
// that moment, so a hang is a diagnosis instead of an open window.
const TOTAL_BUDGET_MS = 240_000;
const STEP_MS = 45_000;
const startedAt = Date.now();
const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

function step(label) {
  console.log('[' + elapsed() + 's] ' + label);
}

async function guard(label, promise, ms = STEP_MS) {
  return withTimeout(promise, ms, label);
}

export function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let nextId = 0;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('cdp websocket failed'));
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

const snapshot = backupDatabase();
let cdp = null;

async function stallDump(where) {
  console.log('--- 现场快照（' + where + '）---');
  try {
    const state = await withTimeout(
      evalMaps(
        "JSON.stringify({ url: location.href, title: document.title," +
          " text: (document.body.innerText || '').slice(0, 300) })",
      ),
      8000,
      'stall-dump',
    );
    console.log(state);
  } catch (e) {
    console.log('现场快照取不到:', e && e.message ? e.message : e);
  }
  if (cdp) {
    const seen = cdp.events.filter((e) => e.method === 'Network.requestWillBeSent');
    console.log('已抓到的请求数 =', seen.length);
    for (const e of seen.slice(-6)) {
      console.log('   ', e.params.request.method, e.params.request.url.slice(0, 160));
    }
  }
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

  step('附加 CDP');
  const targets = await guard('listTargets', listTargets(), 15_000);
  const maps = targets.find((t) => t.type === 'page' && /google\.com/.test(t.url || ''));
  if (!maps) throw new Error('no maps target found');
  cdp = cdpClient(maps.webSocketDebuggerUrl);
  await guard('cdp-open', cdp.ready, 15_000);
  await guard('Network.enable', cdp.send('Network.enable'), 15_000);
  console.log('cdp attached to', maps.url);

  step('导航到商家页');
  const url = 'https://www.google.com/maps/place/?q=place_id:' + encodeURIComponent(PLACE_ID);
  await guard('navigate', evalMaps('location.href = ' + JSON.stringify(url) + '; true'), 20_000);
  await sleep(10_000);
  step('页面已加载，点"评价"标签');
  const clicked = await guard(
    'click-reviews',
    evalMaps(
      "(function () {" +
        "  const labels = ['评价', 'Reviews', 'Reseñas'];" +
        "  const nodes = Array.from(document.querySelectorAll('button, [role=tab], li'));" +
        "  for (const label of labels) {" +
        "    const hit = nodes.find(function (n) { return (n.textContent || '').trim() === label; });" +
        "    if (hit) { hit.click(); return 'clicked:' + label; }" +
        "  }" +
        "  return 'not-found:' + labels.join('/');" +
        "})()",
    ),
    30_000,
  );
  console.log('reviews tab =', clicked);
  await sleep(8000);
  step('检查评论是否真的渲染出来了');
  const rendered = await guard(
    'check-rendered',
    evalMaps(
      "JSON.stringify({ hasStars: /[0-9]\\s*\\(/.test(document.body.innerText || '')," +
        " text: (document.body.innerText || '').slice(0, 400) })",
    ),
    20_000,
  );
  console.log('页面文本 =', rendered);

  step('抓 batchexecute 请求');
  const reqs = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => e.params.request)
    .filter((r) => r.url.includes('batchexecute'));
  console.log('captured batchexecute requests =', reqs.length);
  for (const r of reqs) {
    console.log('--- method =', r.method);
    console.log('    url =', r.url);
    console.log('    postData =', JSON.stringify(r.postData || '').slice(0, 700));
    console.log('    headers =', JSON.stringify(r.headers).slice(0, 700));
  }

  const last = reqs[reqs.length - 1];
  if (last) {
    step('复现最后一个请求（三种头组合）');
    // The page sends x-same-domain and a per-session bgkey. Try the request
    // with and without them: whichever one answers 200 says what M9 has to
    // send.
    const headerSets = {
      plain: {},
      sameDomain: { 'x-same-domain': '1' },
      withBgkey: {
        'x-same-domain': '1',
        'x-maps-bgkey': last.headers['x-maps-bgkey'] || '',
        'x-maps-diversion-context-bin': last.headers['x-maps-diversion-context-bin'] || '',
      },
    };
    for (const [name, headers] of Object.entries(headerSets)) {
      let res;
      try {
        res = await guard(
          'replay-' + name,
          evalMaps(
          "(async () => {" +
            "  const res = await fetch(" +
            JSON.stringify(last.url) +
            ", { credentials: 'include', method: " +
            JSON.stringify(last.method) +
            (last.postData ? ", body: " + JSON.stringify(last.postData) : "") +
            ", headers: " +
            JSON.stringify({
              'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
              ...headers,
            }) +
            " });" +
            "  const text = await res.text();" +
            "  return JSON.stringify({ status: res.status, len: text.length, head: text.slice(0, 260) });" +
            "})()",
        ),
        40_000,
        );
      } catch (e) {
        console.log('replay[' + name + '] 跳过（可能被限流）:', e && e.message ? e.message : e);
        continue;
      }
      console.log('replay[' + name + '] =', res);
    }

    // The decisive test: can we ask for a place we never opened? Take the
    // request the page made for Capitol Nissan, swap the place id for another
    // store's, and send it while sitting on a different page.
    step('取另一个商家页的 hex id');
    const otherUrl = 'https://www.google.com/maps/place/?q=place_id:ChIJQ4nU8SMujoARlLJklQZqYwE';
    await guard('navigate-other', evalMaps('location.href = ' + JSON.stringify(otherUrl) + '; true'), 20_000);
    await sleep(10_000);
    const otherHex = await guard(
      'other-hex',
      evalMaps(
        "(function () {" +
          "  const urls = performance.getEntriesByType('resource').map(function (e) { return e.name; });" +
          "  const place = urls.filter(function (u) { return u.indexOf('/maps/preview/place') !== -1; });" +
          "  const last = place.length ? place[place.length - 1] : '';" +
          "  const m = decodeURIComponent(last).match(/!1s(0x[^&!]+)/);" +
          "  return m ? m[1] : '';" +
          "})()",
      ),
      20_000,
    );
    console.log('另一个商家的 hex id =', otherHex);

    if (otherHex) {
      step('坐在当前页，发一条指向别家店的评论请求');
      const currentHex = (decodeURIComponent(last.url).match(/!1s(0x[^&!]+)/) || [])[1];
      const swappedUrl = last.url.replace(/!1s0x[^&!]+/, '!1s' + otherHex);
      const swappedBody = decodeURIComponent(last.postData || '').replace(
        currentHex || '',
        decodeURIComponent(otherHex),
      );
      const synth = await guard(
        'synth',
        evalMaps(
          "(async () => {" +
            "  const res = await fetch(" +
            JSON.stringify(swappedUrl) +
            ", { credentials: 'include', method: 'POST', body: " +
            JSON.stringify(swappedBody) +
            ", headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', 'x-same-domain': '1' } });" +
            "  const text = await res.text();" +
            "  return JSON.stringify({ status: res.status, len: text.length, head: text.slice(0, 200) });" +
            "})()",
        ),
        30_000,
      );
      console.log('synth[other place] =', synth);
    }
  } else {
    console.log('没有抓到 batchexecute 请求');
  }
} catch (e) {
  console.log('尖峰中止:', e && e.message ? e.message : e);
  await stallDump('中止现场');
  process.exitCode = 1;
} finally {
  // ---- E 阶段：那个按商家签发的 token，能不能从搜索载荷里拿到 ----------
  try {
  step('E: 搜索页载荷里找 token 候选');
  await guard(
    'navigate-search',
    evalMaps(
      'location.href = ' +
        JSON.stringify('https://www.google.com/maps/search/bakery/@34.0522,-118.2437,12z') +
        '; true',
    ),
    20_000,
  );
  await sleep(12_000);
  const hunt = await guard(
    'hunt',
    evalMaps(
      "(async () => {" +
        "  const urls = performance.getEntriesByType('resource').map(function (e) { return e.name; });" +
        "  const previews = urls.filter(function (u) {" +
        "    return u.indexOf('/maps/preview/') !== -1 && u.indexOf('/preview/place') === -1;" +
        "  });" +
        "  if (!previews.length) return JSON.stringify({ error: 'no preview payload url' });" +
        "  const res = await fetch(previews[previews.length - 1], { credentials: 'include' });" +
        "  const text = await res.text();" +
        "  const hex = '0x808e2e23f1d48943:0x1636a069564b294';" +
        "  const at = text.indexOf(hex);" +
        "  const around = at >= 0 ? text.slice(Math.max(0, at - 5000), at + 5000) : text;" +
        "  const cands = [];" +
        "  const re = /[A-Za-z0-9_-]{20,26}/g;" +
        "  let m;" +
        "  while ((m = re.exec(around)) !== null) { if (cands.indexOf(m[0]) < 0) cands.push(m[0]); }" +
        "  return JSON.stringify({ status: res.status, len: text.length, hexFound: at >= 0," +
        "    candidates: cands.slice(0, 24) });" +
        "})()",
    ),
    40_000,
  );
  const huntOut = JSON.parse(hunt || '{}');
  console.log('    载荷状态 =', huntOut.status, '长度 =', huntOut.len, '找到 hex =', huntOut.hexFound);
  if (huntOut.error) console.log('    错误 =', huntOut.error);
  console.log('    token 候选 =', JSON.stringify(huntOut.candidates || []));

  // The decisive, cheap question: is that session token per-SESSION or
  // per-PLACE? Take the token the search page itself is using and try it for
  // another store. If a session token works, the cheap path is alive.
  const searchToken = (() => {
    const bodies = cdp
      ? cdp.events
          .filter((e) => e.method === 'Network.requestWillBeSent')
          .map((e) => e.params.request)
          .filter((r) => r.postData)
      : [];
    for (let i = bodies.length - 1; i >= 0; i--) {
      let body = bodies[i].postData || '';
      try {
        body = decodeURIComponent(body);
      } catch {
        /* a bare % in the body must not take the probe down */
      }
      const m = body.match(/\\"([A-Za-z0-9_-]{18,30})\\"/);
      if (m) return m[1];
    }
    return '';
  })();
  console.log('    搜索页会话 token =', searchToken);

  // The template request is re-derived from the CDP events: this phase lives in
  // the `finally` block, so it cannot see the try block's locals.
  const qv9 = cdp
    ? cdp.events
        .filter((e) => e.method === 'Network.requestWillBeSent')
        .map((e) => e.params.request)
        .filter((r) => r.url.includes('rpcids=qv9Egd'))
    : [];
  const lastReq = qv9[qv9.length - 1];
  if (lastReq && huntOut.candidates) {
    const bgkey = lastReq.headers['x-maps-bgkey'] || '';
    let templateBody = lastReq.postData || '';
    try {
      templateBody = decodeURIComponent(templateBody);
    } catch {
      /* keep the raw body */
    }
    const templateToken = (templateBody.match(/\\"([A-Za-z0-9_-]{18,30})\\"/) || [])[1] || '';
    const safewayHex = '0x808e2e23f1d48943:0x1636a069564b294';
    console.log('    模板 token =', templateToken);
    for (const candidate of [searchToken].concat(huntOut.candidates || []).slice(0, 5)) {
      if (!candidate || candidate === templateToken) continue;
      const url = lastReq.url
        .replace(/_reqid=\d+/, '_reqid=' + (700000 + Math.floor(Math.random() * 9000)))
        .replace(/!1s0x[^&!]+/, '!1s' + safewayHex);
      const body = templateBody
        .split(templateToken)
        .join(candidate)
        .split('0x808e33bd4f2fb223:0x47e9859adef7de56')
        .join(safewayHex);
      const res = await guard(
        'try-' + candidate,
        evalMaps(
          "(async () => {" +
            "  const res = await fetch(" +
            JSON.stringify(url) +
            ", { credentials: 'include', method: 'POST', body: " +
            JSON.stringify(body) +
            ", headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8'," +
            "    'x-same-domain': '1', 'x-maps-bgkey': " +
            JSON.stringify(bgkey) +
            " } });" +
            "  const text = await res.text();" +
            "  return JSON.stringify({ status: res.status, len: text.length, text: text.slice(0, 200000) });" +
            "})()",
            ),
            30_000,
            );
            const got = JSON.parse(res);
            console.log('    候选', candidate, '->', 'status=' + got.status, 'len=' + got.len);
            if (got.len > 1000) {
            console.log('    *** 这个 token 管用 ***');
            // Verify it is really the other store's reviews: count them and show
            // the first author and body.
        // Verify in Node: the body is already here, and escaping a regex into
        // the page is a trap.
        const raw = got.text || "";
        writeFileSync('scripts/e2e/fixtures/reviews-response.txt', raw);
        console.log('    响应已存为 scripts/e2e/fixtures/reviews-response.txt');
        const body = raw.charCodeAt(0) === 41 ? raw.slice(4) : raw;
        // The answer is a length-prefixed chunk stream, so the frame is pulled
        // out with a regex instead of JSON.parse of the whole body.
        // The answer is a length-prefixed chunk stream; the frame we want is
        // the one that starts with ["wrb.fr","qv9Egd",". Scan it by hand —
        // regex escaping through two string layers is a trap.
        const marker = String.fromCharCode(91,34) + "wrb.fr" + String.fromCharCode(34,44) + String.fromCharCode(34) + "qv9Egd" + String.fromCharCode(34,44);
        const at = body.indexOf(marker);
        const payloadStart = at + marker.length + 1;
        let j = payloadStart;
        let escaped = false;
        for (; j < body.length; j++) {
          const ch = body[j];
          if (escaped) { escaped = false; continue; }
          if (ch === String.fromCharCode(92)) { escaped = true; continue; }
          if (ch === String.fromCharCode(34)) break;
        }
        const payload = body.slice(payloadStart, j);
        const inner = JSON.parse(JSON.parse(String.fromCharCode(34) + payload + String.fromCharCode(34)));
        const reviews = inner[2] || [];
        const first = reviews[0] && reviews[0][0] ? reviews[0][0] : null;
        console.log("    验证 =", JSON.stringify({
          reviewCount: reviews.length,
          placeIdInReview: first ? first[1][0] : null,
          author: first ? first[1][4][5][0] : null,
          stars: first ? first[2][0][0] : null,
          text: first ? first[2][15][0][0] : null,
          pagingToken: inner[1],
        }));
            break;
            }
    }
  }

  } catch (e) {
    console.log('E 阶段失败（不影响收尾）:', e && e.message ? e.message : e);
  }

  step('收尾');
  await withTimeout(stopApp(), 60_000, 'stopApp').catch((e) => console.log('stopApp:', e.message));
  await withTimeout(restoreDatabase(snapshot), 30_000, 'restoreDatabase').catch((e) =>
    console.log('restoreDatabase:', e.message),
  );
  step('结束');
}
