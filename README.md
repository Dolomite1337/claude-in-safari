# Claude in Safari

An open-source **"Claude in Chrome" for Safari** — a Safari extension that lets
Claude *see and drive your browser*: navigate, click, type, read pages, search
the web, and complete multi-step tasks, with a chat sidebar and per-action
safety approval.

It runs one of two "brains":

| Brain | Requirement | Cost |
|---|---|---|
| **Claude Code** | You have [Claude Code](https://claude.com/claude-code) + a Claude subscription | flat (your subscription) |
| **Anthropic API key** | Any Anthropic API key | per-token |

Pick either in the extension popup. Everything runs **locally on your Mac** — the
extension talks to a small local bridge; your keys live in your macOS Keychain.

> ⚠️ **This is community software, not affiliated with Anthropic or Apple.** It
> uses your *own* Claude Code / API key. It does not and cannot use anyone else's
> Claude subscription.

---

## What it can do

**33 tools**, including: `navigate`, tabs (open/close/switch), `read_page`
(text + accessibility tree), `screenshot` (incl. full-page), `click`, `type`,
`find`, `page_elements`, `scroll`, `hover`, `select`, `press_key`, back/forward,
`wait_for`, `get_element`, `highlight`, coordinate/computer-use clicks (via a
tiny signed helper + Accessibility), console/network capture, and web search
(Google / Maps / Shopping / News via [SerpAPI](https://serpapi.com)).

Plus: a **chat sidebar** (markdown, tool-activity cards, model picker, Stop),
**Ask-first mode** with per-action Allow/Deny approval, structured error codes,
and self-healing reconnect.

## Architecture

```
Sidebar / Claude Code  ─▶  local bridge daemon (:8787)  ─▶  Safari extension  ─▶  page
                             │
                             └─ brain: Claude Code (claude -p) OR Anthropic API loop
```

WebKit blocks `ws://localhost` from extension JS, so the extension reaches the
bridge through its **native messaging** handler (a signed macOS app extension).

## Requirements

- macOS + Safari 16.4+
- [Node.js](https://nodejs.org) 18+
- One brain: **Claude Code** *or* an **Anthropic API key**
- Xcode (to build the Safari app) + an Apple Developer ID (to sign/notarize;
  or build ad-hoc for local dev)
- Optional: a [SerpAPI](https://serpapi.com/manage-api-key) key for web search

## Install

```sh
git clone <your-fork-url> claude-in-safari && cd claude-in-safari

# 1) Bridge daemon + deps (add --mcp to register with Claude Code)
./scripts/setup.sh --mcp

# 2) Build & install the Safari app.
#    Set your own signing identity for a clean (notarized) install:
export CIS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export CIS_ASC_KEY_ID=...  CIS_ASC_ISSUER=...  CIS_ASC_KEY_PATH=~/AuthKey_XXX.p8   # for notarization
export CIS_EXT_ID="com.yourname.claude-in-safari.Extension"
./scripts/build-and-install.sh
#    …or just `./scripts/build-and-install.sh` to build ad-hoc (dev): you'll need
#    Safari › Develop › "Allow Unsigned Extensions" (resets each launch).
```

Then in Safari: **Settings › Extensions → enable "Claude in Safari"** →
**"Always Allow on Every Website."** Open the popup to set your **Brain** and
optional **SerpAPI** key.

> **Building your own signed copy?** Change the bundle identifier in the Xcode
> project (currently a placeholder) and set `CIS_SIGN_IDENTITY` /
> `CIS_EXT_ID` to your own.

## Use it

- **Sidebar:** click the toolbar icon → *Open Claude Sidebar* → chat (e.g.
  *"find the best-rated coffee shop nearby and open its site"*).
- **Claude Code:** in a session, ask it to use the `safari_*` tools.

## Safety

- **Ask-first mode** holds consequential actions (navigation, form submit,
  screen clicks) for your Allow/Deny approval in the sidebar; fails safe.
- The extension can read/alter pages you're on — same trust model as any
  browser extension. Review the code; it's all here.
- Keys are stored in **macOS Keychain**, read only at call time, never logged.
- Coordinate/computer-use requires you to grant **Accessibility** to the helper.

## Develop / test

```sh
cd bridge && ./run-tests.sh     # offline suites (hermetic)
node verify-live.mjs            # live vs real Safari (Safari open)
node verify-fixture.mjs         # end-to-end against a local fixture site
```

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Anthropic or Apple.
