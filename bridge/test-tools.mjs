// Protocol-level test suite for the full tool surface.
// Runs a daemon on a TEST port (8899) with a mock extension that implements
// the extension-side tool semantics in-memory. Verifies routing, parameter
// passing, result shapes, and the structured-error taxonomy.
//
// This suite tests the PROTOCOL; live Safari behavior is verified separately
// against the real extension (see WORKLOG / MORNING-REPORT).

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const PORT = 8899;
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// ---------------------------------------------------------------------------
// Mock extension: in-memory Safari.
// ---------------------------------------------------------------------------
function startMockExtension() {
  const state = {
    nextTabId: 3,
    tabs: new Map([
      [1, { id: 1, url: "https://example.com/", title: "Example Domain", active: true }],
      [2, { id: 2, url: "https://apple.com/", title: "Apple", active: false }],
    ]),
    capturing: new Set(),
    console: [{ level: "log", text: "hello from page" }, { level: "error", text: "boom" }],
    network: [{ method: "GET", url: "https://example.com/api", status: 200 }],
  };

  const activeTab = () => [...state.tabs.values()].find((t) => t.active);
  const target = (params) => {
    if (params.tabId != null) {
      const t = state.tabs.get(params.tabId);
      if (!t) return { err: { ok: false, code: "TAB_NOT_FOUND", error: `no tab ${params.tabId}` } };
      return { tab: t };
    }
    return { tab: activeTab() };
  };

  const tools = {
    navigate(p) {
      if (!p.url) return { ok: false, code: "BAD_PARAMS", error: "navigate requires 'url'" };
      const { tab, err } = target(p); if (err) return err;
      tab.url = p.url; tab.title = "Navigated";
      return { ok: true, result: { tabId: tab.id, url: tab.url, title: tab.title } };
    },
    read_page(p) {
      const { tab, err } = target(p); if (err) return err;
      const res = { url: tab.url, title: tab.title };
      const mode = p.mode || "text";
      if (mode === "text" || mode === "both") res.text = "Example Domain body text";
      if (mode === "a11y" || mode === "both") {
        res.a11y = { role: "WebArea", name: tab.title, children: [{ role: "heading", name: "Example Domain", level: 1 }] };
      }
      return { ok: true, result: res };
    },
    screenshot(p) {
      const { err } = target(p); if (err) return err;
      return { ok: true, result: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAA" } };
    },
    page_elements(p) {
      const { err } = target(p); if (err) return err;
      return { ok: true, result: [
        { selector: "a#link", type: "link", text: "More", inViewport: true },
        { selector: "button#go", type: "button", text: "Go", inViewport: true },
        { selector: "input#q", type: "input:text", text: "", inViewport: true },
      ].slice(0, p.limit || 60) };
    },
    list_tabs() {
      return { ok: true, result: [...state.tabs.values()] };
    },
    new_tab(p) {
      const id = state.nextTabId++;
      for (const t of state.tabs.values()) t.active = false;
      state.tabs.set(id, { id, url: p.url || "about:blank", title: "New Tab", active: true });
      return { ok: true, result: { tabId: id, url: p.url || "about:blank" } };
    },
    close_tab(p) {
      if (p.tabId == null) return { ok: false, code: "BAD_PARAMS", error: "close_tab requires 'tabId'" };
      if (!state.tabs.has(p.tabId)) return { ok: false, code: "TAB_NOT_FOUND", error: `no tab ${p.tabId}` };
      state.tabs.delete(p.tabId);
      return { ok: true, result: { closed: p.tabId } };
    },
    activate_tab(p) {
      if (p.tabId == null) return { ok: false, code: "BAD_PARAMS", error: "activate_tab requires 'tabId'" };
      if (!state.tabs.has(p.tabId)) return { ok: false, code: "TAB_NOT_FOUND", error: `no tab ${p.tabId}` };
      for (const t of state.tabs.values()) t.active = t.id === p.tabId;
      return { ok: true, result: { activated: p.tabId } };
    },
    click(p) {
      if (!p.selector) return { ok: false, code: "BAD_PARAMS", error: "click requires 'selector'" };
      const { err } = target(p); if (err) return err;
      if (p.selector === "#missing") return { ok: false, code: "ELEMENT_NOT_FOUND", error: "no element matches #missing" };
      return { ok: true, result: { clicked: p.selector } };
    },
    type(p) {
      if (!p.selector || p.text == null) return { ok: false, code: "BAD_PARAMS", error: "type requires 'selector' and 'text'" };
      const { err } = target(p); if (err) return err;
      if (p.selector === "#missing") return { ok: false, code: "ELEMENT_NOT_FOUND", error: "no element matches #missing" };
      return { ok: true, result: { typed: p.text, into: p.selector, submitted: !!p.submit } };
    },
    find(p) {
      if (!p.query) return { ok: false, code: "BAD_PARAMS", error: "find requires 'query'" };
      const { err } = target(p); if (err) return err;
      return { ok: true, result: [{ selector: "a#link", role: "link", text: p.query }] };
    },
    capture_start(p) {
      const { tab, err } = target(p); if (err) return err;
      state.capturing.add(tab.id);
      return { ok: true, result: { capturing: tab.id } };
    },
    read_console(p) {
      const { tab, err } = target(p); if (err) return err;
      if (!state.capturing.has(tab.id)) return { ok: false, code: "NOT_CAPTURING", error: "call capture_start first" };
      let logs = state.console;
      if (p.pattern) logs = logs.filter((l) => new RegExp(p.pattern).test(l.text));
      return { ok: true, result: logs };
    },
    read_network(p) {
      const { tab, err } = target(p); if (err) return err;
      if (!state.capturing.has(tab.id)) return { ok: false, code: "NOT_CAPTURING", error: "call capture_start first" };
      let reqs = state.network;
      if (p.pattern) reqs = reqs.filter((r) => new RegExp(r.pattern || p.pattern).test(r.url));
      return { ok: true, result: reqs };
    },
    scroll(p) {
      const { err } = target(p); if (err) return err;
      if (p.selector === "#missing") return { ok: false, code: "ELEMENT_NOT_FOUND", error: "no element matches #missing" };
      return { ok: true, result: { scrolledTo: { x: p.x || 0, y: p.y ?? 500 }, selector: p.selector || null } };
    },
    hover(p) {
      if (!p.selector) return { ok: false, code: "BAD_PARAMS", error: "hover requires 'selector'" };
      const { err } = target(p); if (err) return err;
      if (p.selector === "#missing") return { ok: false, code: "ELEMENT_NOT_FOUND", error: "no match" };
      return { ok: true, result: { hovered: p.selector } };
    },
    select(p) {
      if (!p.selector || p.value == null) return { ok: false, code: "BAD_PARAMS", error: "select requires 'selector' and 'value'" };
      const { err } = target(p); if (err) return err;
      if (p.selector === "#missing") return { ok: false, code: "ELEMENT_NOT_FOUND", error: "no match" };
      return { ok: true, result: { selected: p.value, in: p.selector } };
    },
    press_key(p) {
      if (!p.key) return { ok: false, code: "BAD_PARAMS", error: "press_key requires 'key'" };
      const { err } = target(p); if (err) return err;
      return { ok: true, result: { pressed: p.key } };
    },
    go_back(p) { const { err } = target(p); if (err) return err; return { ok: true, result: { action: "back" } }; },
    go_forward(p) { const { err } = target(p); if (err) return err; return { ok: true, result: { action: "forward" } }; },
    reload(p) { const { err } = target(p); if (err) return err; return { ok: true, result: { action: "reload" } }; },
    wait_for(p) {
      const { err } = target(p); if (err) return err;
      if (p.selector === "#never") return { ok: false, code: "WAIT_TIMEOUT", error: `timed out waiting for ${p.selector}` };
      return { ok: true, result: { waited: p.selector || p.state || "load", found: true } };
    },
    get_element(p) {
      if (!p.selector) return { ok: false, code: "BAD_PARAMS", error: "get_element requires 'selector'" };
      const { err } = target(p); if (err) return err;
      if (p.selector === "#missing") return { ok: false, code: "ELEMENT_NOT_FOUND", error: "no match" };
      return { ok: true, result: { selector: p.selector, rect: { x: 10, y: 20, width: 100, height: 40 }, text: "el text", visible: true, attributes: { id: "x" } } };
    },
    highlight(p) {
      if (!p.selector) return { ok: false, code: "BAD_PARAMS", error: "highlight requires 'selector'" };
      const { err } = target(p); if (err) return err;
      if (p.selector === "#missing") return { ok: false, code: "ELEMENT_NOT_FOUND", error: "no match" };
      return { ok: true, result: { highlighted: p.selector } };
    },
  };

  const ws = new WebSocket(URL);
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: "extension", platform: "macos" })));
  ws.on("message", (b) => {
    const m = JSON.parse(b.toString());
    if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    if (m.type !== "tool") return;
    const fn = tools[m.tool];
    const reply = fn ? fn(m.params || {}) : { ok: false, code: "UNKNOWN_TOOL", error: `unknown tool: ${m.tool}` };
    ws.send(JSON.stringify({ type: "result", id: m.id, ...reply }));
  });
  return new Promise((res) => ws.on("open", () => res(ws)));
}

// ---------------------------------------------------------------------------
// Test client
// ---------------------------------------------------------------------------
function client() {
  const ws = new WebSocket(URL);
  const waiters = new Map();
  ws.on("message", (b) => {
    const m = JSON.parse(b.toString());
    if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const call = (tool, params = {}) => new Promise((res) => {
    const id = crypto.randomUUID();
    waiters.set(id, res);
    ws.send(JSON.stringify({ type: "tool", id, tool, params }));
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ ok: false, code: "TIMEOUT", error: "test timeout" }); } }, 8000);
  });
  return new Promise((res) => ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", role: "mcp" }));
    res({ call, ws });
  }));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
const daemon = spawn(process.execPath, ["index.mjs", "serve"], {
  // CIS_SYNTH → nonexistent path keeps the computer-use tests hermetic
  // (deterministic UNAVAILABLE) and prevents firing real OS clicks during tests.
  env: { ...process.env, CIS_PORT: String(PORT), CIS_SYNTH: "/nonexistent/cissynth" },
  stdio: "ignore",
});
await sleep(700);

// --- errors before any extension connects ---
{
  const { call, ws } = await client();
  const r = await call("navigate", { url: "https://x.com" });
  check("NO_EXTENSION structured error", r.ok === false && r.code === "NO_EXTENSION", JSON.stringify(r));
  ws.close();
}

const ext = await startMockExtension();
await sleep(300);
const { call, ws: cws } = await client();

console.log("— navigation & tabs —");
{
  const r = await call("navigate", { url: "https://test.dev" });
  check("navigate ok", r.ok && r.result.url === "https://test.dev");
  const bad = await call("navigate", {});
  check("navigate BAD_PARAMS", bad.ok === false && bad.code === "BAD_PARAMS");

  const tabs = await call("list_tabs");
  check("list_tabs returns array", tabs.ok && Array.isArray(tabs.result) && tabs.result.length === 2);

  const nt = await call("new_tab", { url: "https://new.example" });
  check("new_tab ok", nt.ok && nt.result.tabId === 3);

  const act = await call("activate_tab", { tabId: 1 });
  check("activate_tab ok", act.ok && act.result.activated === 1);
  const actBad = await call("activate_tab", { tabId: 99 });
  check("activate_tab TAB_NOT_FOUND", actBad.ok === false && actBad.code === "TAB_NOT_FOUND");

  const ct = await call("close_tab", { tabId: 3 });
  check("close_tab ok", ct.ok && ct.result.closed === 3);
  const ctBad = await call("close_tab", { tabId: 3 });
  check("close_tab TAB_NOT_FOUND on re-close", ctBad.ok === false && ctBad.code === "TAB_NOT_FOUND");
}

console.log("— page_elements —");
{
  const pe = await call("page_elements", {});
  check("page_elements returns inventory", pe.ok && Array.isArray(pe.result) && pe.result[0].selector === "a#link");
  check("page_elements has type+text", pe.ok && pe.result[1].type === "button" && pe.result[1].text === "Go");
  const lim = await call("page_elements", { limit: 1 });
  check("page_elements respects limit", lim.ok && lim.result.length === 1);
}

console.log("— read_page modes —");
{
  const t = await call("read_page", {});
  check("read_page text default", t.ok && typeof t.result.text === "string" && !t.result.a11y);
  const a = await call("read_page", { mode: "a11y" });
  check("read_page a11y tree", a.ok && a.result.a11y && a.result.a11y.role === "WebArea");
  const b = await call("read_page", { mode: "both" });
  check("read_page both", b.ok && b.result.text && b.result.a11y);
  const badTab = await call("read_page", { tabId: 404 });
  check("read_page TAB_NOT_FOUND", badTab.ok === false && badTab.code === "TAB_NOT_FOUND");
}

console.log("— interaction —");
{
  const c = await call("click", { selector: "a#link" });
  check("click ok", c.ok && c.result.clicked === "a#link");
  const cm = await call("click", { selector: "#missing" });
  check("click ELEMENT_NOT_FOUND", cm.ok === false && cm.code === "ELEMENT_NOT_FOUND");
  const cb = await call("click", {});
  check("click BAD_PARAMS", cb.ok === false && cb.code === "BAD_PARAMS");

  const ty = await call("type", { selector: "input", text: "hello", submit: true });
  check("type ok + submit", ty.ok && ty.result.typed === "hello" && ty.result.submitted === true);
  const tm = await call("type", { selector: "#missing", text: "x" });
  check("type ELEMENT_NOT_FOUND", tm.ok === false && tm.code === "ELEMENT_NOT_FOUND");

  const f = await call("find", { query: "More information" });
  check("find returns matches", f.ok && f.result[0].selector === "a#link");
}

console.log("— console & network capture —");
{
  const early = await call("read_console", {});
  check("read_console NOT_CAPTURING before start", early.ok === false && early.code === "NOT_CAPTURING");
  const cs = await call("capture_start", {});
  check("capture_start ok", cs.ok);
  const logs = await call("read_console", {});
  check("read_console returns logs", logs.ok && logs.result.length === 2);
  const filtered = await call("read_console", { pattern: "boom" });
  check("read_console pattern filter", filtered.ok && filtered.result.length === 1);
  const net = await call("read_network", {});
  check("read_network returns requests", net.ok && net.result[0].status === 200);
}

console.log("— rich interaction (Phase B) —");
{
  const sc = await call("scroll", { y: 800 });
  check("scroll ok", sc.ok && sc.result.scrolledTo.y === 800);
  const scEl = await call("scroll", { selector: "#missing" });
  check("scroll ELEMENT_NOT_FOUND", scEl.ok === false && scEl.code === "ELEMENT_NOT_FOUND");

  const h = await call("hover", { selector: "a#link" });
  check("hover ok", h.ok && h.result.hovered === "a#link");
  const hb = await call("hover", {});
  check("hover BAD_PARAMS", hb.ok === false && hb.code === "BAD_PARAMS");

  const sel = await call("select", { selector: "select#country", value: "US" });
  check("select ok", sel.ok && sel.result.selected === "US");
  const selb = await call("select", { selector: "select#country" });
  check("select BAD_PARAMS", selb.ok === false && selb.code === "BAD_PARAMS");

  const pk = await call("press_key", { key: "Enter" });
  check("press_key ok", pk.ok && pk.result.pressed === "Enter");
  const pkb = await call("press_key", {});
  check("press_key BAD_PARAMS", pkb.ok === false && pkb.code === "BAD_PARAMS");

  check("go_back ok", (await call("go_back")).ok);
  check("go_forward ok", (await call("go_forward")).ok);
  check("reload ok", (await call("reload")).ok);

  const w = await call("wait_for", { selector: "#ready" });
  check("wait_for found", w.ok && w.result.found === true);
  const wt = await call("wait_for", { selector: "#never", timeout: 100 });
  check("wait_for WAIT_TIMEOUT", wt.ok === false && wt.code === "WAIT_TIMEOUT");

  const ge = await call("get_element", { selector: "a#link" });
  check("get_element rect+attrs", ge.ok && ge.result.rect.width === 100 && ge.result.visible === true);
  const geb = await call("get_element", { selector: "#missing" });
  check("get_element ELEMENT_NOT_FOUND", geb.ok === false && geb.code === "ELEMENT_NOT_FOUND");

  const hl = await call("highlight", { selector: "a#link" });
  check("highlight ok", hl.ok && hl.result.highlighted === "a#link");
}

console.log("— screenshot & unknown —");
{
  const s = await call("screenshot", {});
  check("screenshot dataUrl", s.ok && s.result.dataUrl.startsWith("data:image/png"));
  const u = await call("definitely_not_a_tool", {});
  check("UNKNOWN_TOOL", u.ok === false && u.code === "UNKNOWN_TOOL");
}

console.log("— daemon-side: capabilities —");
{
  const cap = await call("capabilities", {});
  check("capabilities ok", cap.ok === true, JSON.stringify(cap));
  check("capabilities reports extension", cap.ok && cap.result.extensionConnected === true);
  check("capabilities reports computer status", cap.ok && typeof cap.result.computer === "object");
}

console.log("— daemon-side: computer-use (graceful degradation) —");
{
  // The CGEvent helper is not built in the test env → UNAVAILABLE, never a crash.
  const c = await call("computer_click", { x: 100, y: 200 });
  check("computer_click structured (no crash)", c.ok === false && ["UNAVAILABLE", "NEEDS_ACCESSIBILITY"].includes(c.code), JSON.stringify(c));
  const cb = await call("computer_click", { x: "nope" });
  check("computer_click BAD_PARAMS", cb.ok === false && cb.code === "BAD_PARAMS");
  const t = await call("computer_type", { text: "hi" });
  check("computer_type structured", t.ok === false && ["UNAVAILABLE", "NEEDS_ACCESSIBILITY"].includes(t.code));
  const k = await call("computer_key", {});
  check("computer_key BAD_PARAMS", k.ok === false && k.code === "BAD_PARAMS");
}

console.log(`\n${passed} passed, ${failed} failed`);
ext.close(); cws.close(); daemon.kill();
process.exit(failed ? 1 : 0);
