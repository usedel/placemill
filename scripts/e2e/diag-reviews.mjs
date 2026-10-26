#!/usr/bin/env node
/**
 * Live diagnosis of the reviews fetch against an ALREADY RUNNING dev app.
 * Attaches to CDP at 127.0.0.1:9222 (set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
 * before `npm run tauri dev`), runs a battery of probes in the maps webview,
 * optionally executes a real fetch, and reports. Read-only: never launches,
 * never writes the database directly.
 *
 * Usage:
 *   node scripts/e2e/diag-reviews.mjs                 # probes only
 *   node scripts/e2e/diag-reviews.mjs <placeId>       # probes + a real fetch
 *   node scripts/e2e/diag-reviews.mjs <placeId> <reviewsLink>
 */
import { listTargets } from './harness.mjs';
import { cdpClient } from './cdp.mjs';

const placeId = process.argv[2] || '';
const reviewsLink = process.argv[3] || '';
const startedAt = Date.now();
const step = (label) => console.log('[' + Math.round((Date.now() - startedAt) / 1000) + 's] ' + label);

async function evaluate(cdp, expression, label) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 25000,
  });
  if (res.error) throw new Error(label + ': ' + JSON.stringify(res.error).slice(0, 200));
  const r = res.result;
  if (r.exceptionDetails) {
    return 'EXCEPTION: ' + JSON.stringify(r.exceptionDetails).slice(0, 300);
  }
  return r.result && 'value' in r.result ? r.result.value : r.result;
}

step('连接 CDP');
const targets = await listTargets();
const maps = targets.find((t) => /google\.com/.test(t.url || ''));
if (!maps) {
  console.log('targets:');
  for (const t of targets) console.log('  ', t.type, (t.url || '').slice(0, 90));
  throw new Error('maps target not found');
}
const cdp = cdpClient(maps.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send('Runtime.enable');
step('已挂到 maps webview: ' + String(maps.url).slice(0, 90));

const probes = [
  ['href', 'location.href'],
  ['script注入', 'typeof window.__placemillFetchReviews'],
  ['emit通路', 'JSON.stringify({ tauri: typeof window.__TAURI__, internals: typeof window.__TAURI_INTERNALS__, emitPath: window.__TAURI__ ? (window.__TAURI__.event ? "tauri.emit" : "tauri.noevent") : (window.__TAURI_INTERNALS__ ? "internals" : "none") })'],
  ['state形状', 'JSON.stringify((function () { const s = window.APP_INITIALIZATION_STATE; const third = s ? s[3] : s; const bucket = third ? third.Dg : third; return { hasState: !!s, stateKeys: s ? Object.keys(s).slice(0, 8) : [], hasBucket: !!bucket }; })())'],
  ['Dg扫描', 'JSON.stringify((function () { const s = window.APP_INITIALIZATION_STATE; const third = s ? s[3] : s; const bucket = third ? third.Dg : third; if (!bucket) return { bucket: false }; const out = { bucket: true, strings: 0, xssi: 0, entries: [] }; const scan = function (node, depth) { if (depth > 8 || out.entries.length > 6) return; if (typeof node === "string") { out.strings += 1; if (node.slice(0, 4) === ")]}\x27") { out.xssi += 1; const parsed = window.__placemillParseReviewsLink(node); out.entries.push({ bytes: node.length, reviews: parsed.reviews.length, error: parsed.error, places: parsed.reviews.map(function (r) { return r.place_id; }).slice(0, 3) }); } return; } if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) scan(node[i], depth + 1); return; } if (node && typeof node === "object") { for (const k in node) scan(node[k], depth + 1); } }; scan(bucket, 0); return out; })())'],
];

for (const [label, expression] of probes) {
  step('探针 ' + label);
  try {
    console.log('   ', JSON.stringify(await evaluate(cdp, expression, label)).slice(0, 900));
  } catch (e) {
    console.log('    失败:', e.message);
  }
}

if (placeId) {
  step('真实执行 __placemillFetchReviews(' + placeId.slice(0, 24) + '...)');
  try {
    const result = await evaluate(
      cdp,
      'window.__placemillFetchReviews(' + JSON.stringify(placeId) + ', ' + JSON.stringify(reviewsLink) + ').then(function (r) { return JSON.stringify(r); })',
      'fetch',
    );
    console.log('   ', String(result).slice(0, 1200));
  } catch (e) {
    console.log('    失败:', e.message);
  }

  step('手工 emit 一条最小载荷（隔离 emit/监听/入库腿）');
  try {
    const emitResult = await evaluate(
      cdp,
      '(function () { const payload = { channel: "diag", reviews: [], error: "diag-marker", placeId: ' + JSON.stringify(placeId) + ', dataId: "" };' +
        'if (window.__TAURI__; window.__TAURI__.event) { window.__TAURI__.event.emit("business-reviews", payload); return "via __TAURI__"; }' +
        'if (window.__TAURI_INTERNALS__) { window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "business-reviews", payload: payload }); return "via internals"; }' +
        'return "no emit path"; })()',
      'emit',
    );
    console.log('   ', String(emitResult).slice(0, 300), '（若显示 marker，诊断抽屉应出现一条"Reviews fetch ... diag-marker"）');
  } catch (e) {
    console.log('    失败:', e.message);
  }
}

step('结束（CDP 保持连接由进程退出自动关闭）');
process.exit(0);