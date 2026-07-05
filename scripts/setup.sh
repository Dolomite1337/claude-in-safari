#!/bin/zsh
# One-time setup: install the bridge daemon as a launchd agent, install deps,
# and (optionally) register the MCP server for Claude Code users.
#
#   scripts/setup.sh            # daemon + deps
#   scripts/setup.sh --mcp      # also register with Claude Code (`claude mcp add`)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$ROOT/bridge/index.mjs"
LABEL="${CIS_LAUNCHD_LABEL:-com.claude-in-safari.bridge}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

[ -z "$NODE" ] && { echo "✗ Node.js not found. Install Node 18+ first (https://nodejs.org)."; exit 1; }

echo "▸ installing bridge dependencies"
( cd "$ROOT/bridge" && npm install --omit=dev >/dev/null 2>&1 || npm install >/dev/null 2>&1 )

echo "▸ installing launchd agent ($LABEL)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$BRIDGE</string><string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/claude-in-safari-bridge-stderr.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "  ✓ daemon running on 127.0.0.1:8787"

if [ "$1" = "--mcp" ]; then
  if command -v claude >/dev/null 2>&1; then
    echo "▸ registering MCP server with Claude Code"
    claude mcp remove claude-in-safari --scope user 2>/dev/null || true
    claude mcp add claude-in-safari --scope user -- "$NODE" "$BRIDGE" mcp && echo "  ✓ registered (claude mcp list to verify)"
  else
    echo "  (claude not found — skip --mcp, or install Claude Code and re-run)"
  fi
fi

echo "✅ setup done. Next: build the app (scripts/build-and-install.sh), then enable"
echo "   the extension in Safari › Settings › Extensions."
