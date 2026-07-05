// Verify the MCP server boots and advertises its tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Dedicated test port so the auto-spawned daemon never clashes with the
// production launchd daemon on 8787.
const PORT = process.env.CIS_PORT || "8902";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["index.mjs", "mcp"],
  env: { ...process.env, CIS_PORT: PORT },
});
const client = new Client({ name: "test", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));
const expected = [
  "safari_navigate", "safari_list_tabs", "safari_new_tab", "safari_close_tab", "safari_activate_tab",
  "safari_read_page", "safari_screenshot", "safari_click", "safari_type", "safari_find", "safari_page_elements",
  "safari_scroll", "safari_hover", "safari_select", "safari_press_key", "safari_go_back", "safari_go_forward", "safari_reload", "safari_wait_for", "safari_get_element", "safari_highlight",
  "safari_capture_start", "safari_read_console", "safari_read_network",
  "safari_computer_click", "safari_computer_click_viewport", "safari_computer_type", "safari_computer_key", "safari_web_search", "safari_local_search", "safari_shopping_search", "safari_news_search", "safari_capabilities",
];
const missing = expected.filter((n) => !tools.some((t) => t.name === n));
const pass = missing.length === 0;
console.log(pass ? `PASS ✅ (${tools.length} tools)` : `FAIL ❌ missing: ${missing.join(", ")}`);

await client.close();
process.exit(pass ? 0 : 1);
