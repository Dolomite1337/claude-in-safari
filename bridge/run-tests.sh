#!/bin/zsh
# Run all bridge test suites in isolation (dedicated ports; never touches the
# production launchd daemon on 8787). Exits non-zero if any suite fails.
set -e
cd "$(dirname "$0")"
fail=0
for t in test-roundtrip.mjs test-mcp.mjs test-tools.mjs test-reconnect.mjs test-safety.mjs test-coords.mjs test-approval.mjs test-search.mjs test-api.mjs; do
  echo "=== $t ==="
  if node "$t"; then echo "  → $t OK"; else echo "  → $t FAILED"; fail=1; fi
  echo
  sleep 1
done
# Reap any stray test daemons on test ports (never 8787).
pkill -f "index.mjs serve" 2>/dev/null || true
sleep 1
launchctl kickstart "gui/$(id -u)/${CIS_LAUNCHD_LABEL:-com.claude-in-safari.bridge}" 2>/dev/null || true
exit $fail
