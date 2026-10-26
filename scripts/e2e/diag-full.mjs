#!/usr/bin/env node
/**
 * Full scan of a preserved scene: where do the MULTIPLE reviews on the page
 * come from, when the fetch only stored one? Read-only.
 * Usage: node scripts/e2e/diag-full.mjs [placeId] [reviewsLink]
 */
import { listTargets } from "./harness.mjs";
import { cdpClient } from "./cdp.mjs";

const placeId = process.argv[2] || "";
const reviewsLink = process.argv[3] || "";

const targets = await listTargets();
const maps = targets.find((t) => /google\.com/.test(t.url || ""));
if (!maps) throw new Error("maps target not found");
const cdp = cdpClient(maps.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send("Runtime.enable");

async function evaluate(expression) {
  const res = await cdp.send("Runtime.evaluate", {
    expression: expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.error) return "CDP-ERROR: " + JSON.stringify(res.error).slice(0, 200);
  if (res.result && res.result.exceptionDetails) {
    return "EXCEPTION: " + JSON.stringify(res.result.exceptionDetails).slice(0, 260);
  }
  const r = res.result && res.result.result;
  return r && "value" in r ? r.value : JSON.stringify(r);
}

console.log("[1] href =", String(await evaluate("location.href")).slice(0, 140));

console.log("[2] DOM 评论计数 =", String(await evaluate(
  "(function () { const ids = document.querySelectorAll(\"[data-review-id]\").length; const text = document.body.innerText || \"\"; const rel = (text.match(/\\d+ (年前|个月前|周前|天前|小时前|分钟前|years? ago|months? ago|weeks? ago|days? ago|hours? ago|minutes? ago)/g) || []).length; return JSON.stringify({ dataReviewIdNodes: ids, relativeTimeHits: rel }); })()"
)));

console.log("[3] 页面自己的 qv9Egd 响应与 token =", String(await evaluate(
  "(function () { const s = window.__placemillReviewsSession ? window.__placemillReviewsSession() : {}; return JSON.stringify({ token: s.token, bgkeyLen: (s.bgkey || \"\").length, seen: s.seen, qv9Head: String(s.lastQv9Response || \"\").slice(0, 380) }); })()"
)).slice(0, 560));

console.log("[4] Dg 全量扫描 =", String(await evaluate(
  "(function () { const s = window.APP_INITIALIZATION_STATE; const third = s ? s[3] : s; const bucket = third ? third.Dg : third; if (!bucket) return JSON.stringify({ bucket: false }); const out = []; const scan = function (node, depth) { if (depth > 8 || out.length > 10) return; if (typeof node === \"string\") { if (node.slice(0, 4) === \")]}\x27\") { const entry = { bytes: node.length }; const link = window.__placemillParseReviewsLink(node); entry.linkReviews = link.reviews.length; const frame = window.__placemillParseReviews(node); entry.frameReviews = frame.reviews.length; entry.frameError = frame.error; if (node.length > 5000) { let root = null; try { root = JSON.parse(node.slice(4)); } catch (e) { entry.jsonParse = \"fail\"; } if (root) { const r6 = root[6]; const l175 = r6 ? r6[175] : null; const l9 = l175 ? l175[9] : null; const a = l9 ? l9[0] : null; const b = a ? a[0] : null; const list = b ? b[0] : null; entry.listLen = Array.isArray(list) ? list.length : \"no-list\"; if (Array.isArray(list)) { entry.slots = list.map(function (el) { if (el === null) return \"null\"; if (!Array.isArray(el)) return typeof el; const id = typeof el[0] === \"string\" ? el[0].slice(0, 12) : String(el[0]).slice(0, 12); const author = el[1] ? (el[1][4] ? (el[1][4][5] ? el[1][4][5][0] : \"-\") : \"-\") : \"-\"; return id + \"/\" + author; }); } } out.push(entry); } return; } if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) scan(node[i], depth + 1); return; } if (node && typeof node === \"object\") { for (const k in node) scan(node[k], depth + 1); } }; scan(bucket, 0); return JSON.stringify(out); })()"
)).slice(0, 1800));

if (placeId) {
  console.log("[5] 真实执行 __placemillFetchReviews =", String(await evaluate(
    "window.__placemillFetchReviews(" + JSON.stringify(placeId) + ", " + JSON.stringify(reviewsLink) + ").then(function (r) { return JSON.stringify(r); })"
  )).slice(0, 700));
}
process.exit(0);