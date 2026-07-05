// Claude in Safari — background service worker.
// Transport: native messaging. WebKit blocks ws://localhost from extension JS,
// so we long-poll our native handler (SafariWebExtensionHandler), which holds
// the actual WebSocket to the local bridge daemon.

// Safari's native namespace is `browser` (promise-based). Fall back to chrome.
const api = globalThis.browser ?? globalThis.chrome;

let polling = false;
let pollGeneration = 0;

// Status + diagnostics land in storage so the popup can show exactly what's
// happening (or failing) inside this worker.
async function setStatus(state, detail) {
  try { await api.storage.local.set({ status: { state, detail, at: Date.now() } }); } catch {}
}
async function setDiag(patch) {
  try {
    const got = await api.storage.local.get("diag");
    await api.storage.local.set({ diag: { ...((got && got.diag) || {}), ...patch } });
  } catch {}
}

function native(msg) {
  // Safari ignores the application id argument; pass a placeholder for the
  // two-arg signature compatibility.
  return api.runtime.sendNativeMessage("bridge", msg);
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  const generation = ++pollGeneration;
  await setStatus("connecting", "native bridge");
  let failures = 0;

  while (generation === pollGeneration) {
    try {
      const msg = await native({ cmd: "poll" });
      failures = 0;
      await setStatus("connected", "via native bridge");
      await setDiag({ lastPollAt: Date.now(), lastError: null });

      if (msg && msg.type === "tool") {
        const reply = await Promise.race([
          runTool(msg.tool, msg.params || {}),
          new Promise((r) => setTimeout(() => r({ ok: false, code: "TIMEOUT", error: `${msg.tool} exceeded 40s` }), 40000)),
        ]);
        await native({ cmd: "result", id: msg.id, ...reply });
        await setDiag({ lastToolAt: Date.now(), lastTool: msg.tool });
      } else if (msg && (msg.type === "chat.delta" || msg.type === "chat.done" || msg.type === "approval.request")) {
        // Route chat + approval events to the tab hosting the sidebar.
        if (sidebarTabId != null) {
          try { await api.tabs.sendMessage(sidebarTabId, msg); } catch {}
        }
      }
      // {type:"none"} → poll window elapsed with no work; loop immediately.
    } catch (e) {
      failures += 1;
      await setStatus("disconnected", "native bridge error");
      await setDiag({ lastError: String(e && e.message ? e.message : e), failures });
      await new Promise((r) => setTimeout(r, Math.min(3000 * failures, 15000)));
    }
  }
  polling = false;
}

// The tab whose page hosts the injected sidebar (last one to send chat).
let sidebarTabId = null;
let pendingNewSession = false;

// Wake triggers: install, browser startup, popup open, tab activity, alarms.
api.runtime.onInstalled.addListener(() => { setDiag({ event: "installed" }); pollLoop(); });
api.runtime.onStartup.addListener(() => { setDiag({ event: "startup" }); pollLoop(); });
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "get.capabilities") {
    native({ cmd: "capabilities" })
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, code: "NO_BRIDGE", error: String(e && e.message ? e.message : e) }));
    return true; // async response
  }
  if (msg.type === "wake" || msg.type === "reconnect") pollLoop();
  if (msg.type === "chat.reset") pendingNewSession = true;
  if (msg.type === "chat.stop") { native({ cmd: "chatstop" }).catch(() => {}); return false; }
  if (msg.type === "chat.setmode") { native({ cmd: "setmode", mode: msg.mode }).catch(() => {}); return false; }
  if (msg.type === "search.setkey") { native({ cmd: "setserpkey", key: msg.key }).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) })); return true; }
  if (msg.type === "search.clearkey") { native({ cmd: "clearserpkey" }).then((r) => sendResponse(r)).catch(() => sendResponse({ ok: false })); return true; }
  if (msg.type === "brain.setkey") { native({ cmd: "setanthropickey", key: msg.key }).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) })); return true; }
  if (msg.type === "brain.clearkey") { native({ cmd: "clearanthropickey" }).then((r) => sendResponse(r)).catch(() => sendResponse({ ok: false })); return true; }
  if (msg.type === "brain.setmode") { native({ cmd: "setbrain", brain: msg.brain }).catch(() => {}); return false; }
  if (msg.type === "chat.approval") { native({ cmd: "approval", id: msg.id, decision: msg.decision }).catch(() => {}); return false; }
  if (msg.type === "chat.send") {
    if (sender && sender.tab) sidebarTabId = sender.tab.id;
    const newSession = pendingNewSession || !!msg.newSession;
    pendingNewSession = false;
    native({ cmd: "chat", id: crypto.randomUUID(), text: msg.text, newSession, model: msg.model })
      .catch(async (e) => {
        if (sidebarTabId != null) {
          try {
            await api.tabs.sendMessage(sidebarTabId, {
              type: "chat.done",
              error: "bridge unreachable: " + String(e && e.message ? e.message : e),
            });
          } catch {}
        }
      });
    pollLoop();
  }
  return false;
});
api.tabs.onActivated.addListener(() => pollLoop());
api.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") pollLoop(); });

try {
  api.alarms.create("keepalive", { periodInMinutes: 0.5 });
  api.alarms.onAlarm.addListener(() => pollLoop());
} catch (e) {
  setDiag({ lastError: `alarms: ${e && e.message ? e.message : e}` });
}

// ---- Tool implementations ----
//
// Every tool returns { ok:true, result } or { ok:false, code, error }.
// Error codes match the contract in bridge/test-tools.mjs:
//   BAD_PARAMS · TAB_NOT_FOUND · ELEMENT_NOT_FOUND · NOT_CAPTURING · INTERNAL

const err = (code, message) => ({ ok: false, code, error: message });

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || !tabs[0]) {
    const any = await api.tabs.query({ active: true });
    if (any && any[0]) return any[0];
    throw { code: "TAB_NOT_FOUND", message: "no active tab" };
  }
  return tabs[0];
}

// Resolve the target tab. Throws {code,message} for a clean structured error.
async function resolveTab(params) {
  if (params.tabId != null) {
    try { return await api.tabs.get(params.tabId); }
    catch { throw { code: "TAB_NOT_FOUND", message: `no tab ${params.tabId}` }; }
  }
  return activeTab();
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = () => { api.tabs.onUpdated.removeListener(listener); clearTimeout(t); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, timeoutMs);
    api.tabs.onUpdated.addListener(listener);
  });
}

// After an action that may navigate: if the tab starts loading within a short
// window, wait for it to finish. Returns whether a navigation occurred. Keeps
// click/submit results accurate without blocking when nothing navigates.
function settleAfterAction(tabId, beforeUrl, sniffMs = 700, loadMs = 15000) {
  return new Promise((resolve) => {
    let navigated = false;
    const onUpdate = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") navigated = true;
      if (info.status === "complete" && navigated) finish();
    };
    const finish = async () => {
      api.tabs.onUpdated.removeListener(onUpdate); clearTimeout(sniff); clearTimeout(hard);
      // Also catch fast local navigations that completed before our listener
      // attached: compare the URL.
      if (!navigated && beforeUrl != null) {
        try { const t = await api.tabs.get(tabId); if (t && t.url && t.url !== beforeUrl) navigated = true; } catch {}
      }
      resolve(navigated);
    };
    api.tabs.onUpdated.addListener(onUpdate);
    const sniff = setTimeout(() => { if (!navigated) finish(); }, sniffMs);
    const hard = setTimeout(finish, loadMs);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Capture an entire page by scrolling through it and stitching the segments
// into one tall PNG (OffscreenCanvas). Falls back to returning the segment
// images if canvas/bitmap APIs aren't available in Safari's worker.
async function fullPageScreenshot(tab) {
  const m = await inPage(tab.id, () => ({
    sh: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    ih: window.innerHeight, iw: window.innerWidth, dpr: window.devicePixelRatio || 1, sy: window.scrollY,
  }));
  const MAX = 12;
  const count = Math.max(1, Math.min(Math.ceil(m.sh / m.ih), MAX));
  const segments = [];
  for (let i = 0; i < count; i++) {
    const y = i * m.ih;
    await inPage(tab.id, (yy) => window.scrollTo(0, yy), [y]);
    await sleep(360); // paint + honor captureVisibleTab rate limits
    try { segments.push({ y, dataUrl: await api.tabs.captureVisibleTab(tab.windowId, { format: "png" }) }); }
    catch { await sleep(700); segments.push({ y, dataUrl: await api.tabs.captureVisibleTab(tab.windowId, { format: "png" }) }); }
  }
  await inPage(tab.id, (yy) => window.scrollTo(0, yy), [m.sy]); // restore

  try {
    const W = Math.round(m.iw * m.dpr);
    const H = Math.round(Math.min(m.sh, count * m.ih) * m.dpr);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d");
    for (const seg of segments) {
      const bmp = await createImageBitmap(await (await fetch(seg.dataUrl)).blob());
      ctx.drawImage(bmp, 0, Math.round(seg.y * m.dpr));
      bmp.close && bmp.close();
    }
    const buf = await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { ok: true, result: { tabId: tab.id, dataUrl: "data:image/png;base64," + btoa(bin), fullPage: true, segments: count } };
  } catch (e) {
    // Canvas unavailable → hand back the individual segment images.
    return { ok: true, result: { tabId: tab.id, images: segments.map((s) => s.dataUrl), fullPage: false, segments: count, note: "stitching unavailable: " + (e && e.message ? e.message : e) } };
  }
}

// Run a function in the page and return its result, mapping injection failures
// to structured errors.
async function inPage(tabId, func, args = [], world) {
  const opts = { target: { tabId }, func, args };
  if (world) opts.world = world;
  const injected = await api.scripting.executeScript(opts);
  return injected && injected[0] ? injected[0].result : null;
}

async function runTool(tool, params) {
  try {
    switch (tool) {
      // ---- navigation & tabs ----
      case "navigate": {
        if (!params.url) return err("BAD_PARAMS", "navigate requires 'url'");
        let tab = await resolveTab(params);
        await api.tabs.update(tab.id, { url: params.url });
        await waitForLoad(tab.id);
        tab = await api.tabs.get(tab.id);
        return { ok: true, result: { tabId: tab.id, url: tab.url, title: tab.title } };
      }
      case "list_tabs": {
        const tabs = await api.tabs.query({});
        return { ok: true, result: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })) };
      }
      case "window_metrics": {
        const tab = await resolveTab(params);
        const m = await inPage(tab.id, () => ({
          screenX: window.screenX, screenY: window.screenY,
          innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          outerWidth: window.outerWidth, outerHeight: window.outerHeight,
          dpr: window.devicePixelRatio || 1,
        }));
        return { ok: true, result: m };
      }
      case "new_tab": {
        const tab = await api.tabs.create({ url: params.url || undefined, active: params.active !== false });
        return { ok: true, result: { tabId: tab.id, url: tab.url } };
      }
      case "close_tab": {
        if (params.tabId == null) return err("BAD_PARAMS", "close_tab requires 'tabId'");
        try { await api.tabs.get(params.tabId); }
        catch { return err("TAB_NOT_FOUND", `no tab ${params.tabId}`); }
        await api.tabs.remove(params.tabId);
        return { ok: true, result: { closed: params.tabId } };
      }
      case "activate_tab": {
        if (params.tabId == null) return err("BAD_PARAMS", "activate_tab requires 'tabId'");
        try { await api.tabs.get(params.tabId); }
        catch { return err("TAB_NOT_FOUND", `no tab ${params.tabId}`); }
        await api.tabs.update(params.tabId, { active: true });
        return { ok: true, result: { activated: params.tabId } };
      }

      // ---- reading ----
      case "read_page": {
        const tab = await resolveTab(params);
        const mode = params.mode || "text";
        const result = await inPage(tab.id, readPageFn, [mode]);
        return { ok: true, result };
      }
      case "screenshot": {
        const tab = await resolveTab(params);
        if (params.fullPage) return await fullPageScreenshot(tab);
        const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return { ok: true, result: { tabId: tab.id, dataUrl } };
      }
      case "page_elements": {
        const tab = await resolveTab(params);
        const els = await inPage(tab.id, pageElementsFn, [params.limit || 60, !!params.visibleOnly]);
        return { ok: true, result: els };
      }

      // ---- interaction (selector-based) ----
      case "click": {
        if (!params.selector) return err("BAD_PARAMS", "click requires 'selector'");
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, clickFn, [params.selector, params.timeout ?? 2500]);
        if (!r.found) return err("ELEMENT_NOT_FOUND", `no element matches ${params.selector}`);
        const nav = await settleAfterAction(tab.id, tab.url);
        return { ok: true, result: { clicked: params.selector, navigated: nav } };
      }
      case "type": {
        if (!params.selector || params.text == null) return err("BAD_PARAMS", "type requires 'selector' and 'text'");
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, typeFn, [params.selector, String(params.text), !!params.submit, params.timeout ?? 2500]);
        if (!r.found) return err("ELEMENT_NOT_FOUND", `no element matches ${params.selector}`);
        const nav = params.submit ? await settleAfterAction(tab.id, tab.url) : false;
        return { ok: true, result: { typed: params.text, into: params.selector, submitted: !!params.submit, navigated: nav } };
      }
      case "find": {
        if (!params.query) return err("BAD_PARAMS", "find requires 'query'");
        const tab = await resolveTab(params);
        const matches = await inPage(tab.id, findFn, [String(params.query), params.limit || 10]);
        return { ok: true, result: matches };
      }

      // ---- rich interaction ----
      case "scroll": {
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, scrollFn, [params.selector || null, params.x ?? null, params.y ?? null, params.direction || null, params.amount ?? null]);
        if (r && r.notFound) return err("ELEMENT_NOT_FOUND", `no element matches ${params.selector}`);
        return { ok: true, result: r };
      }
      case "hover": {
        if (!params.selector) return err("BAD_PARAMS", "hover requires 'selector'");
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, hoverFn, [params.selector, params.timeout ?? 2500]);
        return r.found ? { ok: true, result: { hovered: params.selector } } : err("ELEMENT_NOT_FOUND", `no element matches ${params.selector}`);
      }
      case "select": {
        if (!params.selector || params.value == null) return err("BAD_PARAMS", "select requires 'selector' and 'value'");
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, selectFn, [params.selector, String(params.value)]);
        if (r.notFound) return err("ELEMENT_NOT_FOUND", `no element matches ${params.selector}`);
        if (r.noOption) return err("OPTION_NOT_FOUND", `no option '${params.value}' in ${params.selector}`);
        return { ok: true, result: { selected: r.value, in: params.selector } };
      }
      case "press_key": {
        if (!params.key) return err("BAD_PARAMS", "press_key requires 'key'");
        const tab = await resolveTab(params);
        await inPage(tab.id, pressKeyFn, [String(params.key), params.selector || null]);
        return { ok: true, result: { pressed: params.key } };
      }
      case "go_back": {
        const tab = await resolveTab(params);
        await inPage(tab.id, () => history.back());
        return { ok: true, result: { action: "back" } };
      }
      case "go_forward": {
        const tab = await resolveTab(params);
        await inPage(tab.id, () => history.forward());
        return { ok: true, result: { action: "forward" } };
      }
      case "reload": {
        const tab = await resolveTab(params);
        await api.tabs.reload(tab.id);
        return { ok: true, result: { action: "reload" } };
      }
      case "wait_for": {
        const tab = await resolveTab(params);
        const timeout = Math.min(params.timeout || 10000, 30000);
        if (params.state === "navigation") { await waitForLoad(tab.id, timeout); return { ok: true, result: { waited: "navigation", found: true } }; }
        const r = await inPage(tab.id, waitForFn, [params.selector || null, timeout]);
        return r.found ? { ok: true, result: { waited: params.selector || "load", found: true } } : err("WAIT_TIMEOUT", `timed out waiting for ${params.selector || "condition"}`);
      }
      case "get_element": {
        if (!params.selector) return err("BAD_PARAMS", "get_element requires 'selector'");
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, getElementFn, [params.selector]);
        return r ? { ok: true, result: r } : err("ELEMENT_NOT_FOUND", `no element matches ${params.selector}`);
      }
      case "highlight": {
        if (!params.selector) return err("BAD_PARAMS", "highlight requires 'selector'");
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, highlightFn, [params.selector, params.ms || 1500]);
        return r.found ? { ok: true, result: { highlighted: params.selector } } : err("ELEMENT_NOT_FOUND", `no element matches ${params.selector}`);
      }

      // ---- console & network capture ----
      case "capture_start": {
        const tab = await resolveTab(params);
        await inPage(tab.id, installCaptureFn, [], "MAIN");
        return { ok: true, result: { capturing: tab.id } };
      }
      case "read_console": {
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, readCaptureFn, ["console", params.pattern || null], "MAIN");
        if (!r.capturing) return err("NOT_CAPTURING", "call capture_start first (before the events you want)");
        return { ok: true, result: r.entries };
      }
      case "read_network": {
        const tab = await resolveTab(params);
        const r = await inPage(tab.id, readCaptureFn, ["network", params.pattern || null], "MAIN");
        if (!r.capturing) return err("NOT_CAPTURING", "call capture_start first (before the requests you want)");
        return { ok: true, result: r.entries };
      }

      default:
        return err("UNKNOWN_TOOL", `unknown tool: ${tool}`);
    }
  } catch (e) {
    if (e && e.code) return err(e.code, e.message);
    const m = String(e && e.message ? e.message : e);
    // Tab closed / navigated away mid-action → clean structured error.
    if (/no tab|tab.*not|frame|no longer|closed|inspected page|missing host/i.test(m)) return err("TAB_NOT_FOUND", "target tab is gone or navigated mid-action: " + m);
    return err("INTERNAL", m);
  }
}

// ---- injected page functions (serialized into the tab; no closure capture) ----

function readPageFn(mode) {
  const out = { url: location.href, title: document.title };
  if (mode === "text" || mode === "both") {
    out.text = (document.body ? document.body.innerText : "").slice(0, 40000);
  }
  if (mode === "a11y" || mode === "both") {
    const roleOf = (el) => {
      const r = el.getAttribute("role");
      if (r) return r;
      const t = el.tagName.toLowerCase();
      const map = { a: "link", button: "button", input: "textbox", textarea: "textbox",
        select: "combobox", nav: "navigation", main: "main", header: "banner",
        footer: "contentinfo", h1: "heading", h2: "heading", h3: "heading",
        h4: "heading", h5: "heading", h6: "heading", img: "image", ul: "list",
        ol: "list", li: "listitem", form: "form", table: "table" };
      return map[t] || null;
    };
    const nameOf = (el) => (
      el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      (el.tagName === "INPUT" ? (el.getAttribute("placeholder") || el.value || "") : "") ||
      (el.innerText || "").trim().slice(0, 120)
    );
    let nodes = 0;
    const MAX = 400;
    const walk = (el) => {
      if (nodes >= MAX || !el) return null;
      const role = roleOf(el);
      const interesting = role && role !== null;
      let node = null;
      if (interesting) {
        nodes++;
        node = { role, name: nameOf(el) };
        if (/^h[1-6]$/i.test(el.tagName)) node.level = Number(el.tagName[1]);
        const kids = [];
        for (const c of el.children) { const k = walk(c); if (k) kids.push(k); }
        if (kids.length) node.children = kids;
      } else {
        const kids = [];
        for (const c of el.children) { const k = walk(c); if (k) kids.push(k); }
        if (kids.length === 1) return kids[0];
        if (kids.length) return { role: "group", children: kids };
      }
      return node;
    };
    out.a11y = { role: "WebArea", name: document.title, children: (() => {
      const kids = [];
      for (const c of (document.body ? document.body.children : [])) { const k = walk(c); if (k) kids.push(k); }
      return kids;
    })() };
  }
  return out;
}

// NOTE: each *Fn below is serialized standalone into the page by
// executeScript, so it CANNOT reference any other function here. The
// element-poll loop is therefore inlined in each (tolerates late SPA renders).

async function clickFn(selector, timeout) {
  const deadline = Date.now() + (timeout || 2500);
  let el = document.querySelector(selector);
  while (!el && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); el = document.querySelector(selector); }
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center" });
  const rect = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  if (typeof el.click === "function") el.click();
  return { found: true };
}

async function typeFn(selector, text, submit, timeout) {
  const deadline = Date.now() + (timeout || 2500);
  let el = document.querySelector(selector);
  while (!el && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); el = document.querySelector(selector); }
  if (!el) return { found: false };
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value");
  if (setter && setter.set && ("value" in el)) setter.set.call(el, text);
  else if ("value" in el) el.value = text;
  else el.textContent = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
    if (el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit();
    else if (el.form) el.form.submit();
  }
  return { found: true };
}

function findFn(query, limit) {
  const q = query.toLowerCase();
  const cssPath = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const roleOf = (el) => el.getAttribute("role") ||
    ({ A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "combobox", TEXTAREA: "textbox" }[el.tagName] || el.tagName.toLowerCase());
  const out = [];
  const candidates = document.querySelectorAll("a,button,input,textarea,select,[role],[onclick],summary,label");
  for (const el of candidates) {
    const text = ((el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "") + "").trim();
    if (text.toLowerCase().includes(q)) {
      out.push({ selector: cssPath(el), role: roleOf(el), text: text.slice(0, 120) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Inventory of actionable elements with ready-to-use selectors — lets the agent
// act without guessing. Standalone (serialized into the page).
function pageElementsFn(limit, visibleOnly) {
  const cssPath = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) { const sibs = [...parent.children].filter((c) => c.tagName === node.tagName); if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`; }
      parts.unshift(sel); node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const typeOf = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "button" || el.getAttribute("role") === "button") return "button";
    if (t === "select") return "select";
    if (t === "textarea") return "textarea";
    if (t === "input") return `input:${el.type || "text"}`;
    return el.getAttribute("role") || t;
  };
  const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.value && el.type !== "password" ? el.value : "") || (el.innerText || "").trim() || el.getAttribute("title") || el.getAttribute("name") || "").trim().slice(0, 80);
  const out = [];
  const seen = new Set();
  const nodes = document.querySelectorAll("a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],summary,label[for]");
  for (const el of nodes) {
    if (out.length >= limit) break;
    const r = el.getBoundingClientRect();
    const vis = r.width > 0 && r.height > 0;
    if (visibleOnly && !vis) continue;
    const sel = cssPath(el);
    if (seen.has(sel)) continue; seen.add(sel);
    out.push({ selector: sel, type: typeOf(el), text: label(el), inViewport: r.top >= 0 && r.top < innerHeight });
  }
  return out;
}

function scrollFn(selector, x, y, direction, amount) {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { notFound: true };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return { scrolledTo: { x: window.scrollX, y: window.scrollY }, selector };
  }
  if (direction) {
    const step = amount || Math.round(window.innerHeight * 0.9);
    const dy = direction === "up" ? -step : direction === "down" ? step : 0;
    const dx = direction === "left" ? -step : direction === "right" ? step : 0;
    window.scrollBy(dx, dy);
    return { scrolledTo: { x: window.scrollX, y: window.scrollY } };
  }
  window.scrollTo(x ?? window.scrollX, y ?? window.scrollY);
  return { scrolledTo: { x: window.scrollX, y: window.scrollY } };
}

async function hoverFn(selector, timeout) {
  const deadline = Date.now() + (timeout || 2500);
  let el = document.querySelector(selector);
  while (!el && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 100)); el = document.querySelector(selector); }
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mouseenter", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  return { found: true };
}

function selectFn(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { notFound: true };
  if (el.tagName !== "SELECT") {
    // Fallback: set value directly for custom inputs.
    el.value = value; el.dispatchEvent(new Event("change", { bubbles: true }));
    return { value };
  }
  let matched = null;
  for (const opt of el.options) {
    if (opt.value === value || opt.text === value || opt.text.trim() === value.trim()) { matched = opt; break; }
  }
  if (!matched) return { noOption: true };
  el.value = matched.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { value: matched.value };
}

function pressKeyFn(key, selector) {
  const el = selector ? document.querySelector(selector) : (document.activeElement || document.body);
  if (!el) return { found: false };
  if (selector) el.focus();
  const keyMap = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32 };
  const keyCode = keyMap[key] || key.charCodeAt(0);
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key, keyCode, which: keyCode }));
  }
  return { found: true };
}

function waitForFn(selector, timeout) {
  return new Promise((resolve) => {
    if (!selector) { resolve({ found: true }); return; }
    if (document.querySelector(selector)) { resolve({ found: true }); return; }
    const obs = new MutationObserver(() => {
      if (document.querySelector(selector)) { obs.disconnect(); clearTimeout(t); resolve({ found: true }); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const t = setTimeout(() => { obs.disconnect(); resolve({ found: false }); }, timeout);
  });
}

function getElementFn(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const attrs = {};
  for (const a of el.attributes) attrs[a.name] = a.value;
  const style = getComputedStyle(el);
  return {
    selector,
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    text: (el.innerText || el.value || "").trim().slice(0, 200),
    tag: el.tagName.toLowerCase(),
    visible: r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none",
    attributes: attrs,
  };
}

function highlightFn(selector, ms) {
  const el = document.querySelector(selector);
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #d97757;border-radius:4px;background:rgba(217,119,87,.15);z-index:2147483646;pointer-events:none;box-shadow:0 0 0 2px rgba(217,119,87,.4);transition:opacity .3s;`;
  document.documentElement.appendChild(box);
  setTimeout(() => { box.style.opacity = "0"; setTimeout(() => box.remove(), 300); }, ms);
  return { found: true };
}

// Installed into the page MAIN world; overrides console.* and wraps fetch/XHR.
// Only captures events that occur AFTER installation (documented limitation —
// Safari has no chrome.debugger to retroactively read the log).
function installCaptureFn() {
  if (window.__cisCapture) return;
  const store = { console: [], network: [] };
  window.__cisCapture = store;
  const cap = 500;
  const push = (arr, item) => { arr.push(item); if (arr.length > cap) arr.shift(); };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level] ? console[level].bind(console) : null;
    console[level] = (...args) => {
      try {
        push(store.console, { level, text: args.map((a) => {
          try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); }
        }).join(" ").slice(0, 2000), at: Date.now() });
      } catch {}
      if (orig) orig(...args);
    };
  }
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async (...args) => {
      const url = (args[0] && args[0].url) || String(args[0]);
      const method = (args[1] && args[1].method) || "GET";
      try {
        const res = await origFetch(...args);
        push(store.network, { method, url: String(url).slice(0, 500), status: res.status, at: Date.now() });
        return res;
      } catch (e) {
        push(store.network, { method, url: String(url).slice(0, 500), status: 0, error: String(e), at: Date.now() });
        throw e;
      }
    };
  }
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const open = OrigXHR.prototype.open;
    const send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) { this.__cis = { method, url: String(url).slice(0, 500) }; return open.apply(this, arguments); };
    OrigXHR.prototype.send = function () {
      this.addEventListener("loadend", () => {
        if (this.__cis) push(store.network, { ...this.__cis, status: this.status, at: Date.now() });
      });
      return send.apply(this, arguments);
    };
  }
}

function readCaptureFn(kind, pattern) {
  const store = window.__cisCapture;
  if (!store) return { capturing: false };
  let entries = store[kind] || [];
  if (pattern) {
    const re = new RegExp(pattern, "i");
    entries = entries.filter((e) => re.test(e.text || e.url || ""));
  }
  return { capturing: true, entries };
}

setStatus("starting", "worker booted");
setDiag({ workerStartedAt: Date.now() });
pollLoop();
