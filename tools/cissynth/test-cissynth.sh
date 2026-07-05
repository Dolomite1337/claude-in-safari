#!/bin/zsh
# Integration test for the cissynth CGEvent helper. Verifies usage/exit-code
# contract. The actual click/type require Accessibility; if not granted, those
# cases assert the correct exit 3 (NEEDS_ACCESSIBILITY) instead of failing.
cd "$(dirname "$0")"
[ -x ./cissynth ] || swiftc -O main.swift -o cissynth
pass=0; fail=0
chk() { if eval "$2"; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; fail=$((fail+1)); fi }

# Bad usage → exit 2
./cissynth 2>/dev/null; chk "no args → exit 2" "[ \$? -eq 2 ]"
./cissynth click 2>/dev/null; chk "click missing coords → exit 2" "[ \$? -eq 2 ]"
./cissynth bogus 2>/dev/null; chk "unknown cmd → exit 2" "[ \$? -eq 2 ]"

# probe → 0 (granted) or 3 (needs accessibility); never crash
./cissynth probe >/dev/null 2>&1; code=$?
chk "probe → 0 or 3 (got $code)" "[ $code -eq 0 -o $code -eq 3 ]"

if [ $code -eq 0 ]; then
  ./cissynth key "escape" >/dev/null 2>&1; chk "key escape → 0 (granted)" "[ \$? -eq 0 ]"
  ./cissynth key "boguskey" >/dev/null 2>&1; chk "key unknown → 1" "[ \$? -eq 1 ]"
else
  ./cissynth click 10 10 2>/dev/null; chk "click w/o accessibility → 3" "[ \$? -eq 3 ]"
  echo "  ℹ️  Accessibility not granted to this binary — click/type/key gated (expected)."
fi

echo "$pass passed, $fail failed"
exit $fail
