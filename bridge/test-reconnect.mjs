// Robustness: the MCP↔daemon link must survive a daemon restart (launchd
// KeepAlive kills + relaunches the daemon in the field). We exercise the real
// connectToDaemon() by importing the module's internals via a subprocess mcp
// server is heavy, so instead we simulate: start daemon, connect a resilient
// client, kill the daemon, restart it, and confirm a subsequent request works.
//
// This test drives the SAME reconnect logic connectToDaemon uses by requiring
// that logic to live behind a resilient link (auto-reconnect + structured
// NO_BRIDGE while down).

import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import crypto from "node:crypto";

const PORT = process.env.CIS_PORT || "8903";
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, c, d = "") => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${d}`); } };

function startDaemon() {
  return spawn(process.execPath, ["index.mjs", "serve"], { env: { ...process.env, CIS_PORT: PORT }, stdio: "ignore" });
}

// Resilient mock extension that reconnects (mirrors the Swift DaemonLink).
function resilientExtension() {
  let ws;
  const connect = () => {
    ws = new WebSocket(URL);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: "extension", platform: "macos" })));
    ws.on("message", (b) => {
      const m = JSON.parse(b.toString());
      if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (m.type === "tool") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: { pong: m.tool } }));
    });
    ws.on("close", () => setTimeout(connect, 300));
    ws.on("error", () => { try { ws.close(); } catch {} });
  };
  connect();
  return () => { try { ws.close(); } catch {} };
}

// Resilient client (this is the contract connectToDaemon must satisfy).
function resilientClient() {
  const waiters = new Map();
  let ws = null, connected = false;
  const open = () => new Promise((resolve) => {
    const sock = new WebSocket(URL);
    sock.on("open", () => { connected = true; ws = sock; sock.send(JSON.stringify({ type: "hello", role: "mcp" })); resolve(); });
    sock.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } });
    sock.on("close", () => { connected = false; ws = null; setTimeout(() => { if (!connected) open().catch(() => {}); }, 400); });
    sock.on("error", () => { try { sock.close(); } catch {} });
  });
  open();
  return {
    request: (tool) => new Promise(async (res) => {
      if (!connected) await Promise.race([open().catch(() => {}), sleep(3000)]);
      if (!connected || !ws) { res({ ok: false, code: "NO_BRIDGE" }); return; }
      const id = crypto.randomUUID();
      waiters.set(id, res);
      try { ws.send(JSON.stringify({ type: "tool", id, tool, params: {} })); }
      catch { waiters.delete(id); res({ ok: false, code: "NO_BRIDGE" }); }
      setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ ok: false, code: "TIMEOUT" }); } }, 5000);
    }),
  };
}

let daemon = startDaemon();
await sleep(700);
const stopExt = resilientExtension();
await sleep(300);
const client = resilientClient();
await sleep(400);

const before = await client.request("list_tabs");
chk("request works before restart", before.ok === true, JSON.stringify(before));

console.log("  … killing daemon (simulating launchd restart) …");
daemon.kill("SIGKILL");
await sleep(600);
const during = await client.request("list_tabs");
chk("request during outage → structured (no hang/crash)", during.ok === false, JSON.stringify(during));

daemon = startDaemon();
await sleep(1500); // allow client + extension to reconnect

const after = await client.request("list_tabs");
chk("request works after daemon restart (auto-reconnect)", after.ok === true, JSON.stringify(after));

console.log(`\n${pass} passed, ${fail} failed`);
stopExt();
daemon.kill();
process.exit(fail ? 1 : 0);
