// Real end-to-end tests: serve a local fixture site and drive the REAL Safari
// extension against it via the production daemon, asserting actual DOM outcomes.
// Run with Safari open + extension enabled.  node verify-fixture.mjs
import http from "node:http";
import { WebSocket } from "ws";
import crypto from "node:crypto";

const FIXTURE_PORT = 8790;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE1 = `<!doctype html><html><head><meta charset=utf-8><title>Fixture Home</title></head><body>
<h1 id=h>Fixture Home</h1>
<button id=go>Click Me</button><div id=out>idle</div>
<input id=inp placeholder=name><button id=sub>Submit</button><div id=out2></div>
<select id=sel><option value=a>Apple</option><option value=b>Banana</option></select><div id=out3></div>
<div style="height:2000px"></div>
<div id=bottom>BOTTOM_MARKER</div>
<button id=logbtn>log+fetch</button>
<a id=nav href="/page2">Go to page 2</a>
<script>
 go.onclick=()=>out.textContent='CLICKED_OK';
 sub.onclick=()=>out2.textContent='SUBMITTED:'+inp.value;
 sel.onchange=()=>out3.textContent='SEL:'+sel.value;
 logbtn.onclick=()=>{console.log('FIXTURE_LOG_123');fetch('/api/ping').catch(()=>{});};
 setTimeout(()=>{const d=document.createElement('div');d.id='late';d.textContent='LATE_ELEMENT';document.body.appendChild(d);},1300);
</script></body></html>`;
const PAGE2 = `<!doctype html><html><head><title>Page Two</title></head><body><h1>Fixture Page Two</h1><div>PAGE2_MARKER</div></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/" ) { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE1); }
  else if (req.url === "/page2") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE2); }
  else if (req.url === "/api/ping") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }
  else { res.writeHead(404); res.end("nope"); }
});
await new Promise((r) => server.listen(FIXTURE_PORT, "127.0.0.1", r));

const ws = new WebSocket("ws://127.0.0.1:8787");
const waiters = new Map();
const call = (tool, params = {}) => new Promise((res) => {
  const id = crypto.randomUUID(); waiters.set(id, res);
  ws.send(JSON.stringify({ type: "tool", id, tool, params }));
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ ok: false, code: "TIMEOUT" }); } }, 40000);
});
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } });

let pass = 0, fail = 0;
const chk = (n, c, d = "") => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${d}`); } };
const readText = async () => { const r = await call("read_page", { mode: "text" }); return r.ok ? r.result.text : ""; };

await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", role: "mcp" }));
await sleep(300);

// Wait for extension.
let up = false;
for (let i = 0; i < 15; i++) { const c = await call("capabilities"); if (c.ok && c.result.extensionConnected) { up = true; break; } await sleep(2000); }
if (!up) { console.log("SKIPPED: extension offline — open Safari to a normal page.\n0 passed, 0 failed"); server.close(); process.exit(2); }

console.log("— real fixture E2E —");
const nav = await call("navigate", { url: BASE + "/" });
chk("navigate to fixture", nav.ok && /Fixture Home/.test(await readText()), nav.ok ? "" : JSON.stringify(nav));

// click → DOM change
const c1 = await call("click", { selector: "#go" });
await sleep(300);
chk("click #go changes DOM to CLICKED_OK", c1.ok && /CLICKED_OK/.test(await readText()));

// type + click submit
const ty = await call("type", { selector: "#inp", text: "hello123" });
const cs = await call("click", { selector: "#sub" });
await sleep(300);
chk("type + submit reflects value", ty.ok && cs.ok && /SUBMITTED:hello123/.test(await readText()));

// select dropdown
const sel = await call("select", { selector: "#sel", value: "b" });
await sleep(200);
chk("select dropdown → onchange fires", sel.ok && /SEL:b/.test(await readText()), JSON.stringify(sel).slice(0,80));

// scroll + get_element
const scr = await call("scroll", { selector: "#bottom" });
const geB = await call("get_element", { selector: "#bottom" });
chk("scroll to + inspect #bottom", scr.ok && geB.ok && geB.result.text.includes("BOTTOM_MARKER"));

// wait_for late-rendered element (SPA retry path)
const wf = await call("wait_for", { selector: "#late", timeout: 4000 });
chk("wait_for late element (1.3s delayed)", wf.ok && wf.result.found);
const geLate = await call("get_element", { selector: "#late" });
chk("late element has expected text", geLate.ok && geLate.result.text.includes("LATE_ELEMENT"));

// REAL console + network capture (content, not just mechanical)
const cap = await call("capture_start");
await call("click", { selector: "#logbtn" });
await sleep(600);
const cons = await call("read_console", { pattern: "FIXTURE_LOG_123" });
chk("console capture caught real log", cons.ok && cons.result.some((e) => (e.text || "").includes("FIXTURE_LOG_123")), JSON.stringify(cons).slice(0, 120));
const net = await call("read_network", { pattern: "/api/ping" });
chk("network capture caught real fetch", net.ok && net.result.some((r) => (r.url || "").includes("/api/ping")), JSON.stringify(net).slice(0, 120));

// click link → navigation settle
const navClick = await call("click", { selector: "#nav" });
await sleep(500);
chk("click link reports navigated", navClick.ok && navClick.result.navigated === true, JSON.stringify(navClick).slice(0, 100));
chk("landed on page 2", /PAGE2_MARKER/.test(await readText()));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close(); server.close();
process.exit(fail ? 1 : 0);
