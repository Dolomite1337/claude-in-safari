# Claude in Safari — Design Spec

> Date: 2026-06-30
> Status: Approved design, pre-implementation
> A Safari (macOS + iOS) counterpart to Anthropic's "Claude in Chrome" browser
> agent, driven by the user's own Claude subscription via Claude Code.

## 1. Problem & Goal

Anthropic ships **Claude in Chrome** — a Chrome extension that lets Claude
observe and operate a browser (navigate, click, type, read the page, screenshot,
inspect console/network). The brain is Anthropic's proprietary agent backend;
the extension is only the "hands."

**Goal:** build the equivalent for **Safari on macOS**, and later **Safari on
iPhone**, using the user's own **Claude subscription** as the brain — with no
per-token API billing and no ToS gray areas.

## 2. Key Constraint (why the architecture is what it is)

A Claude **subscription** (Pro/Max) and the Claude **API** are separate,
separately-billed products. The subscription authorizes Anthropic's own
first-party apps (claude.ai, Claude desktop, **Claude Code**, the official
Claude-for-Chrome extension) to use the private agent backend. There is **no
public "sign in with Claude" that lets a third-party app run an agent loop on a
subscription.** Faking it (scraping claude.ai OAuth tokens, hitting private
endpoints) violates Anthropic's ToS, is fragile, and risks user account bans —
it is explicitly **out of scope**.

The only legitimate way to drive an agent on the user's subscription is to route
through **Claude Code**, the free CLI that authenticates against the
subscription. Therefore:

- **The brain is Claude Code**, running on the user's Mac.
- **The extension is the hands**, exposing browser-control tools.
- A **local bridge** connects Claude Code (MCP) to the extension (WebSocket).

Accepted trade-off: the audience is people who have Claude Code installed. This
is **not** a one-click consumer install; it is a power-user / developer tool.
The user explicitly chose "real subscription usage" over "one-click install."

## 3. Architecture

```
macOS:
  Claude Code (user's sub) ⇄ MCP stdio ⇄ [bridge: mcp mode]
                                                │  (loopback WS)
                                          [bridge: daemon] ⇄ WS ⇄ Safari ext (macOS) ⇄ page / native helper

iPhone (P5, remote client of the Mac):
                                          [bridge: daemon] ⇄ Tailscale/LAN WS ⇄ Safari ext (iOS) ⇄ page
```

The **bridge daemon** is the rendezvous "Hub" (same pattern as the user's
Second Brain Hub, `electron/hub/server.ts`). Both the extension(s) and the MCP
server connect to it as clients. This handles multiple Claude Code sessions,
Safari restarts, and a second (iOS) client cleanly.

### Components

1. **Bridge (single bundled executable, two modes)**
   - `bridge serve` — always-on daemon. Hosts a WS server on `127.0.0.1:<port>`
     (loopback) and, when enabled, on the Tailscale interface for iOS. Launched
     by the macOS container app via a **launchd** user agent. Maintains the set
     of connected extension clients and routes tool calls to the correct target
     tab/device.
   - `bridge mcp` — thin **stdio MCP server** that Claude Code spawns per
     session. Registers the browser tools, forwards each tool call to the daemon
     over loopback, returns the result. Dies with the session; the daemon
     persists.
   - Language: Node.js/TypeScript (fastest to build, easy WS + MCP SDK) OR a
     compiled Swift/Go binary for a dependency-free bundle. **Decision: Node/TS
     for P1–P3, evaluate compiling to a single binary (e.g. `bun build
     --compile` or `pkg`) for distribution in P4.**

2. **Safari Web Extension (Manifest V3)** — shared JS across macOS + iOS.
   - Background service worker: owns the WS connection to the daemon; dispatches
     inbound tool commands; returns results.
   - Content scripts: DOM read, selector-based click/type, page-context
     interceptors for console/network.
   - Popup: **connection status only** (connected / which daemon / which tab is
     the agent target). The "chat" is Claude Code itself — mirroring how Claude
     in Chrome has no chat in the extension.

3. **macOS container app (Xcode / Swift)**
   - Houses the Safari Web Extension.
   - Bundles the bridge executable; installs/manages the launchd agent.
   - **Native helper**: `CGEvent` coordinate clicks/typing (requires macOS
     Accessibility permission) and screen-region capture for true "computer use."
   - Onboarding UI (see §5).

4. **iOS container app (Xcode / Swift) — P5**
   - Houses the same Safari Web Extension (iOS target).
   - Configures the Tailscale/LAN address of the Mac's daemon.
   - No native `CGEvent` helper (not available on iOS).

## 4. Tool Surface (full parity target, phased)

| Tool | macOS Safari mechanism | iOS Safari mechanism |
|---|---|---|
| `navigate` | `tabs.update({url})` / `tabs.create` | same (supported) |
| `tabs` (list/create/close) | `tabs` API | `tabs` API (subset) |
| `read_page` (text + a11y tree) | content script DOM extraction | same |
| `screenshot` | `tabs.captureVisibleTab` | limited/unavailable — degrade gracefully |
| `click`/`type` (selector) | content script synthesized events | same |
| `click` (coordinate / computer-use) | native helper `CGEvent` (Accessibility) | **not available** (selector only) |
| `console` / `network` capture | injected page-context interceptors | injected interceptors (best-effort) |

### Parity caveat (must set expectations)
Safari has **no `chrome.debugger` API** (which Chrome's extension uses for true
coordinate input and deep console/network capture). We substitute:
- **Coordinate clicks:** native `CGEvent` on macOS; **not possible** on iOS
  (selector-based only).
- **Console/network:** inject interceptors into page context (override
  `console.*`, wrap `fetch`/`XHR`) rather than a devtools protocol.

Result: **~95% functional parity on macOS**; **lower on iOS** (no pixel-level
computer-use, limited screenshots). Difference is mechanism, not intent.

## 5. Install & Onboarding

**macOS distribution: notarized DMG** (developer-signed, outside the App Store).
Rationale: the Mac App Store sandbox fights the always-on daemon, launchd agent,
and writing to Claude Code's MCP config; the audience is technical. App Store is
a possible later track, not v1.

**macOS onboarding (in the container app):**
1. Enable the extension in Safari (deep-link to Safari extension settings).
2. Grant Accessibility permission (optional; enables coordinate clicks).
3. **"Connect to Claude Code"** button → runs
   `claude mcp add claude-in-safari -- <bundled-bridge> mcp` (or writes the MCP
   config directly) and installs/starts the launchd daemon.

Then the user talks to Claude Code normally: *"open example.com and summarize
it"* → Claude Code calls the tools → Safari acts.

**iOS distribution (P5): TestFlight → App Store.** iOS Safari extensions cannot
be sideloaded. iOS onboarding additionally captures the Mac daemon's
Tailscale/LAN address and verifies reachability.

## 6. Data Flow (one tool call)

1. User prompts Claude Code; the model emits a tool call (e.g. `read_page`).
2. `bridge mcp` (spawned by Claude Code) receives it over MCP stdio.
3. It forwards a request over loopback WS to the `bridge serve` daemon.
4. The daemon routes it to the target extension client (macOS or iOS) and the
   active/target tab.
5. The extension executes it (content script / native helper) and returns a
   result payload.
6. Daemon → MCP server → Claude Code, which feeds the result back to the model.
7. Loop until the model finishes; streamed text appears in Claude Code.

## 7. Error Handling

- **Daemon down / extension disconnected:** MCP tools return a structured error
  ("Safari extension not connected — open Safari and enable Claude in Safari").
  Popup shows red status.
- **Multiple Claude Code sessions:** each spawns its own `bridge mcp`; all
  connect to the one daemon. Tool calls carry a session id; the daemon
  serializes actions per target tab to avoid interleaving.
- **iOS background suspension:** if the WS drops because iOS killed the worker,
  the daemon marks that client stale; tools targeting it return a clear
  "iPhone extension is backgrounded — foreground it" error.
- **Accessibility not granted (macOS):** coordinate-click tools return an error
  pointing to the permission; selector-based tools still work.
- **Target-tab ambiguity:** the agent must be told which tab is the target; the
  daemon tracks an "active agent tab" per device, settable via a tool and shown
  in the popup.

## 8. Testing

- **Unit:** tool dispatchers against a mock page / mock `browser.*` API.
- **Bridge round-trip:** MCP tool call → daemon → mock extension client →
  result, including error paths (no client, stale client, two sessions).
- **Manual per-tool:** run each tool from a real Claude Code session against
  live sites.
- **Smoke flow:** scripted "navigate to example.com → read the `<h1>` →
  screenshot → assert" end-to-end.
- No formal harness on iOS in v1 beyond manual TestFlight verification.

## 9. Build Phasing

- **P1 — Vertical slice (macOS):** Xcode skeleton, extension loads in Safari,
  bridge daemon + `bridge mcp`, Claude Code integration, and
  `navigate` / `read_page` / `screenshot` working end-to-end.
- **P2 — Interaction:** `click`/`type` (selector), `tabs`.
- **P3 — Full parity (macOS):** native helper coordinate clicks/typing,
  console/network interceptors.
- **P4 — Ship macOS:** onboarding polish, launchd, "Connect to Claude Code"
  auto-config, single-binary bridge, notarized DMG.
- **P5 — iPhone:** iOS Safari extension target, Tailscale/LAN transport on the
  daemon, iOS onboarding, degraded-parity handling, TestFlight.

## 10. Repository Layout

```
Apps/claude-in-safari/
  bridge/            Shared bridge (daemon + mcp modes)
  extension/         Shared Safari Web Extension (JS, content scripts, popup)
                       + macOS manifest + iOS manifest
  apps/mac/          Xcode macOS container app + native helper
  apps/ios/          Xcode iOS container app (P5)
  docs/              This spec and future docs
```

## 11. Out of Scope (v1)

- Using a raw claude.ai subscription login directly in the extension (impossible
  / ToS-violating).
- Mac App Store / public one-click install (deferred; notarized DMG for v1).
- Standalone iPhone operation without a Mac (impossible — no Claude Code on iOS).
- A chat UI inside the extension (the chat is Claude Code).
- Per-token API-key mode (explicitly rejected in favor of subscription).
