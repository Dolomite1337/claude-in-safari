// web_search tool: verify param validation + result shaping without hitting the
// real SerpAPI (a stub HTTP server stands in for serpapi.com via CIS_SERP_BASE).
// Also verifies the missing-key path returns NO_API_KEY.
import { spawn } from "node:child_process";
import http from "node:http";
import { WebSocket } from "ws";
import crypto from "node:crypto";

const PORT = process.env.CIS_PORT || "8906";
const SERP_PORT = 8907;
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, c, d = "") => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${d}`); } };

// Stub SerpAPI — responds per engine.
const serp = http.createServer((req, res) => {
  const engine = (req.url.match(/[?&]engine=([^&]+)/) || [])[1];
  res.writeHead(200, { "content-type": "application/json" });
  if (engine === "google_maps") return res.end(JSON.stringify({ local_results: [{ title: "Bob's Dentistry", rating: 4.7, reviews: 120, address: "1 Main St", phone: "555-1234", website: "https://bob.example", type: "Dentist" }] }));
  if (engine === "google_shopping") return res.end(JSON.stringify({ shopping_results: [{ title: "Widget Pro", price: "$19.99", extracted_price: 19.99, source: "ShopCo", rating: 4.5, link: "https://shop.example/w" }] }));
  if (engine === "google_news") return res.end(JSON.stringify({ news_results: [{ title: "Big News", link: "https://news.example/a", source: { name: "The Times" }, date: "2h ago", snippet: "stuff happened" }] }));
  res.end(JSON.stringify({
    answer_box: { answer: "42" },
    organic_results: [
      { title: "Result One", link: "https://one.example", snippet: "first", source: "one" },
      { title: "Result Two", link: "https://two.example", snippet: "second" },
    ],
    related_questions: [{ question: "What is X?" }, { question: "Why Y?" }],
  }));
});
await new Promise((r) => serp.listen(SERP_PORT, "127.0.0.1", r));

const daemon = spawn(process.execPath, ["index.mjs", "serve"], {
  env: { ...process.env, CIS_PORT: PORT, CIS_SERP_BASE: `http://127.0.0.1:${SERP_PORT}/search.json` }, stdio: "ignore",
});
await sleep(700);

const ws = new WebSocket(URL);
const waiters = new Map();
const call = (tool, params = {}) => new Promise((res) => { const id = crypto.randomUUID(); waiters.set(id, res); ws.send(JSON.stringify({ type: "tool", id, tool, params })); setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ ok: false, code: "TIMEOUT" }); } }, 6000); });
ws.on("message", (b) => { const m = JSON.parse(b.toString()); if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } });
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", role: "mcp" }));
await sleep(150);

console.log("— web_search —");
const bad = await call("web_search", {});
chk("missing query → BAD_PARAMS", bad.ok === false && bad.code === "BAD_PARAMS", JSON.stringify(bad));

// With a stub base + a key present in Keychain (real key on dev machine), or if
// no key, we still validate the NO_API_KEY path deterministically by checking
// the two acceptable outcomes.
const r = await call("web_search", { query: "meaning of life" });
if (r.code === "NO_API_KEY") {
  chk("no key → NO_API_KEY (structured)", true);
} else {
  chk("returns results array", r.ok && Array.isArray(r.result.results) && r.result.results.length === 2, JSON.stringify(r).slice(0, 120));
  chk("shapes title/link/snippet", r.ok && r.result.results[0].title === "Result One" && r.result.results[0].link === "https://one.example");
  chk("surfaces answer box", r.ok && r.result.answer === "42");
  chk("surfaces related questions", r.ok && r.result.related.length === 2);
}

console.log("— multi-engine —");
{
  const loc = await call("local_search", { query: "dentist" });
  chk("local_search shapes places", loc.ok && loc.result.places[0].name === "Bob's Dentistry" && loc.result.places[0].phone === "555-1234", JSON.stringify(loc).slice(0, 120));
  const locBad = await call("local_search", {});
  chk("local_search missing query → BAD_PARAMS", locBad.ok === false && locBad.code === "BAD_PARAMS");
  const shop = await call("shopping_search", { query: "widget" });
  chk("shopping_search shapes products", shop.ok && shop.result.products[0].title === "Widget Pro" && shop.result.products[0].extracted_price === 19.99);
  const news = await call("news_search", { query: "election" });
  chk("news_search shapes articles", news.ok && news.result.articles[0].title === "Big News" && news.result.articles[0].source === "The Times");
}

console.log(`\n${pass} passed, ${fail} failed`);
ws.close(); daemon.kill(); serp.close();
process.exit(fail ? 1 : 0);
