#!/usr/bin/env node
// Claude in Safari — bridge.
//
//   node index.mjs serve   → always-on daemon (the Hub). Loopback WS server that
//                            relays tool calls between MCP clients and the Safari
//                            extension.
//   node index.mjs mcp     → stdio MCP server spawned by Claude Code. Registers the
//                            browser tools and forwards each call to the daemon.
//
// The `mcp` mode auto-starts the daemon if it isn't already running, so the whole
// thing "just works" the moment Claude Code launches it.

import { WebSocketServer, WebSocket } from "ws";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { viewportToScreen } from "./coords.mjs";
import { ANTHROPIC_TOOLS } from "./tool-schemas.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_FILE = path.join(os.homedir(), "Library/Logs/claude-in-safari-bridge.log");

const HOST = process.env.CIS_HOST || "127.0.0.1";
const PORT = Number(process.env.CIS_PORT || 8787);
const WS_URL = `ws://${HOST}:${PORT}`;
const PING_MS = 15000;

// ---------------------------------------------------------------------------
// Daemon mode
// ---------------------------------------------------------------------------

function serve() {
  const wss = new WebSocketServer({ host: HOST, port: PORT });
  const extensions = new Set();       // ws connections that are Safari extensions
  const pending = new Map();          // requestId -> mcp ws that is awaiting it

  wss.on("connection", (ws) => {
    ws.meta = { role: "unknown", platform: null, alive: true };

    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      switch (msg.type) {
        case "hello":
          ws.meta.role = msg.role;
          ws.meta.platform = msg.platform || null;
          if (msg.role === "extension") extensions.add(ws);
          log(`hello: role=${msg.role} platform=${msg.platform || "-"} (extensions now: ${extensions.size})`);
          break;

        case "pong":
          ws.meta.alive = true;
          break;

        // From an MCP client: route to an extension (or handle daemon-side).
        // In Ask-first mode, consequential actions require the user's approval
        // in the sidebar before they run.
        case "tool": {
          executeTool(msg.tool, msg.params || {}, { extensions })
            .then((reply) => ws.send(JSON.stringify({ type: "result", id: msg.id, ...reply })));
          return;
        }

        // Approve/deny an in-flight action (from the sidebar).
        case "approval": {
          const w = approvalWaiters.get(msg.id);
          if (w) { approvalWaiters.delete(msg.id); w({ approved: msg.decision === "approve" }); }
          break;
        }

        // From an extension: resolve a daemon-internal waiter, else return to
        // the waiting MCP client.
        case "result": {
          if (internalWaiters.has(msg.id)) {
            // Strip transport fields (type/id) so callers get a clean result payload.
            const { type: _t, id: _i, ...payload } = msg;
            internalWaiters.get(msg.id)(payload); internalWaiters.delete(msg.id); break;
          }
          const origin = pending.get(msg.id);
          pending.delete(msg.id);
          if (origin && origin.readyState === WebSocket.OPEN) origin.send(JSON.stringify(msg));
          break;
        }

        // From the sidebar (via the extension): run a headless Claude Code turn
        // and stream events back to the same client.
        case "chat":
          runChat(ws, msg, extensions);
          break;

        // Stop the in-flight agent turn.
        case "chatstop":
          stopChat();
          break;

        // Set the safety mode ("free" | "ask") independently of a chat turn.
        case "setmode":
          askMode = msg.mode === "ask";
          log(`safety mode = ${askMode ? "ask" : "free"}`);
          break;

        // Manage the user's SerpAPI key (from the popup). Replies to the sender.
        case "setserpkey": {
          const r = setSerpKey(msg.key);
          log(`serpapi key ${r.ok ? "saved" : "save failed"}`);
          ws.send(JSON.stringify({ type: "serpkey.result", ok: r.ok, error: r.error }));
          break;
        }
        case "clearserpkey":
          clearSerpKey();
          ws.send(JSON.stringify({ type: "serpkey.result", ok: true, cleared: true }));
          break;
        case "testserpkey": {
          webSearch({ query: "test", limit: 1 }).then((r) =>
            ws.send(JSON.stringify({ type: "serpkey.test", ok: r.ok, code: r.code, error: r.error })));
          break;
        }

        // Anthropic API key + brain-mode selection (from the popup).
        case "setanthropickey": {
          const r = setKey("ANTHROPIC_API_KEY", msg.key);
          log(`anthropic key ${r.ok ? "saved" : "save failed"}`);
          ws.send(JSON.stringify({ type: "anthropickey.result", ok: r.ok, error: r.error }));
          break;
        }
        case "clearanthropickey":
          clearKey("ANTHROPIC_API_KEY");
          ws.send(JSON.stringify({ type: "anthropickey.result", ok: true, cleared: true }));
          break;
        case "setbrain":
          saveConfig({ brain: msg.brain === "api" ? "api" : "claude-code" });
          log(`brain = ${brainMode()}`);
          break;
      }
    });

    ws.on("close", () => {
      if (ws.meta.role === "extension") log(`extension disconnected (extensions now: ${extensions.size - 1})`);
      extensions.delete(ws);
    });
    ws.on("error", () => {});
  });

  // Heartbeat: drop extensions that stopped answering.
  setInterval(() => {
    for (const ws of extensions) {
      if (ws.meta.alive === false) { try { ws.terminate(); } catch {} extensions.delete(ws); continue; }
      ws.meta.alive = false;
      try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
    }
  }, PING_MS);

  wss.on("listening", () => log(`daemon listening on ${WS_URL}`));
  wss.on("error", (e) => {
    if (e.code === "EADDRINUSE") { log("daemon already running; exiting"); process.exit(0); }
    else { log("daemon error: " + e.message); process.exit(1); }
  });
}

function pickExtension(extensions, platform) {
  const list = [...extensions].filter((w) => w.readyState === WebSocket.OPEN);
  if (platform) { const m = list.find((w) => w.meta.platform === platform); if (m) return m; }
  return list[0] || null;
}

// Execute a tool: approval gate (ask mode) → daemon tool OR extension round-trip.
// Shared by the MCP client path and the API-key agent loop. Returns a result
// object { ok, result | code, error }.
async function executeTool(tool, params, ctx) {
  if (askMode && isRisky(tool, params)) {
    const d = await requestApproval(ctx.extensions, tool, params);
    if (!d.approved) return { ok: false, code: "DENIED", error: `User declined: ${d.reason || "not approved"}` };
  }
  if (DAEMON_TOOLS[tool]) {
    try { return await DAEMON_TOOLS[tool](params, ctx); }
    catch (e) { return { ok: false, code: "INTERNAL", error: String(e && e.message ? e.message : e) }; }
  }
  const ext = pickExtension(ctx.extensions);
  if (!ext) return { ok: false, code: "NO_EXTENSION", error: "no Safari extension connected — open Safari and enable Claude in Safari" };
  return await askExtension(ext, tool, params, 45000);
}

// Path to the coordinate-input native helper (built by the mac app; see
// tools/cissynth). Present only after the app is built; absence degrades
// gracefully to a NEEDS_ACCESSIBILITY / UNAVAILABLE capability.
const SYNTH_BIN = process.env.CIS_SYNTH || path.join(
  os.homedir(),
  "Library/Application Support/Claude in Safari/cissynth",
);

function computerStatus() {
  // Reports whether coordinate input (CGEvent) is available. The helper exits 0
  // for `probe` when it can post events (Accessibility granted), 3 when it needs
  // permission, and is simply missing before first build.
  if (!fs.existsSync(SYNTH_BIN)) {
    return { available: false, reason: "UNAVAILABLE", detail: "coordinate-input helper not installed yet" };
  }
  try {
    const r = spawnSync(SYNTH_BIN, ["probe"], { timeout: 3000 });
    if (r.status === 0) return { available: true };
    if (r.status === 3) return { available: false, reason: "NEEDS_ACCESSIBILITY", detail: "grant Accessibility to 'Claude in Safari' in System Settings › Privacy & Security › Accessibility" };
    return { available: false, reason: "ERROR", detail: (r.stderr || "").toString().slice(0, 200) };
  } catch (e) {
    return { available: false, reason: "ERROR", detail: String(e && e.message ? e.message : e) };
  }
}

// Invoke the coordinate-input helper; map its exit codes to structured errors.
function runSynth(args) {
  if (!fs.existsSync(SYNTH_BIN)) {
    return { ok: false, code: "UNAVAILABLE", error: "coordinate-input helper not installed (build the mac app)" };
  }
  const r = spawnSync(SYNTH_BIN, args, { timeout: 5000 });
  if (r.status === 0) { try { return { ok: true, result: JSON.parse((r.stdout || "{}").toString() || "{}") }; } catch { return { ok: true, result: {} }; } }
  if (r.status === 3) return { ok: false, code: "NEEDS_ACCESSIBILITY", error: "grant Accessibility to 'Claude in Safari' in System Settings › Privacy & Security › Accessibility, then retry" };
  return { ok: false, code: "SYNTH_ERROR", error: (r.stderr || "helper failed").toString().slice(0, 200) };
}

// Tools handled entirely by the daemon (no extension round-trip).

// ---- Interactive per-action approval (Ask-first mode) ----
// The consequential actions that require the user's OK before they run.
function isRisky(tool, p = {}) {
  if (["navigate", "close_tab", "computer_click", "computer_type", "computer_key", "computer_click_viewport"].includes(tool)) return true;
  if (tool === "type" && p.submit) return true;
  return false;
}
function summarizeAction(tool, p = {}) {
  switch (tool) {
    case "navigate": return `Navigate to ${p.url}`;
    case "close_tab": return `Close tab ${p.tabId}`;
    case "type": return `Type “${String(p.text).slice(0, 40)}” and submit`;
    case "computer_click": return `Click screen at (${p.x}, ${p.y})`;
    case "computer_click_viewport": return `Click viewport at (${p.x}, ${p.y})`;
    case "computer_type": return `Type “${String(p.text).slice(0, 40)}” at the cursor`;
    case "computer_key": return `Press ${p.key}`;
    default: return tool;
  }
}
const approvalWaiters = new Map();
function requestApproval(extensions, tool, params) {
  return new Promise((resolve) => {
    const ext = pickExtension(extensions);
    if (!ext) return resolve({ approved: false, reason: "no sidebar available to approve (open the Claude sidebar)" });
    const id = crypto.randomUUID();
    approvalWaiters.set(id, resolve);
    try { ext.send(JSON.stringify({ type: "approval.request", id, tool, summary: summarizeAction(tool, params) })); }
    catch { approvalWaiters.delete(id); return resolve({ approved: false, reason: "could not reach sidebar" }); }
    setTimeout(() => { if (approvalWaiters.has(id)) { approvalWaiters.delete(id); resolve({ approved: false, reason: "approval timed out" }); } }, 120000);
  });
}

// Daemon-initiated request to the extension (awaits its result).
const internalWaiters = new Map();
function askExtension(ws, tool, params = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!ws) return resolve({ ok: false, code: "NO_EXTENSION", error: "no Safari extension connected" });
    const id = crypto.randomUUID();
    internalWaiters.set(id, resolve);
    try { ws.send(JSON.stringify({ type: "tool", id, tool, params })); }
    catch (e) { internalWaiters.delete(id); return resolve({ ok: false, code: "NO_EXTENSION", error: String(e) }); }
    setTimeout(() => { if (internalWaiters.has(id)) { internalWaiters.delete(id); resolve({ ok: false, code: "TIMEOUT", error: "extension did not respond" }); } }, timeoutMs);
  });
}

// --- Secret storage (per-user, in macOS Keychain) ---
// Users set their keys from the popup; stored under this app's Keychain service.
const KC_SERVICE = "claude-in-safari";

function readKeychain(service, account) {
  if (process.env.CIS_NO_KEYCHAIN === "1") return null; // test isolation
  try {
    const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { timeout: 3000 });
    if (r.status === 0) { const v = (r.stdout || "").toString().trim(); return v || null; }
  } catch {}
  return null;
}

// Read the SerpAPI key at call time (never persisted in env or logged).
function serpApiKey() {
  return readKeychain(KC_SERVICE, "SERPAPI_KEY");
}

// Store / clear a secret in this app's Keychain service. -U updates if present;
// -A lets the daemon read it without a prompt.
function setKey(account, value) {
  const v = String(value || "").trim();
  if (!v) return { ok: false, error: "empty value" };
  try {
    const r = spawnSync("security", ["add-generic-password", "-s", KC_SERVICE, "-a", account, "-w", v, "-U", "-A"], { timeout: 4000 });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || "keychain error").toString().slice(0, 120) };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
}
function clearKey(account) {
  try { spawnSync("security", ["delete-generic-password", "-s", KC_SERVICE, "-a", account], { timeout: 3000 }); } catch {}
  return { ok: true };
}
const setSerpKey = (k) => setKey("SERPAPI_KEY", k);
const clearSerpKey = () => clearKey("SERPAPI_KEY");

// Anthropic API key (for API-key "brain" mode — runs the agent without Claude Code).
function anthropicKey() {
  return process.env.CIS_ANTHROPIC_KEY || readKeychain(KC_SERVICE, "ANTHROPIC_API_KEY");
}

// Brain mode: "claude-code" (subscription via Claude Code, default) or "api"
// (self-contained loop on the user's Anthropic API key). Persisted so it
// survives daemon restarts.
const CONFIG_FILE = path.join(os.homedir(), "Library/Application Support/Claude in Safari/config.json");
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; } }
function saveConfig(patch) {
  try { const c = { ...loadConfig(), ...patch }; fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c)); return c; } catch { return {}; }
}
function brainMode() {
  if (process.env.CIS_BRAIN) return process.env.CIS_BRAIN === "api" ? "api" : "claude-code";
  return loadConfig().brain === "api" ? "api" : "claude-code";
}

// Shared SerpAPI fetch — key read from Keychain per call, endpoint overridable
// for tests. Returns { data } or { error: { code, message } }.
async function serpFetch(params) {
  const key = serpApiKey();
  if (!key) return { error: { code: "NO_API_KEY", message: "SerpAPI key not in Keychain (store as SERPAPI_KEY)" } };
  const base = process.env.CIS_SERP_BASE || "https://serpapi.com/search.json";
  const usp = new URLSearchParams({ ...params, api_key: key });
  try {
    const res = await fetch(`${base}?${usp}`, { signal: AbortSignal.timeout(35000) });
    const d = await res.json();
    if (d.error) return { error: { code: "SEARCH_ERROR", message: String(d.error) } };
    return { data: d };
  } catch (e) {
    return { error: { code: "SEARCH_ERROR", message: String(e && e.message ? e.message : e) } };
  }
}
const wrap = (r, shape) => r.error ? { ok: false, code: r.error.code, error: r.error.message } : { ok: true, result: shape(r.data) };

// Web search (Google organic) — titles/links/snippets + answer box + related Qs.
async function webSearch(p) {
  const q = (p.query || "").trim();
  if (!q) return { ok: false, code: "BAD_PARAMS", error: "web_search requires 'query'" };
  const lim = Math.min(p.limit || 8, 20);
  const r = await serpFetch({ engine: "google", q, gl: p.region || "us", hl: p.lang || "en", num: String(lim) });
  return wrap(r, (d) => ({
    query: q,
    answer: d.answer_box ? (d.answer_box.answer || d.answer_box.snippet || d.answer_box.title || null) : null,
    results: (d.organic_results || []).slice(0, lim).map((x) => ({ title: x.title, link: x.link, snippet: x.snippet || "", source: x.source || x.displayed_link || "" })),
    related: (d.related_questions || []).slice(0, 4).map((x) => x.question).filter(Boolean),
  }));
}

// Local/places search (Google Maps) — real businesses with rating/phone/hours.
async function localSearch(p) {
  const q = (p.query || "").trim();
  if (!q) return { ok: false, code: "BAD_PARAMS", error: "local_search requires 'query'" };
  const params = { engine: "google_maps", type: "search", q };
  if (p.ll) params.ll = p.ll; // "@lat,long,zoom" for precise geolocation
  const r = await serpFetch(params);
  return wrap(r, (d) => ({
    query: q,
    places: (d.local_results || []).slice(0, p.limit || 8).map((x) => ({
      name: x.title, rating: x.rating, reviews: x.reviews, type: x.type,
      address: x.address, phone: x.phone, hours: x.hours || x.operating_hours || null,
      website: x.website, gps: x.gps_coordinates, place_id: x.place_id, price: x.price,
    })),
  }));
}

// Shopping search (Google Shopping) — products with prices across sellers.
async function shoppingSearch(p) {
  const q = (p.query || "").trim();
  if (!q) return { ok: false, code: "BAD_PARAMS", error: "shopping_search requires 'query'" };
  const r = await serpFetch({ engine: "google_shopping", q, gl: p.region || "us", hl: p.lang || "en" });
  return wrap(r, (d) => ({
    query: q,
    products: (d.shopping_results || []).slice(0, p.limit || 10).map((x) => ({
      title: x.title, price: x.price, extracted_price: x.extracted_price, seller: x.source,
      rating: x.rating, reviews: x.reviews, link: x.product_link || x.link, thumbnail: x.thumbnail,
      delivery: x.delivery,
    })),
  }));
}

// News search (Google News) — current articles with source + date.
async function newsSearch(p) {
  const q = (p.query || "").trim();
  if (!q) return { ok: false, code: "BAD_PARAMS", error: "news_search requires 'query'" };
  const r = await serpFetch({ engine: "google_news", q, gl: p.region || "us", hl: p.lang || "en" });
  return wrap(r, (d) => ({
    query: q,
    articles: (d.news_results || []).slice(0, p.limit || 10).map((x) => ({
      title: x.title, link: x.link, source: (x.source && x.source.name) || x.source || "", date: x.date, snippet: x.snippet || "",
    })),
  }));
}

const DAEMON_TOOLS = {
  web_search: (p) => webSearch(p),
  local_search: (p) => localSearch(p),
  shopping_search: (p) => shoppingSearch(p),
  news_search: (p) => newsSearch(p),
  computer_click(p) {
    if (typeof p.x !== "number" || typeof p.y !== "number") return { ok: false, code: "BAD_PARAMS", error: "computer_click requires numeric x,y" };
    return runSynth(["click", String(p.x), String(p.y), p.button === "right" ? "right" : "left"]);
  },
  computer_type(p) {
    if (typeof p.text !== "string") return { ok: false, code: "BAD_PARAMS", error: "computer_type requires 'text'" };
    return runSynth(["type", p.text]);
  },
  computer_key(p) {
    if (!p.key) return { ok: false, code: "BAD_PARAMS", error: "computer_key requires 'key'" };
    return runSynth(["key", String(p.key)]);
  },
  async computer_click_viewport(p, { extensions }) {
    if (typeof p.x !== "number" || typeof p.y !== "number") return { ok: false, code: "BAD_PARAMS", error: "computer_click_viewport requires numeric x,y" };
    const ext = pickExtension(extensions);
    if (!ext) return { ok: false, code: "NO_EXTENSION", error: "no Safari extension connected" };
    const m = await askExtension(ext, "window_metrics", {});
    if (!m.ok) return m;
    const pt = viewportToScreen(m.result, p.x, p.y, !!p.fromScreenshot);
    const r = runSynth(["click", String(pt.x), String(pt.y), p.button === "right" ? "right" : "left"]);
    return r.ok ? { ok: true, result: { ...r.result, screenPoint: pt } } : r;
  },
  capabilities(_params, { extensions }) {
    const ext = pickExtension(extensions);
    return {
      ok: true,
      result: {
        extensionConnected: !!ext,
        search: { configured: !!serpApiKey() },
        brain: { mode: brainMode(), apiConfigured: !!anthropicKey() },
        platform: ext ? ext.meta.platform : null,
        computer: computerStatus(),
        tools: [
          "navigate", "list_tabs", "new_tab", "close_tab", "activate_tab",
          "read_page", "screenshot", "page_elements", "click", "type", "find",
          "scroll", "hover", "select", "press_key", "go_back", "go_forward",
          "reload", "wait_for", "get_element", "highlight",
          "window_metrics", "web_search", "local_search", "shopping_search", "news_search",
          "capture_start", "read_console", "read_network",
          "computer_click", "computer_click_viewport", "computer_type", "computer_key", "capabilities",
        ],
        version: "0.4.0",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Sidebar chat → headless Claude Code
// ---------------------------------------------------------------------------

const SESSION_FILE = path.join(os.homedir(), "Library/Logs/claude-in-safari-session.json");
const CLAUDE_BIN = process.env.CIS_CLAUDE || path.join(os.homedir(), ".local/bin/claude");
const SELF_PATH = fileURLToPath(import.meta.url);
const MCP_CONFIG = path.join(os.homedir(), "Library/Application Support/Claude in Safari/mcp-config.json");
let chatBusy = false;
let currentChild = null;
let apiStopFlag = false;
// Safety mode: "free" (act without asking) or "ask" (confirm risky actions).
// Set per-turn from the sidebar; gates OS-level computer-use.
let askMode = false;

function stopChat() {
  apiStopFlag = true; // stops the API agent loop between rounds
  if (currentChild) { currentChild.__stopped = true; try { currentChild.kill("SIGTERM"); } catch {} }
}

// Write the MCP config that gives the sidebar agent the safari_* tools. The
// server is this same bridge in `mcp` mode, pointed at the running daemon.
function ensureMcpConfig() {
  const cfg = {
    mcpServers: {
      "claude-in-safari": {
        command: process.execPath,
        args: [SELF_PATH, "mcp"],
        env: { CIS_PORT: String(PORT), CIS_HOST: HOST },
      },
    },
  };
  try {
    fs.mkdirSync(path.dirname(MCP_CONFIG), { recursive: true });
    fs.writeFileSync(MCP_CONFIG, JSON.stringify(cfg, null, 2));
  } catch (e) { log("mcp-config write failed: " + e.message); }
  return MCP_CONFIG;
}

const SIDEBAR_SYSTEM_PROMPT = [
  "You are Claude operating INSIDE the user's Safari browser, like the Claude for Chrome extension.",
  "You control the SAME Safari window the user is looking at, using ONLY the safari_* tools",
  "(safari_navigate, safari_read_page, safari_screenshot, safari_click, safari_type, safari_find,",
  "safari_scroll, safari_new_tab, safari_close_tab, safari_activate_tab, safari_list_tabs, etc.).",
  "NEVER use Bash, osascript, AppleScript, or any shell to control the browser — always use the safari_* tools.",
  "Work in a see-act loop: safari_read_page or safari_screenshot to observe, then act; re-observe after each step.",
  "Use safari_find or safari_page_elements to locate elements, then safari_click/safari_type with the returned selector.",
  "Search tools: safari_web_search (web), safari_local_search (places/maps near a location), safari_shopping_search (product prices), safari_news_search (current news). Use them to find current info or the right URL, then safari_navigate.",
  "Be concise in replies to the user. Report what you did and what you see. If a tool returns an error code,",
  "adapt (e.g. ELEMENT_NOT_FOUND → re-read the page and find the element again).",
].join(" ");

function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch { return {}; }
}
function saveSession(s) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(s)); } catch {}
}

function chatSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Dispatch a chat turn to the configured brain: Claude Code (subscription) or
// the self-contained Anthropic API loop (works for anyone with an API key).
function runChat(ws, msg, extensions) {
  const id = msg.id || crypto.randomUUID();
  if (chatBusy) {
    chatSend(ws, { type: "chat.done", id, error: "Claude is still working on the previous message" });
    return;
  }
  if (brainMode() === "api") return runChatApi(ws, msg, extensions, id);
  return runChatClaudeCode(ws, msg, id);
}

function runChatClaudeCode(ws, msg, id) {
  chatBusy = true;

  const session = loadSession();
  const mcpConfig = ensureMcpConfig();
  askMode = msg.mode === "ask";
  const systemPrompt = askMode
    ? SIDEBAR_SYSTEM_PROMPT + " SAFETY (Ask-first mode): before any consequential action — navigating to a new site, submitting a form, making a purchase, deleting anything, or any computer_* screen action — STOP, briefly describe what you're about to do, and ask the user to confirm in chat. Only proceed after they say yes. Reading and scrolling are fine without asking."
    : SIDEBAR_SYSTEM_PROMPT;
  const args = [
    "-p", msg.text,
    "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions",
    "--mcp-config", mcpConfig,
    "--append-system-prompt", systemPrompt,
    // Surface the safari tools directly (less ToolSearch round-tripping) and
    // keep it a browser agent: block shell escape hatches so it can't fall back
    // to AppleScript/osascript and actually uses our verified tool layer.
    "--allowedTools", "mcp__claude-in-safari",
    "--disallowedTools", "Bash", "Task",
  ];
  if (msg.model) args.push("--model", msg.model);
  if (msg.newSession) delete session.sessionId;
  if (session.sessionId) args.push("--resume", session.sessionId);

  log(`chat: spawning claude (resume=${session.sessionId || "fresh"}, model=${msg.model || "default"})`);
  const child = spawn(CLAUDE_BIN, args, {
    cwd: os.homedir(),
    // Ensure node (and thus claude's own hooks) are on PATH under launchd.
    env: { ...process.env, HOME: os.homedir(), PATH: `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  currentChild = child;

  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 10 * 60 * 1000);
  let buffer = "";

  child.stdout.on("data", (d) => {
    buffer += d.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }

      if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            chatSend(ws, { type: "chat.delta", id, kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            chatSend(ws, { type: "chat.delta", id, kind: "tool", tool: block.name });
          }
        }
      } else if (evt.type === "result") {
        if (evt.session_id) { session.sessionId = evt.session_id; saveSession(session); }
      }
    }
  });

  let stderrTail = "";
  child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-400); });

  child.on("close", (code, signal) => {
    clearTimeout(killer);
    chatBusy = false;
    if (currentChild === child) currentChild = null;
    log(`chat: claude exited code=${code} signal=${signal || "-"}`);
    if (child.__stopped || signal === "SIGTERM" || signal === "SIGKILL" || code === 143 || code === 137) chatSend(ws, { type: "chat.done", id, stopped: true });
    else if (code === 0) chatSend(ws, { type: "chat.done", id });
    else chatSend(ws, { type: "chat.done", id, error: `claude exited ${code}: ${stderrTail.slice(-200)}` });
  });
  child.on("error", (e) => {
    clearTimeout(killer);
    chatBusy = false;
    if (currentChild === child) currentChild = null;
    chatSend(ws, { type: "chat.done", id, error: `cannot start claude: ${e.message}` });
  });
}

// ---------------------------------------------------------------------------
// API-key brain: self-contained agent loop on the Anthropic Messages API.
// Works for anyone with an Anthropic API key — no Claude Code required.
// ---------------------------------------------------------------------------

let apiHistory = [];
const API_MODEL_DEFAULT = "claude-sonnet-5";

async function runChatApi(ws, msg, extensions, id) {
  const key = anthropicKey();
  if (!key) { chatSend(ws, { type: "chat.done", id, error: "No Anthropic API key set — add it in the extension popup (Brain: API key)." }); return; }
  chatBusy = true;
  apiStopFlag = false;
  if (msg.newSession) apiHistory = [];
  apiHistory.push({ role: "user", content: msg.text });

  const model = msg.model || API_MODEL_DEFAULT;
  const system = askMode
    ? SIDEBAR_SYSTEM_PROMPT + " SAFETY (Ask-first mode): before any consequential action, briefly say what you'll do and ask the user to confirm; proceed only after they agree."
    : SIDEBAR_SYSTEM_PROMPT;
  const base = process.env.CIS_ANTHROPIC_BASE || "https://api.anthropic.com/v1/messages";
  const MAX_ROUNDS = 24;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (apiStopFlag) { chatSend(ws, { type: "chat.done", id, stopped: true }); break; }

      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 4096, system, tools: ANTHROPIC_TOOLS, messages: apiHistory, stream: true }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        chatSend(ws, { type: "chat.done", id, error: `API error ${res.status}: ${errText.slice(0, 200)}` });
        break;
      }

      const parsed = await consumeAnthropicStream(res, (text) => chatSend(ws, { type: "chat.delta", id, kind: "text", text }));
      // Record the assistant turn.
      apiHistory.push({ role: "assistant", content: parsed.content });

      if (parsed.stopReason === "tool_use") {
        const toolUses = parsed.content.filter((b) => b.type === "tool_use");
        const toolResults = [];
        for (const tu of toolUses) {
          chatSend(ws, { type: "chat.delta", id, kind: "tool", tool: tu.name });
          const daemonTool = tu.name.replace(/^safari_/, "");
          const r = await executeTool(daemonTool, tu.input || {}, { extensions });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(r).slice(0, 8000), is_error: r.ok === false });
        }
        apiHistory.push({ role: "user", content: toolResults });
        continue; // loop for the model's next step
      }
      // Any other stop reason → the turn is complete.
      chatSend(ws, { type: "chat.done", id });
      break;
    }
  } catch (e) {
    chatSend(ws, { type: "chat.done", id, error: `agent error: ${String(e && e.message ? e.message : e)}` });
  } finally {
    chatBusy = false;
  }
}

// Parse an Anthropic SSE stream. Streams text via onText; returns the full
// assistant content blocks + stop reason for history + tool execution.
async function consumeAnthropicStream(res, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const blocks = []; // index -> {type, text | (name,id,jsonBuf)}
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }

      if (ev.type === "content_block_start") {
        const cb = ev.content_block;
        blocks[ev.index] = cb.type === "tool_use"
          ? { type: "tool_use", id: cb.id, name: cb.name, jsonBuf: "" }
          : { type: "text", text: "" };
      } else if (ev.type === "content_block_delta") {
        const b = blocks[ev.index];
        if (!b) continue;
        if (ev.delta.type === "text_delta") { b.text += ev.delta.text; if (onText) onText(ev.delta.text); }
        else if (ev.delta.type === "input_json_delta") { b.jsonBuf += ev.delta.partial_json; }
      } else if (ev.type === "message_delta") {
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      }
    }
  }

  const content = blocks.filter(Boolean).map((b) => {
    if (b.type === "tool_use") { let input = {}; try { input = b.jsonBuf ? JSON.parse(b.jsonBuf) : {}; } catch {} return { type: "tool_use", id: b.id, name: b.name, input }; }
    return { type: "text", text: b.text };
  });
  return { content, stopReason };
}

// ---------------------------------------------------------------------------
// MCP mode
// ---------------------------------------------------------------------------

async function mcpMain() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  await ensureDaemon();
  const link = await connectToDaemon();

  const server = new McpServer({ name: "claude-in-safari", version: "0.4.0" });

  const call = (tool, params) => link.request(tool, params);
  const tabId = z.number().int().optional().describe("Target tab id; omit for the active tab");

  // ---- navigation & tabs ----
  server.tool(
    "safari_navigate",
    "Navigate a Safari tab to a URL and wait for it to load.",
    { url: z.string().describe("The URL to open, e.g. https://example.com"), tabId },
    async (a) => textResult(await call("navigate", a)),
  );
  server.tool(
    "safari_list_tabs",
    "List all open Safari tabs (id, url, title, whether active).",
    {},
    async () => textResult(await call("list_tabs", {})),
  );
  server.tool(
    "safari_new_tab",
    "Open a new Safari tab, optionally at a URL.",
    { url: z.string().optional(), active: z.boolean().optional().describe("Focus the new tab (default true)") },
    async (a) => textResult(await call("new_tab", a)),
  );
  server.tool(
    "safari_close_tab",
    "Close a Safari tab by id.",
    { tabId: z.number().int().describe("The tab id to close") },
    async (a) => textResult(await call("close_tab", a)),
  );
  server.tool(
    "safari_activate_tab",
    "Bring a Safari tab to the foreground by id.",
    { tabId: z.number().int().describe("The tab id to activate") },
    async (a) => textResult(await call("activate_tab", a)),
  );

  // ---- reading ----
  server.tool(
    "safari_read_page",
    "Read a Safari page. mode='text' (visible text), 'a11y' (accessibility tree), or 'both'.",
    { mode: z.enum(["text", "a11y", "both"]).optional().describe("Default 'text'"), tabId },
    async (a) => textResult(await call("read_page", a)),
  );
  server.tool(
    "safari_screenshot",
    "Capture a PNG screenshot of a Safari tab. Set fullPage=true to capture the entire scrollable page (stitched), not just the visible area.",
    { tabId, fullPage: z.boolean().optional().describe("Capture the whole page, not just the viewport") },
    async (a) => {
      const r = await call("screenshot", a);
      if (!r.ok) return textResult(r);
      const strip = (u) => String(u).replace(/^data:image\/png;base64,/, "");
      if (r.result.dataUrl) return { content: [{ type: "image", data: strip(r.result.dataUrl), mimeType: "image/png" }] };
      if (Array.isArray(r.result.images)) return { content: r.result.images.map((u) => ({ type: "image", data: strip(u), mimeType: "image/png" })) };
      return textResult(r);
    },
  );

  // ---- interaction (selector-based) ----
  server.tool(
    "safari_click",
    "Click an element matching a CSS selector in a Safari tab.",
    { selector: z.string().describe("CSS selector, e.g. 'button.submit' or '#login'"), tabId },
    async (a) => textResult(await call("click", a)),
  );
  server.tool(
    "safari_type",
    "Type text into an element matching a CSS selector; optionally submit.",
    { selector: z.string(), text: z.string(), submit: z.boolean().optional().describe("Press Enter / submit the form after typing"), tabId },
    async (a) => textResult(await call("type", a)),
  );
  server.tool(
    "safari_find",
    "Find interactive elements whose text/label contains a query; returns selectors you can click or type into.",
    { query: z.string().describe("Text to search for"), limit: z.number().int().optional(), tabId },
    async (a) => textResult(await call("find", a)),
  );
  server.tool(
    "safari_page_elements",
    "Inventory the actionable elements on the page (links, buttons, inputs, selects) with ready-to-use selectors, type, and label. Use this to see what you can act on without guessing selectors.",
    { limit: z.number().int().optional(), visibleOnly: z.boolean().optional().describe("Only elements with a nonzero box"), tabId },
    async (a) => textResult(await call("page_elements", a)),
  );

  // ---- console & network capture ----
  server.tool(
    "safari_capture_start",
    "Start capturing console logs and network requests on a Safari tab. Call this BEFORE the activity you want to observe (Safari can't read past events).",
    { tabId },
    async (a) => textResult(await call("capture_start", a)),
  );
  server.tool(
    "safari_read_console",
    "Read captured console messages (call safari_capture_start first). Optional regex 'pattern' filter.",
    { pattern: z.string().optional(), tabId },
    async (a) => textResult(await call("read_console", a)),
  );
  server.tool(
    "safari_read_network",
    "Read captured network requests (call safari_capture_start first). Optional regex 'pattern' filter on URL.",
    { pattern: z.string().optional(), tabId },
    async (a) => textResult(await call("read_network", a)),
  );

  // ---- rich interaction ----
  server.tool(
    "safari_scroll",
    "Scroll the page: by 'direction' (up/down/left/right), to absolute x/y, or to bring a 'selector' into view.",
    { selector: z.string().optional(), x: z.number().optional(), y: z.number().optional(), direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().optional(), tabId },
    async (a) => textResult(await call("scroll", a)),
  );
  server.tool(
    "safari_hover",
    "Hover the mouse over an element (fires mouseover/enter/move) — reveals menus/tooltips.",
    { selector: z.string(), tabId },
    async (a) => textResult(await call("hover", a)),
  );
  server.tool(
    "safari_select",
    "Choose an option in a <select> dropdown by value or visible label.",
    { selector: z.string(), value: z.string(), tabId },
    async (a) => textResult(await call("select", a)),
  );
  server.tool(
    "safari_press_key",
    "Dispatch a key (Enter, Tab, Escape, Arrow*, etc.) to an element or the focused element.",
    { key: z.string(), selector: z.string().optional(), tabId },
    async (a) => textResult(await call("press_key", a)),
  );
  server.tool("safari_go_back", "Navigate back in history.", { tabId }, async (a) => textResult(await call("go_back", a)));
  server.tool("safari_go_forward", "Navigate forward in history.", { tabId }, async (a) => textResult(await call("go_forward", a)));
  server.tool("safari_reload", "Reload the tab.", { tabId }, async (a) => textResult(await call("reload", a)));
  server.tool(
    "safari_wait_for",
    "Wait until a selector appears (or state='navigation' for load). Returns when ready or WAIT_TIMEOUT.",
    { selector: z.string().optional(), state: z.enum(["navigation"]).optional(), timeout: z.number().optional(), tabId },
    async (a) => textResult(await call("wait_for", a)),
  );
  server.tool(
    "safari_get_element",
    "Inspect one element: bounding box, visible text, tag, visibility, and attributes.",
    { selector: z.string(), tabId },
    async (a) => textResult(await call("get_element", a)),
  );
  server.tool(
    "safari_highlight",
    "Briefly outline an element on the page (visual confirmation of what you're about to act on).",
    { selector: z.string(), ms: z.number().optional(), tabId },
    async (a) => textResult(await call("highlight", a)),
  );

  // ---- coordinate / computer-use (native CGEvent helper) ----
  server.tool(
    "safari_computer_click",
    "Click at screen coordinates via macOS CGEvent (computer-use style). Requires the Accessibility permission.",
    { x: z.number(), y: z.number(), button: z.enum(["left", "right"]).optional() },
    async (a) => textResult(await call("computer_click", a)),
  );
  server.tool(
    "safari_computer_click_viewport",
    "Click at a VIEWPORT coordinate (CSS points, or screenshot pixels if fromScreenshot=true) — maps to a screen click via CGEvent. Prefer safari_click with a selector when possible; this is for pixel/screenshot-grounded clicks. Requires Accessibility.",
    { x: z.number(), y: z.number(), fromScreenshot: z.boolean().optional(), button: z.enum(["left", "right"]).optional() },
    async (a) => textResult(await call("computer_click_viewport", a)),
  );
  server.tool(
    "safari_computer_type",
    "Type text via macOS CGEvent (computer-use style). Requires the Accessibility permission.",
    { text: z.string() },
    async (a) => textResult(await call("computer_type", a)),
  );
  server.tool(
    "safari_computer_key",
    "Press a key or chord via macOS CGEvent, e.g. 'Return', 'cmd+t'. Requires the Accessibility permission.",
    { key: z.string() },
    async (a) => textResult(await call("computer_key", a)),
  );

  // ---- web search ----
  server.tool(
    "safari_web_search",
    "Search the web (SerpAPI/Google). Returns titles, links, snippets, an answer box when available, and related questions. Use this to find URLs to open with safari_navigate, or to answer questions that need current info.",
    { query: z.string(), limit: z.number().int().optional(), region: z.string().optional().describe("Country code, e.g. 'us'"), lang: z.string().optional() },
    async (a) => textResult(await call("web_search", a)),
  );
  server.tool(
    "safari_local_search",
    "Find local businesses/places (Google Maps): returns name, rating, reviews, address, phone, hours, and website. Use for 'near me' / 'best X in <place>' queries, then safari_navigate to a website to book.",
    { query: z.string().describe("e.g. 'dentist in Austin TX' or 'coffee near me'"), ll: z.string().optional().describe("Optional '@lat,long,zoom' for precise location"), limit: z.number().int().optional() },
    async (a) => textResult(await call("local_search", a)),
  );
  server.tool(
    "safari_shopping_search",
    "Compare products/prices across sellers (Google Shopping): title, price, seller, rating, link.",
    { query: z.string(), limit: z.number().int().optional(), region: z.string().optional(), lang: z.string().optional() },
    async (a) => textResult(await call("shopping_search", a)),
  );
  server.tool(
    "safari_news_search",
    "Current news articles (Google News): title, source, date, link, snippet.",
    { query: z.string(), limit: z.number().int().optional(), region: z.string().optional(), lang: z.string().optional() },
    async (a) => textResult(await call("news_search", a)),
  );

  // ---- meta ----
  server.tool(
    "safari_capabilities",
    "Report what's available: extension connection, computer-use (CGEvent) status, and the full tool list.",
    {},
    async () => textResult(await call("capabilities", {})),
  );

  await server.connect(new StdioServerTransport());
  log("mcp server ready");
}

function textResult(r) {
  if (r && r.ok) return { content: [{ type: "text", text: JSON.stringify(r.result, null, 2) }] };
  return { content: [{ type: "text", text: `Error: ${r ? r.error : "no response"}` }], isError: true };
}

// A resilient request/response client over the daemon WS. Auto-reconnects if
// the daemon restarts (launchd KeepAlive); returns a structured NO_BRIDGE error
// while down instead of hanging or throwing.
async function connectToDaemon() {
  const waiters = new Map();
  let ws = null;
  let connected = false;
  let opening = null;

  const open = () => {
    if (opening) return opening;
    opening = new Promise((resolve) => {
      const sock = new WebSocket(WS_URL);
      sock.on("open", () => {
        connected = true; ws = sock; opening = null;
        sock.send(JSON.stringify({ type: "hello", role: "mcp" }));
        resolve();
      });
      sock.on("message", (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.type === "result" && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
      });
      sock.on("close", () => {
        connected = false; ws = null; opening = null;
        setTimeout(() => { if (!connected) open().catch(() => {}); }, 500);
      });
      sock.on("error", () => { try { sock.close(); } catch {} });
    });
    return opening;
  };

  await Promise.race([open(), new Promise((r) => setTimeout(r, 3000))]);

  return {
    async request(tool, params) {
      if (!connected) await Promise.race([open().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      if (!connected || !ws) return { ok: false, code: "NO_BRIDGE", error: "bridge daemon unreachable" };
      return new Promise((res) => {
        const id = crypto.randomUUID();
        waiters.set(id, res);
        try { ws.send(JSON.stringify({ type: "tool", id, tool, params })); }
        catch (e) { waiters.delete(id); return res({ ok: false, code: "NO_BRIDGE", error: String(e && e.message ? e.message : e) }); }
        setTimeout(() => {
          if (waiters.has(id)) { waiters.delete(id); res({ ok: false, code: "TIMEOUT", error: "timed out waiting for Safari" }); }
        }, 45000);
      });
    },
  };
}

// Ensure a daemon is running; if not, spawn a detached one and wait for it.
async function ensureDaemon() {
  if (await canConnect()) return;
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, "serve"], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) {           // up to ~4s
    await sleep(100);
    if (await canConnect()) return;
  }
  throw new Error("could not start bridge daemon");
}

function canConnect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const done = (ok) => { try { ws.terminate(); } catch {} resolve(ok); };
    ws.on("open", () => done(true));
    ws.on("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Logs go to stderr (never stdout — that would corrupt MCP's stdio JSON-RPC)
// and to a file so the daemon is observable even when spawned detached.
function log(m) {
  process.stderr.write(`[claude-in-safari] ${m}\n`);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${m}\n`); } catch {}
}

// ---------------------------------------------------------------------------

const mode = process.argv[2];
if (mode === "serve") serve();
else if (mode === "mcp") mcpMain().catch((e) => { log("fatal: " + e.message); process.exit(1); });
else { process.stderr.write("usage: index.mjs <serve|mcp>\n"); process.exit(2); }
