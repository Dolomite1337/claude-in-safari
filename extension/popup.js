const api = globalThis.browser ?? globalThis.chrome;

// Opening the popup doubles as a defibrillator: it wakes the background
// worker, which reconnects if needed.
try { api.runtime.sendMessage({ type: "wake" }).catch(() => {}); } catch {}

// Inject (or toggle) the sidebar into the active tab.
document.getElementById("openSidebar").addEventListener("click", async () => {
  const hint = document.getElementById("sidebarHint");
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("no active tab");
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["sidebar.js"] });
    window.close();
  } catch (e) {
    hint.style.display = "block";
    hint.textContent = "Can't open here — switch to a regular webpage (not a Start Page or app store) and try again.";
  }
});

async function render() {
  let status, bridgeUrl, diag;
  try {
    const got = await api.storage.local.get(["status", "bridgeUrl", "diag"]);
    status = got.status; bridgeUrl = got.bridgeUrl; diag = got.diag;
  } catch (e) {
    document.getElementById("statusText").textContent = "storage error: " + (e && e.message);
    return;
  }
  const dot = document.getElementById("dot");
  const statusText = document.getElementById("statusText");
  const on = status && status.state === "connected";
  dot.className = "dot " + (on ? "on" : "off");
  statusText.textContent = status ? `${status.state}${status.detail ? " — " + status.detail : ""}` : "worker has not run yet";
  document.getElementById("url").value = bridgeUrl || "ws://127.0.0.1:8787";

  const d = diag || {};
  const bits = [];
  if (d.attempts) bits.push(`attempts: ${d.attempts}`);
  if (d.lastError) bits.push(`error: ${d.lastError}`);
  if (d.lastClose) bits.push(`close: ${d.lastClose}`);
  document.getElementById("debug").textContent = bits.length ? bits.join(" · ") : "no diagnostics yet";
}

document.getElementById("save").addEventListener("click", async () => {
  const url = document.getElementById("url").value.trim();
  try { await api.storage.local.set({ bridgeUrl: url }); } catch {}
  try { api.runtime.sendMessage({ type: "reconnect" }).catch(() => {}); } catch {}
  setTimeout(render, 500);
});

// Fetch live capabilities from the daemon (tool count + computer-use + search).
async function renderCaps() {
  const caps = document.getElementById("caps");
  const searchStatus = document.getElementById("searchStatus");
  try {
    const r = await api.runtime.sendMessage({ type: "get.capabilities" });
    if (!r || !r.ok) { caps.textContent = "bridge unreachable"; if (searchStatus) searchStatus.textContent = ""; return; }
    const c = r.result;
    const comp = c.computer && c.computer.available ? "computer-use ✓" : `computer-use: ${c.computer ? c.computer.reason : "unknown"}`;
    caps.textContent = `${c.tools.length} tools · ${comp}`;
    caps.title = c.computer && c.computer.detail ? c.computer.detail : "";
    if (searchStatus) {
      const on = c.search && c.search.configured;
      searchStatus.textContent = on ? "✓ configured — search is enabled" : "not set — paste your key to enable search";
      searchStatus.style.color = on ? "#00c853" : "#c9a06a";
    }
    // Brain mode + API key status.
    const brain = c.brain || { mode: "claude-code", apiConfigured: false };
    const brainSel = document.getElementById("brainMode");
    const apiWrap = document.getElementById("apiKeyWrap");
    const apiStatus = document.getElementById("apiStatus");
    if (brainSel) brainSel.value = brain.mode;
    if (apiWrap) apiWrap.style.display = brain.mode === "api" ? "block" : "none";
    if (apiStatus) {
      apiStatus.textContent = brain.apiConfigured ? "✓ API key configured" : "not set — paste your Anthropic key";
      apiStatus.style.color = brain.apiConfigured ? "#00c853" : "#c9a06a";
    }
  } catch {
    caps.textContent = "bridge unreachable";
  }
}

// Brain mode + Anthropic key.
document.getElementById("brainMode").addEventListener("change", async (e) => {
  await api.runtime.sendMessage({ type: "brain.setmode", brain: e.target.value });
  document.getElementById("apiKeyWrap").style.display = e.target.value === "api" ? "block" : "none";
  setTimeout(renderCaps, 300);
});
document.getElementById("apiSave").addEventListener("click", async () => {
  const input = document.getElementById("anthropickey");
  const key = input.value.trim();
  const status = document.getElementById("apiStatus");
  if (!key) { status.textContent = "paste a key first"; status.style.color = "#ff5252"; return; }
  status.textContent = "saving…"; status.style.color = "";
  try { await api.runtime.sendMessage({ type: "brain.setkey", key }); input.value = ""; setTimeout(renderCaps, 500); }
  catch { status.textContent = "save failed"; status.style.color = "#ff5252"; }
});
document.getElementById("apiClear").addEventListener("click", async () => {
  try { await api.runtime.sendMessage({ type: "brain.clearkey" }); } catch {}
  setTimeout(renderCaps, 400);
});

// SerpAPI key management.
document.getElementById("serpSave").addEventListener("click", async () => {
  const input = document.getElementById("serpkey");
  const key = input.value.trim();
  const status = document.getElementById("searchStatus");
  if (!key) { status.textContent = "paste a key first"; status.style.color = "#ff5252"; return; }
  status.textContent = "saving…"; status.style.color = "";
  try {
    await api.runtime.sendMessage({ type: "search.setkey", key });
    input.value = "";
    setTimeout(renderCaps, 500); // re-query capabilities to confirm
  } catch { status.textContent = "save failed"; status.style.color = "#ff5252"; }
});
document.getElementById("serpClear").addEventListener("click", async () => {
  try { await api.runtime.sendMessage({ type: "search.clearkey" }); } catch {}
  setTimeout(renderCaps, 400);
});

try { api.storage.onChanged.addListener(render); } catch {}
render();
renderCaps();
setInterval(render, 1500);
