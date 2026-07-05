// API-key brain: verify the self-contained agent loop calls a tool, feeds the
// result back, and completes — against a STUB Anthropic streaming endpoint (no
// real API, no key, hermetic). Also verifies the no-key error path.
import { spawn } from "node:child_process";
import http from "node:http";
import { WebSocket } from "ws";

const PORT = "8909";
const ANTHRO_PORT = 8910;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, c, d = "") => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${d}`); } };

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
// Stub Anthropic: 1st call → tool_use safari_capabilities; 2nd call → final text.
let calls = 0;
const anthro = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    calls++;
    if (calls === 1) {
      res.end(sse([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "safari_capabilities" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      ]));
    } else {
      res.end(sse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All set — capabilities read." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]));
    }
  });
});
await new Promise((r) => anthro.listen(ANTHRO_PORT, "127.0.0.1", r));

function daemon(env) { return spawn(process.execPath, ["index.mjs", "serve"], { env: { ...process.env, ...env }, stdio: "ignore" }); }
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((r) => ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", role: "mcp" })); r(ws); }));
}

// --- 1: no key → structured error ---
{
  const d = daemon({ CIS_PORT: PORT, CIS_BRAIN: "api", CIS_NO_KEYCHAIN: "1", CIS_ANTHROPIC_BASE: `http://127.0.0.1:${ANTHRO_PORT}/m` });
  await sleep(700);
  const ws = await connect(PORT);
  const done = new Promise((r) => ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "chat.done") r(m); }));
  ws.send(JSON.stringify({ type: "chat", id: "n1", newSession: true, text: "hi" }));
  const r = await done;
  chk("no key → chat.done with error", !!r.error && /API key/i.test(r.error), JSON.stringify(r));
  ws.close(); d.kill(); await sleep(300);
}

// --- 2: full loop → tool call + completion ---
{
  calls = 0; // reset stub for a fresh conversation
  const d = daemon({ CIS_PORT: PORT, CIS_BRAIN: "api", CIS_NO_KEYCHAIN: "1", CIS_ANTHROPIC_KEY: "dummy-key", CIS_ANTHROPIC_BASE: `http://127.0.0.1:${ANTHRO_PORT}/m` });
  await sleep(700);
  const ws = await connect(PORT);
  const tools = []; let text = "";
  const done = new Promise((r) => ws.on("message", (b) => {
    const m = JSON.parse(b.toString());
    if (m.type === "chat.delta" && m.kind === "tool") tools.push(m.tool);
    if (m.type === "chat.delta" && m.kind === "text") text += m.text;
    if (m.type === "chat.done") r(m);
  }));
  ws.send(JSON.stringify({ type: "chat", id: "l1", newSession: true, model: "claude-sonnet-4-5", text: "what can you do?" }));
  const r = await done;
  chk("agent loop executed a tool", tools.includes("safari_capabilities"), JSON.stringify(tools));
  chk("streamed final text", /capabilities read/i.test(text), text);
  chk("completed without error", !r.error, JSON.stringify(r));
  ws.close(); d.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
anthro.close();
process.exit(fail ? 1 : 0);
