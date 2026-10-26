import { listTargets } from "./harness.mjs";
import { cdpClient } from "./cdp.mjs";
const targets = await listTargets();
const panel = targets.find((t) => /localhost:1421/.test(t.url || ""));
const cdp = cdpClient(panel.webSocketDebuggerUrl);
await cdp.ready;
const res = await cdp.send("Runtime.evaluate", {
  expression: "window.__TAURI_INTERNALS__.invoke(\"fetch_business_reviews\", { placeId: \"ChIJJ6lLsLol9ocRPZDjQBTBWcQ\" }).then(function (r) { return \"ok:\" + JSON.stringify(r); }).catch(function (e) { return \"err:\" + String(e); })",
  returnByValue: true,
  awaitPromise: true,
});
const value = res.result && res.result.result ? res.result.result.value : JSON.stringify(res.result);
console.log("invoke:", String(value).slice(0, 300));
process.exit(0);