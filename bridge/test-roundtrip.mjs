// Smoke test: daemon routes an MCP tool call to a mock extension and back.
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

// Use a dedicated test port so this never clashes with the production
// launchd daemon on 8787.
const PORT = process.env.CIS_PORT || "8901";
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const daemon = spawn(process.execPath, ["index.mjs", "serve"], {
  env: { ...process.env, CIS_PORT: PORT },
  stdio: "inherit",
});
await sleep(600);

// Mock Safari extension.
const ext = new WebSocket(URL);
await new Promise((r) => ext.on("open", r));
ext.send(JSON.stringify({ type: "hello", role: "extension", platform: "macos" }));
ext.on("message", (b) => {
  const m = JSON.parse(b.toString());
  if (m.type === "tool") {
    ext.send(JSON.stringify({ type: "result", id: m.id, ok: true,
      result: { echoedTool: m.tool, params: m.params, title: "Example Domain" } }));
  }
});
await sleep(200);

// Mock MCP client.
const mcp = new WebSocket(URL);
await new Promise((r) => mcp.on("open", r));
mcp.send(JSON.stringify({ type: "hello", role: "mcp" }));

const id = crypto.randomUUID();
const result = await new Promise((resolve) => {
  mcp.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.id === id) resolve(m); });
  mcp.send(JSON.stringify({ type: "tool", id, tool: "navigate", params: { url: "https://example.com" } }));
});

console.log("ROUNDTRIP RESULT:", JSON.stringify(result));
const pass = result.ok && result.result.echoedTool === "navigate" && result.result.params.url === "https://example.com";
console.log(pass ? "PASS ✅" : "FAIL ❌");

ext.close(); mcp.close(); daemon.kill();
process.exit(pass ? 0 : 1);
