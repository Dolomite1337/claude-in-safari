// Anthropic tool definitions for the API-key agent loop. The `name` is what the
// model calls; the loop strips the "safari_" prefix to get the daemon tool name.
// Kept in sync with the MCP registrations in index.mjs.

const S = (properties, required = []) => ({ type: "object", properties, required });
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });
const tabId = { type: "number", description: "Target tab id; omit for the active tab" };

export const ANTHROPIC_TOOLS = [
  { name: "safari_navigate", description: "Navigate a Safari tab to a URL and wait for load.", input_schema: S({ url: str("The URL to open"), tabId }, ["url"]) },
  { name: "safari_list_tabs", description: "List open Safari tabs (id, url, title, active).", input_schema: S({}) },
  { name: "safari_new_tab", description: "Open a new tab, optionally at a URL.", input_schema: S({ url: str("URL"), active: bool("Focus it") }) },
  { name: "safari_close_tab", description: "Close a tab by id.", input_schema: S({ tabId: num("Tab id to close") }, ["tabId"]) },
  { name: "safari_activate_tab", description: "Bring a tab to the foreground.", input_schema: S({ tabId: num("Tab id") }, ["tabId"]) },
  { name: "safari_read_page", description: "Read a page: mode 'text' (default), 'a11y' (accessibility tree), or 'both'.", input_schema: S({ mode: { type: "string", enum: ["text", "a11y", "both"] }, tabId }) },
  { name: "safari_screenshot", description: "Screenshot the tab. fullPage=true captures the whole scrollable page.", input_schema: S({ fullPage: bool("Whole page"), tabId }) },
  { name: "safari_page_elements", description: "Inventory actionable elements (links/buttons/inputs) with selectors, type, text.", input_schema: S({ limit: num("Max"), visibleOnly: bool("Only visible"), tabId }) },
  { name: "safari_click", description: "Click an element by CSS selector.", input_schema: S({ selector: str("CSS selector"), tabId }, ["selector"]) },
  { name: "safari_type", description: "Type text into an element; optionally submit.", input_schema: S({ selector: str("CSS selector"), text: str("Text"), submit: bool("Press Enter after"), tabId }, ["selector", "text"]) },
  { name: "safari_find", description: "Find elements whose text/label contains a query; returns selectors.", input_schema: S({ query: str("Text to find"), limit: num("Max"), tabId }, ["query"]) },
  { name: "safari_scroll", description: "Scroll by direction (up/down/left/right), to x/y, or to a selector.", input_schema: S({ selector: str("Into view"), x: num("x"), y: num("y"), direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: num("px"), tabId }) },
  { name: "safari_hover", description: "Hover the mouse over an element.", input_schema: S({ selector: str("CSS selector"), tabId }, ["selector"]) },
  { name: "safari_select", description: "Choose a <select> option by value or label.", input_schema: S({ selector: str("CSS selector"), value: str("Value/label"), tabId }, ["selector", "value"]) },
  { name: "safari_press_key", description: "Dispatch a key (Enter, Tab, Escape, Arrow*, ...).", input_schema: S({ key: str("Key"), selector: str("Target"), tabId }, ["key"]) },
  { name: "safari_go_back", description: "Navigate back.", input_schema: S({ tabId }) },
  { name: "safari_go_forward", description: "Navigate forward.", input_schema: S({ tabId }) },
  { name: "safari_reload", description: "Reload the tab.", input_schema: S({ tabId }) },
  { name: "safari_wait_for", description: "Wait until a selector appears (or state='navigation').", input_schema: S({ selector: str("CSS selector"), state: { type: "string", enum: ["navigation"] }, timeout: num("ms"), tabId }) },
  { name: "safari_get_element", description: "Inspect one element: box, text, tag, visibility, attributes.", input_schema: S({ selector: str("CSS selector"), tabId }, ["selector"]) },
  { name: "safari_highlight", description: "Briefly outline an element (visual confirmation).", input_schema: S({ selector: str("CSS selector"), tabId }, ["selector"]) },
  { name: "safari_web_search", description: "Web search (Google). Returns titles/links/snippets + answer box.", input_schema: S({ query: str("Query"), limit: num("Max"), region: str("Country code"), lang: str("Language") }, ["query"]) },
  { name: "safari_local_search", description: "Local businesses/places (Maps): name, rating, phone, address, hours, website.", input_schema: S({ query: str("e.g. 'coffee near me'"), ll: str("@lat,long,zoom"), limit: num("Max") }, ["query"]) },
  { name: "safari_shopping_search", description: "Products/prices across sellers.", input_schema: S({ query: str("Query"), limit: num("Max") }, ["query"]) },
  { name: "safari_news_search", description: "Current news articles.", input_schema: S({ query: str("Query"), limit: num("Max") }, ["query"]) },
];
