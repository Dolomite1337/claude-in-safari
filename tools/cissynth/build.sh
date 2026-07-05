#!/bin/zsh
# Build + sign cissynth, then install it where the bridge daemon looks.
set -e
cd "$(dirname "$0")"
# Set CIS_SIGN_IDENTITY to your Developer ID (see scripts/build-and-install.sh);
# defaults to ad-hoc "-" which works locally with Accessibility granted.
ID="${CIS_SIGN_IDENTITY:--}"
swiftc -O main.swift -o cissynth
# Plain Developer ID signing (NO hardened runtime): a hardened-runtime binary
# that isn't notarized gets SIGKILLed at launch. Hardened runtime is only added
# when the helper is bundled into the notarized DMG (see scripts/build-and-install).
codesign --force --sign "$ID" cissynth
DEST="$HOME/Library/Application Support/Claude in Safari"
mkdir -p "$DEST"
# rm before cp → fresh inode, avoiding the kernel's stale code-signature cache
# (overwriting an already-run signed binary in place causes "Killed: 9").
rm -f "$DEST/cissynth"
cp cissynth "$DEST/cissynth"
# Re-sign at the final path for good measure.
codesign --force --sign "$ID" "$DEST/cissynth"
echo "installed → $DEST/cissynth"
