// Interactive per-action approval: in ask mode, a risky tool must be held until
// the sidebar approves (routes on approve, returns DENIED on deny). Non-risky
// tools are never gated. Simulates the sidebar by having the mock extension
// answer approval.request messages.
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import crypto from "node:crypto";

const PORT = process.env.CIS_PORT || "8905";
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, c, d = "") => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${d}`); } };

const daemon = spawn(process.execPath, ["index.mjs", "serve"], { env: { ...process.env, CIS_PORT: PORT }, stdio: "ignore" });
await sleep(700);

// Mock extension that also acts as the "sidebar": its approval policy is
// switchable so we can test approve and deny.
let approvalPolicy = "approve";
const ext = new WebSocket(URL);
ext.on("open", () => ext.send(JSON.stringify({ type: "hello", role: "extension", platform: "macos" })));
ext.on("message", (b) => {
  const m = JSON.parse(b.toString());
  if (m.type === "ping") return ext.send(JSON.stringify({ type: "pong" }));
  if (m.type === "approval.request") { ext.send(JSON.stringify({ type: "approval", id: m.id, decision: approvalPolicy })); return; }
  if (m.type === "tool") ext.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: { ran: m.tool } }));
});
await new Promise((r) => ext.on("open", r));
await sleep(200);

const agent = new WebSocket(URL);
const waiters = new Map();
const call = (tool, params = {}) => new Promise((res) => { const id = crypto.randomUUID(); waiters.set(id, res); agent.send(JSON.stringify({ type: "tool", id, tool, params })); setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ ok: false, code: "TIMEOUT" }); } }, 6000); });
agent.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } });
await new Promise((r) => agent.on("open", r));
agent.send(JSON.stringify({ type: "hello", role: "mcp" }));
const setMode = (mode) => agent.send(JSON.stringify({ type: "setmode", mode }));
await sleep(150);

console.log("— interactive approval —");
// free mode: risky tool runs without approval
setMode("free"); await sleep(100);
const free = await call("navigate", { url: "https://x.com" });
chk("free mode: risky tool runs (no approval)", free.ok && free.result.ran === "navigate");

// ask mode + approve → runs
setMode("ask"); await sleep(100);
approvalPolicy = "approve";
const appr = await call("navigate", { url: "https://x.com" });
chk("ask mode + Allow → tool runs", appr.ok && appr.result.ran === "navigate", JSON.stringify(appr));

// ask mode + deny → DENIED
approvalPolicy = "deny";
const den = await call("navigate", { url: "https://x.com" });
chk("ask mode + Deny → DENIED", den.ok === false && den.code === "DENIED", JSON.stringify(den));

// ask mode: non-risky tool is NOT gated (runs even while policy=deny)
const read = await call("read_page", {});
chk("ask mode: non-risky read_page not gated", read.ok && read.result.ran === "read_page");

// ask mode: type WITHOUT submit is not risky; WITH submit is
const typeNo = await call("type", { selector: "#a", text: "x" });
chk("ask mode: type (no submit) not gated", typeNo.ok);
approvalPolicy = "deny";
const typeSub = await call("type", { selector: "#a", text: "x", submit: true });
chk("ask mode: type+submit gated → DENIED", typeSub.ok === false && typeSub.code === "DENIED");

console.log(`\n${pass} passed, ${fail} failed`);
ext.close(); agent.close(); daemon.kill();
process.exit(fail ? 1 : 0);
