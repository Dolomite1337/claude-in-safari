// Claude in Safari — injected sidebar (Claude-in-Chrome style right panel).
// Injected on demand by the popup. Talks to the background worker over runtime
// messages; the background routes chat through the native bridge → daemon →
// headless Claude Code (which drives THIS Safari via the safari_* tools).

(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const existing = document.getElementById("claude-in-safari-sidebar");
  if (existing) {
    const hidden = existing.style.display === "none";
    existing.style.display = hidden ? "block" : "none";
    return;
  }

  const host = document.createElement("div");
  host.id = "claude-in-safari-sidebar";
  host.style.cssText = "all: initial; position: fixed; top: 0; right: 0; height: 100vh; width: 384px; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .panel { height: 100vh; width: 384px; display: flex; flex-direction: column;
      background: #1a1915; color: #eee7dc; border-left: 1px solid #3a382f;
      font: 13.5px/1.55 -apple-system, system-ui, sans-serif; box-shadow: -8px 0 30px rgba(0,0,0,.35); }
    .head { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-bottom: 1px solid #2e2c25; }
    .spark { color: #d97757; font-size: 15px; }
    .title { font-weight: 600; font-size: 14px; flex: 1; }
    select.model { background: #262420; color: #eee7dc; border: 1px solid #3a382f; border-radius: 6px;
      font: inherit; font-size: 11.5px; padding: 3px 6px; }
    .hbtn { background: none; border: none; color: #8d887c; font-size: 15px; cursor: pointer; padding: 4px 7px; border-radius: 6px; }
    .hbtn:hover { background: #2e2c25; color: #eee7dc; }
    .conn { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: #2a2620; color: #b3ad9f; }
    .conn.on { color: #7fe0a8; } .conn.off { color: #ff8f8f; }
    .log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 92%; padding: 9px 12px; border-radius: 13px; word-wrap: break-word; overflow-wrap: anywhere; }
    .user { align-self: flex-end; background: #d97757; color: #fff; border-bottom-right-radius: 4px; }
    .bot { align-self: flex-start; background: #262420; border-bottom-left-radius: 4px; }
    .bot p { margin: 6px 0; } .bot p:first-child { margin-top: 0; } .bot p:last-child { margin-bottom: 0; }
    .bot code { background: #100f0c; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
    .bot pre { background: #100f0c; padding: 9px 11px; border-radius: 8px; overflow-x: auto; margin: 6px 0; }
    .bot pre code { background: none; padding: 0; }
    .bot ul, .bot ol { margin: 6px 0 6px 18px; } .bot li { margin: 2px 0; }
    .bot a { color: #e0a189; }
    .bot strong { color: #fff; }
    .tool { align-self: flex-start; display: flex; align-items: center; gap: 6px; font-size: 11.5px;
      color: #c9c3b4; background: #23211c; border: 1px solid #33312a; border-radius: 8px; padding: 5px 10px; }
    .tool .ic { font-size: 12px; }
    .err { align-self: stretch; font-size: 12px; color: #ffb4b4; background: #2a1d1d; border: 1px solid #4a2b2b; border-radius: 8px; padding: 8px 10px; }
    .approval { align-self: stretch; background: #2b2416; border: 1px solid #5a4a24; border-radius: 10px; padding: 10px 12px; }
    .approval .q { font-size: 12.5px; color: #f0d9a8; margin-bottom: 8px; }
    .approval .q b { color: #fff; }
    .approval .btns { display: flex; gap: 8px; }
    .approval button { flex: 1; border: none; border-radius: 7px; padding: 7px; font: inherit; font-size: 12px; cursor: pointer; }
    .approval .ok { background: #4a8f5e; color: #fff; }
    .approval .no { background: #3a3630; color: #eee7dc; }
    .approval.done { opacity: .55; }
    .thinking { align-self: flex-start; color: #8d887c; font-size: 12px; }
    .thinking .dots::after { content: "…"; animation: pulse 1.2s infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    .composer { padding: 11px 14px; border-top: 1px solid #2e2c25; }
    .box { display: flex; align-items: flex-end; gap: 8px; background: #262420; border: 1px solid #3a382f; border-radius: 12px; padding: 8px 10px; }
    textarea { flex: 1; background: none; border: none; outline: none; resize: none; color: #eee7dc; font: inherit; max-height: 140px; }
    textarea::placeholder { color: #7d786c; }
    .send { border: none; color: #fff; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 15px; flex: none; }
    .send.go { background: #d97757; } .send.stop { background: #b5493a; }
    .foot { text-align: center; font-size: 10px; color: #6e6a5f; padding: 7px 0 2px; }
    .moderow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    select.mode { background: #262420; color: #eee7dc; border: 1px solid #3a382f; border-radius: 7px; font: inherit; font-size: 11.5px; padding: 4px 7px; }
    .risk { font-size: 10.5px; color: #c9a06a; flex: 1; }
    .risk.safe { color: #7fae86; }
  </style>
  <div class="panel">
    <div class="head">
      <span class="spark">✳</span>
      <span class="title">Claude</span>
      <span class="conn" id="conn">…</span>
      <select class="model" id="model" title="Model">
        <option value="claude-opus-4-8">Opus 4.8</option>
        <option value="claude-sonnet-5">Sonnet 5</option>
        <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
      </select>
      <button class="hbtn" id="newchat" title="New conversation">＋</button>
      <button class="hbtn" id="close" title="Close">✕</button>
    </div>
    <div class="log" id="log"></div>
    <div class="composer">
      <div class="moderow">
        <select class="mode" id="mode" title="Safety mode">
          <option value="free">⚡ Act without asking</option>
          <option value="ask">🛡️ Ask before acting</option>
        </select>
        <span class="risk" id="risk">Claude can act on this page. Double-check its work.</span>
      </div>
      <div class="box">
        <textarea id="input" rows="1" placeholder="Tell Claude what to do in Safari…"></textarea>
        <button class="send go" id="send">↑</button>
      </div>
      <div class="foot">Runs on your Claude subscription · drives this Safari window</div>
    </div>
  </div>`;

  document.documentElement.appendChild(host);

  const logEl = shadow.getElementById("log");
  const input = shadow.getElementById("input");
  const sendBtn = shadow.getElementById("send");
  const modelSel = shadow.getElementById("model");
  const modeSel = shadow.getElementById("mode");
  const riskEl = shadow.getElementById("risk");
  const connEl = shadow.getElementById("conn");
  const STORE_KEY = "__cis_sidebar_transcript";
  let busy = false, thinking = null, currentBot = null;

  const scroll = () => { logEl.scrollTop = logEl.scrollHeight; };

  // --- tiny, safe markdown → DOM (no innerHTML from model text) ---
  function renderMarkdown(container, md) {
    const lines = md.split("\n");
    let i = 0;
    const inline = (parent, text) => {
      // Split on `code`, **bold**, [link](url); everything else is text.
      const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
        const tok = m[0];
        if (tok.startsWith("`")) { const c = document.createElement("code"); c.textContent = tok.slice(1, -1); parent.appendChild(c); }
        else if (tok.startsWith("**")) { const b = document.createElement("strong"); b.textContent = tok.slice(2, -2); parent.appendChild(b); }
        else { const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok); const a = document.createElement("a"); a.textContent = lm[1]; a.href = lm[2]; a.target = "_blank"; a.rel = "noopener"; parent.appendChild(a); }
        last = m.index + tok.length;
      }
      if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
    };
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const pre = document.createElement("pre"); const code = document.createElement("code");
        i++; const buf = [];
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        code.textContent = buf.join("\n"); pre.appendChild(code); container.appendChild(pre); i++;
      } else if (/^\s*[-*]\s+/.test(line)) {
        const ul = document.createElement("ul");
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { const li = document.createElement("li"); inline(li, lines[i].replace(/^\s*[-*]\s+/, "")); ul.appendChild(li); i++; }
        container.appendChild(ul);
      } else if (/^\s*\d+\.\s+/.test(line)) {
        const ol = document.createElement("ol");
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { const li = document.createElement("li"); inline(li, lines[i].replace(/^\s*\d+\.\s+/, "")); ol.appendChild(li); i++; }
        container.appendChild(ol);
      } else if (line.trim() === "") { i++; }
      else { const p = document.createElement("p"); inline(p, line); container.appendChild(p); i++; }
    }
  }

  const addUser = (text) => { const el = document.createElement("div"); el.className = "msg user"; el.textContent = text; logEl.appendChild(el); scroll(); save(); };
  const addBot = (text) => { const el = document.createElement("div"); el.className = "msg bot"; renderMarkdown(el, text); el.dataset.raw = text; logEl.appendChild(el); scroll(); return el; };
  const addErr = (text) => { const el = document.createElement("div"); el.className = "err"; el.textContent = text; logEl.appendChild(el); scroll(); save(); };

  // Friendly labels for tool-activity cards.
  const TOOL_LABELS = {
    navigate: ["🧭", "Navigating"], read_page: ["📄", "Reading page"], screenshot: ["📸", "Screenshot"],
    click: ["👆", "Clicking"], type: ["⌨️", "Typing"], find: ["🔎", "Finding"], scroll: ["↕️", "Scrolling"],
    hover: ["🖱️", "Hovering"], select: ["▾", "Selecting"], press_key: ["⌨️", "Key press"],
    go_back: ["◀", "Back"], go_forward: ["▶", "Forward"], reload: ["🔄", "Reloading"],
    wait_for: ["⏳", "Waiting"], get_element: ["🔬", "Inspecting"], highlight: ["✨", "Highlighting"],
    new_tab: ["➕", "New tab"], close_tab: ["✕", "Closing tab"], activate_tab: ["🗂️", "Switching tab"],
    list_tabs: ["🗂️", "Listing tabs"], capture_start: ["🎙️", "Capturing"], read_console: ["🖥️", "Reading console"],
    read_network: ["🌐", "Reading network"], computer_click: ["👆", "Click (screen)"], computer_type: ["⌨️", "Type (screen)"],
    computer_key: ["⌨️", "Key (screen)"],
  };
  const addTool = (rawName) => {
    const short = String(rawName).replace(/^mcp__claude-in-safari__safari_/, "").replace(/^mcp__[^_]+__/, "").replace(/^safari_/, "");
    const [ic, label] = TOOL_LABELS[short] || ["🔧", short];
    const el = document.createElement("div"); el.className = "tool";
    const i = document.createElement("span"); i.className = "ic"; i.textContent = ic;
    const t = document.createElement("span"); t.textContent = label;
    el.appendChild(i); el.appendChild(t); logEl.appendChild(el); scroll();
  };

  function save() {
    try { sessionStorage.setItem(STORE_KEY, logEl.innerHTML); } catch {}
  }
  function restore() {
    try { const h = sessionStorage.getItem(STORE_KEY); if (h) { logEl.innerHTML = h; scroll(); return true; } } catch {}
    return false;
  }

  function setBusy(b) {
    busy = b;
    sendBtn.textContent = b ? "■" : "↑";
    sendBtn.className = "send " + (b ? "stop" : "go");
    if (b && !thinking) { thinking = document.createElement("div"); thinking.className = "thinking"; thinking.innerHTML = 'Working<span class="dots"></span>'; logEl.appendChild(thinking); scroll(); }
    else if (!b && thinking) { thinking.remove(); thinking = null; save(); }
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = ""; input.style.height = "auto";
    addUser(text); currentBot = null; setBusy(true);
    try {
      api.runtime.sendMessage({ type: "chat.send", text, model: modelSel.value, mode: modeSel.value }).catch(() => {
        setBusy(false); addErr("Couldn't reach the extension — reload the page and reopen the sidebar.");
      });
    } catch { setBusy(false); addErr("Couldn't reach the extension — reload the page and reopen the sidebar."); }
  }

  sendBtn.addEventListener("click", () => {
    if (busy) { api.runtime.sendMessage({ type: "chat.stop" }).catch(() => {}); return; }
    send();
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
  modeSel.addEventListener("change", () => {
    const ask = modeSel.value === "ask";
    riskEl.textContent = ask ? "Claude will confirm risky actions with you first." : "Claude can act on this page. Double-check its work.";
    riskEl.className = ask ? "risk safe" : "risk";
    api.runtime.sendMessage({ type: "chat.setmode", mode: modeSel.value }).catch(() => {});
  });
  shadow.getElementById("close").addEventListener("click", () => { host.style.display = "none"; });
  shadow.getElementById("newchat").addEventListener("click", () => {
    logEl.innerHTML = ""; save(); addBot("New conversation. What should we do in Safari?");
    api.runtime.sendMessage({ type: "chat.reset" }).catch(() => {});
  });

  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "chat.delta") {
      if (msg.kind === "tool") { currentBot = null; addTool(msg.tool); }
      else if (msg.kind === "text" && msg.text) {
        if (currentBot) { currentBot.dataset.raw += "\n\n" + msg.text; currentBot.innerHTML = ""; renderMarkdown(currentBot, currentBot.dataset.raw); }
        else currentBot = addBot(msg.text);
        scroll(); save();
      }
    } else if (msg.type === "chat.done") {
      setBusy(false); currentBot = null;
      if (msg.error) addErr(msg.error);
      else if (msg.stopped) addErr("Stopped.");
      save();
    } else if (msg.type === "approval.request") {
      addApproval(msg.id, msg.summary);
    }
  });

  // Interactive per-action approval card (Ask-first mode).
  function addApproval(id, summary) {
    currentBot = null;
    const card = document.createElement("div");
    card.className = "approval";
    const q = document.createElement("div");
    q.className = "q";
    q.appendChild(document.createTextNode("Allow Claude to "));
    const b = document.createElement("b"); b.textContent = summary || "take this action"; q.appendChild(b);
    q.appendChild(document.createTextNode("?"));
    const btns = document.createElement("div"); btns.className = "btns";
    const ok = document.createElement("button"); ok.className = "ok"; ok.textContent = "Allow";
    const no = document.createElement("button"); no.className = "no"; no.textContent = "Deny";
    const decide = (decision) => {
      card.classList.add("done");
      ok.disabled = no.disabled = true;
      (decision === "approve" ? ok : no).textContent = decision === "approve" ? "Allowed ✓" : "Denied ✕";
      api.runtime.sendMessage({ type: "chat.approval", id, decision }).catch(() => {});
      save();
    };
    ok.addEventListener("click", () => decide("approve"));
    no.addEventListener("click", () => decide("deny"));
    btns.appendChild(ok); btns.appendChild(no);
    card.appendChild(q); card.appendChild(btns);
    logEl.appendChild(card); scroll(); save();
  }

  // Live connection pill.
  async function pollConn() {
    try {
      const r = await api.runtime.sendMessage({ type: "get.capabilities" });
      const on = r && r.ok && r.result.extensionConnected;
      connEl.textContent = on ? "connected" : "offline";
      connEl.className = "conn " + (on ? "on" : "off");
    } catch { connEl.textContent = "offline"; connEl.className = "conn off"; }
  }
  pollConn(); setInterval(pollConn, 4000);

  if (!restore()) addBot("Hi! I drive **this Safari window** for you. Try *“summarize this page”*, *“find the search box and search for hats”*, or *“open apple.com and tell me what's new.”*");
  input.focus();
})();
