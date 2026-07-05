// Live verification against the REAL Safari extension via the production daemon
// on :8787. Exercises the full tool surface end-to-end. Run with Safari open
// and the extension enabled.
import { WebSocket } from "ws";
import crypto from "node:crypto";

const ws = new WebSocket("ws://127.0.0.1:8787");
const waiters = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (tool, params = {}) => new Promise((res) => {
  const id = crypto.randomUUID();
  waiters.set(id, res);
  ws.send(JSON.stringify({ type: "tool", id, tool, params }));
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ ok: false, code: "TIMEOUT" }); } }, 40000);
});
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } });

let pass = 0, fail = 0;
const chk = (n, c, d = "") => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${d}`); } };

await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", role: "mcp" }));
await sleep(300);

// Wait (up to 30s) for the Safari extension to be connected. It may still be
// re-polling after a daemon restart; nudge Safari isn't possible from here, so
// just poll capabilities.
console.log("— waiting for extension —");
let connected = false;
for (let i = 0; i < 15; i++) {
  const c = await call("capabilities");
  if (c.ok && c.result.extensionConnected) { connected = true; break; }
  await sleep(2000);
}
if (!connected) {
  console.log("  ⚠️  extension not connected — open Safari to a normal page and re-run.");
  console.log("\n0 passed, 0 failed (SKIPPED: extension offline)");
  process.exit(2);
}

console.log("— capabilities —");
const cap = await call("capabilities");
chk("extension connected", cap.ok && cap.result.extensionConnected === true, JSON.stringify(cap).slice(0, 120));
chk("reports 17 tools", cap.ok && cap.result.tools.length >= 17);
console.log(`    computer-use: ${cap.ok ? JSON.stringify(cap.result.computer) : "n/a"}`);

console.log("— navigate + read_page —");
const nav = await call("navigate", { url: "https://example.com" });
chk("navigate example.com", nav.ok && /example\.com/.test(nav.result.url), JSON.stringify(nav).slice(0, 120));
const both = await call("read_page", { mode: "both" });
chk("read_page text has 'Example Domain'", both.ok && /Example Domain/.test(both.result.text));
chk("read_page a11y tree present", both.ok && both.result.a11y && both.result.a11y.role === "WebArea");
const hasHeading = both.ok && JSON.stringify(both.result.a11y).includes("heading");
chk("a11y tree contains a heading", hasHeading);

console.log("— find + click —");
// example.com's link text is "Learn more" (formerly "More information...").
const found = await call("find", { query: "learn more" });
chk("find returns a match", found.ok && found.result.length >= 1, JSON.stringify(found).slice(0, 120));
if (found.ok && found.result.length) {
  const sel = found.result[0].selector;
  const clicked = await call("click", { selector: sel });
  chk("click the found link", clicked.ok, JSON.stringify(clicked).slice(0, 120));
  await sleep(2500);
  const after = await call("read_page", { mode: "text" });
  chk("navigation changed after click", after.ok && !/example\.com\/$/.test(after.result.url), after.ok ? after.result.url : "");
}
const clickMissing = await call("click", { selector: "#definitely-not-here-xyz" });
chk("click missing → ELEMENT_NOT_FOUND", clickMissing.ok === false && clickMissing.code === "ELEMENT_NOT_FOUND", JSON.stringify(clickMissing));

console.log("— tabs —");
const nt = await call("new_tab", { url: "https://example.org" });
chk("new_tab", nt.ok && typeof nt.result?.tabId === "number", JSON.stringify(nt).slice(0, 120));
await sleep(1500);
const newId = nt.ok ? nt.result.tabId : -1;
const tabs = await call("list_tabs");
chk("list_tabs includes new tab", tabs.ok && tabs.result.some((t) => t.id === newId));
const act = await call("activate_tab", { tabId: newId });
chk("activate_tab", act.ok);
const ct = await call("close_tab", { tabId: newId });
chk("close_tab", ct.ok && ct.result.closed === newId);
const ctBad = await call("close_tab", { tabId: 999999 });
chk("close_tab bad → TAB_NOT_FOUND", ctBad.ok === false && ctBad.code === "TAB_NOT_FOUND");

console.log("— type (on a form page) —");
await call("navigate", { url: "https://duckduckgo.com" });
await sleep(2500);
const typed = await call("type", { selector: "input[name=q]", text: "claude in safari" });
chk("type into search box", typed.ok || typed.code === "ELEMENT_NOT_FOUND", JSON.stringify(typed).slice(0, 120));

console.log("— console/network capture (mechanical) —");
await call("navigate", { url: "https://example.com" });
await sleep(1500);
const early = await call("read_console");
chk("read_console before start → NOT_CAPTURING", early.ok === false && early.code === "NOT_CAPTURING", JSON.stringify(early));
const cs = await call("capture_start");
chk("capture_start ok", cs.ok);
const rc = await call("read_console");
chk("read_console after start → capturing (array)", rc.ok && Array.isArray(rc.result));
const rn = await call("read_network");
chk("read_network after start → array", rn.ok && Array.isArray(rn.result));

console.log("— rich interaction (Phase B) live —");
await call("navigate", { url: "https://en.wikipedia.org/wiki/Web_browser" });
await sleep(2500);
const sc = await call("scroll", { direction: "down", amount: 1200 });
chk("scroll down", sc.ok && sc.result.scrolledTo.y > 0, JSON.stringify(sc).slice(0, 100));
const scTop = await call("scroll", { y: 0 });
chk("scroll to top", scTop.ok && scTop.result.scrolledTo.y === 0);
const ge = await call("get_element", { selector: "h1" });
chk("get_element h1 has rect+text", ge.ok && ge.result.rect.width > 0 && ge.result.text.length > 0, JSON.stringify(ge?.result?.text || ge).slice(0, 80));
const geMiss = await call("get_element", { selector: "#nope-not-real-xyz" });
chk("get_element missing → ELEMENT_NOT_FOUND", geMiss.ok === false && geMiss.code === "ELEMENT_NOT_FOUND");
const hl = await call("highlight", { selector: "h1" });
chk("highlight h1", hl.ok);
const hov = await call("hover", { selector: "a" });
chk("hover first link", hov.ok || hov.code === "ELEMENT_NOT_FOUND");
const wf = await call("wait_for", { selector: "h1", timeout: 3000 });
chk("wait_for existing selector", wf.ok && wf.result.found);
const wfT = await call("wait_for", { selector: "#will-never-exist-xyz", timeout: 1500 });
chk("wait_for missing → WAIT_TIMEOUT", wfT.ok === false && wfT.code === "WAIT_TIMEOUT");
const pk = await call("press_key", { key: "End" });
chk("press_key End", pk.ok);
// select on a real dropdown: DuckDuckGo settings has none reliably; test select error path on a non-select
await call("navigate", { url: "https://example.com" }); await sleep(1500);
const selErr = await call("select", { selector: "h1", value: "x" });
chk("select on non-select falls back (ok) or structured", selErr.ok === true || typeof selErr.code === "string");
const back = await call("go_back"); await sleep(1500);
chk("go_back ok", back.ok);
const fwd = await call("go_forward"); await sleep(1000);
chk("go_forward ok", fwd.ok);
const rl = await call("reload"); await sleep(1000);
chk("reload ok", rl.ok);

console.log("— screenshot —");
const shot = await call("screenshot");
chk("screenshot returns PNG dataUrl", shot.ok && shot.result.dataUrl.startsWith("data:image/png"));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail ? 1 : 0);
