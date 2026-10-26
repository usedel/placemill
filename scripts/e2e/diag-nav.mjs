import { listTargets } from "./harness.mjs";
import { cdpClient } from "./cdp.mjs";
const targets = await listTargets();
const maps = targets.find((t) => /google\.com/.test(t.url || ""));
const cdp = cdpClient(maps.webSocketDebuggerUrl);
await cdp.ready;
const res = await cdp.send("Runtime.evaluate", {
  expression: "location.href = \"https://www.google.com/maps/place/?q=place_id:ChIJJ6lLsLol9ocRPZDjQBTBWcQ&hl=en&gl=HK\"; location.href",
  returnByValue: true,
});
console.log("navigating:", JSON.stringify(res.result));
process.exit(0);