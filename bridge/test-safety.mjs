// Safety-mode fail-safe: in "ask" mode, risky actions require sidebar approval;
// with NO sidebar/approver present they must fail SAFE (DENIED), never execute.
// In "free" mode they pass through (computer_* → UNAVAILABLE since the helper is
// absent in tests; extension tools → NO_EXTENSION). Interactive approve/deny with
// a live approver is covered by test-approval.mjs. No real clicks are fired.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import crypto from "node:crypto";

const PORT = process.env.CIS_PORT || "8904";
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, c, d = "") => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${d}`); } };

const daemon = spawn(process.execPath, ["index.mjs", "serve"], {
  env: { ...process.env, CIS_PORT: PORT, CIS_SYNTH: "/nonexistent/cissynth" }, stdio: "ignore",
});
await sleep(700);

const ws = new WebSocket(URL);
const waiters = new Map();
const call = (tool, params = {}) => new Promise((res) => {
  const id = crypto.randomUUID(); waiters.set(id, res);
  ws.send(JSON.stringify({ type: "tool", id, tool, params }));
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ ok: false, code: "TIMEOUT" }); } }, 6000);
});
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } });
const setMode = (mode) => ws.send(JSON.stringify({ type: "setmode", mode }));

await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", role: "mcp" }));
await sleep(200);

console.log("— safety fail-safe (ask mode, no approver) —");
setMode("ask"); await sleep(150);
const c1 = await call("computer_click", { x: 100, y: 100 });
chk("ask mode blocks computer_click SAFE → DENIED", c1.ok === false && c1.code === "DENIED", JSON.stringify(c1));
const nav = await call("navigate", { url: "https://x.com" });
chk("ask mode blocks navigate SAFE → DENIED", nav.ok === false && nav.code === "DENIED", JSON.stringify(nav));

console.log("— non-risky tools never gated —");
const read = await call("read_page", {});
chk("ask mode: read_page not gated (→ NO_EXTENSION here)", read.code === "NO_EXTENSION", JSON.stringify(read));

console.log("— free mode passes through —");
setMode("free"); await sleep(150);
const c2 = await call("computer_click", { x: 100, y: 100 });
chk("free mode: computer_click → UNAVAILABLE (helper absent)", c2.ok === false && c2.code === "UNAVAILABLE", JSON.stringify(c2));
const nav2 = await call("navigate", { url: "https://x.com" });
chk("free mode: navigate → NO_EXTENSION (no gate)", nav2.code === "NO_EXTENSION");

console.log(`\n${pass} passed, ${fail} failed`);
ws.close(); daemon.kill();
process.exit(fail ? 1 : 0);
