import { WebSocket } from "ws";
import crypto from "node:crypto";
import fs from "node:fs";

const ws = new WebSocket("ws://127.0.0.1:8787");
const waiters = new Map();
const call = (tool, params = {}) => new Promise((res) => {
  const id = crypto.randomUUID();
  waiters.set(id, res);
  ws.send(JSON.stringify({ type: "tool", id, tool, params }));
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); res({ ok: false, error: "timeout" }); } }, 40000);
});

ws.on("message", (b) => {
  const m = JSON.parse(b.toString());
  if (m.type === "result" && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
});

ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "hello", role: "mcp" }));

  console.log("1️⃣ navigate → example.com");
  const nav = await call("navigate", { url: "https://example.com" });
  console.log("   ", nav.ok ? `✅ ${nav.result.title} (${nav.result.url})` : `❌ ${nav.error}`);

  console.log("2️⃣ read_page");
  const read = await call("read_page");
  console.log("   ", read.ok ? `✅ "${(read.result.text || "").slice(0, 80).replace(/\n/g, " ")}..."` : `❌ ${read.error}`);

  console.log("3️⃣ screenshot");
  const shot = await call("screenshot");
  if (shot.ok) {
    const b64 = shot.result.dataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(process.env.SHOT_PATH, Buffer.from(b64, "base64"));
    console.log(`    ✅ saved ${Math.round(b64.length * 0.75 / 1024)} KB png`);
  } else console.log(`    ❌ ${shot.error}`);

  console.log("4️⃣ list_tabs");
  const tabs = await call("list_tabs");
  console.log("   ", tabs.ok ? `✅ ${tabs.result.length} tabs open` : `❌ ${tabs.error}`);

  const pass = nav.ok && read.ok && shot.ok && tabs.ok;
  console.log(pass ? "\n🏁 P1 VERIFIED END-TO-END" : "\n⚠️ partial");
  process.exit(pass ? 0 : 1);
});
