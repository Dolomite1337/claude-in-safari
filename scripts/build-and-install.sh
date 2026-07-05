#!/bin/zsh
# Build → Developer ID sign → notarize → staple → install → register the
# Claude in Safari app, plus build+install the cissynth helper. Idempotent.
#
# Usage: scripts/build-and-install.sh [--no-notarize]
#   --no-notarize : skip Apple notarization (Safari will then require the
#                   "Allow unsigned extensions" toggle; use only for quick dev)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="$ROOT/apps/Claude in Safari"
BUILT="$APPDIR/build/Build/Products/Release/Claude in Safari.app"
APP="/Applications/Claude in Safari.app"
EXT_ENT="$APPDIR/Claude in Safari Extension/Claude in Safari Extension.entitlements"
APP_ENT="$APPDIR/Claude in Safari/Claude in Safari.entitlements"
RES="$APPDIR/Claude in Safari Extension/Resources"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
EXT_ID="${CIS_EXT_ID:-com.example.claude-in-safari.Extension}"

# --- Your own Apple signing identity (set these before running) ---
#   CIS_SIGN_IDENTITY : e.g. "Developer ID Application: Your Name (TEAMID)"
#                       run `security find-identity -v -p codesigning` to see yours.
#                       Leave unset to build ad-hoc signed (dev only; needs the
#                       Safari "Allow unsigned extensions" toggle, and no notarization).
#   For notarization, also set: CIS_ASC_KEY_ID, CIS_ASC_ISSUER, CIS_ASC_KEY_PATH
ID="${CIS_SIGN_IDENTITY:--}"   # "-" = ad-hoc
NOTARIZE=1
[ "$1" = "--no-notarize" ] && NOTARIZE=0
[ "$ID" = "-" ] && NOTARIZE=0   # can't notarize an ad-hoc build
if [ "$NOTARIZE" = "1" ] && { [ -z "$CIS_ASC_KEY_ID" ] || [ -z "$CIS_ASC_ISSUER" ] || [ -z "$CIS_ASC_KEY_PATH" ]; }; then
  echo "note: notarization creds not set (CIS_ASC_KEY_ID / CIS_ASC_ISSUER / CIS_ASC_KEY_PATH) — skipping notarization"
  NOTARIZE=0
fi

echo "▸ syncing extension sources into Xcode project"
cp "$ROOT/extension/"*.js "$ROOT/extension/"*.html "$ROOT/extension/manifest.json" "$RES/"

echo "▸ building cissynth helper"
"$ROOT/tools/cissynth/build.sh"

echo "▸ xcodebuild (Release)"
cd "$APPDIR"
xcodebuild -project "Claude in Safari.xcodeproj" -scheme "Claude in Safari" \
  -configuration Release -derivedDataPath build \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES build \
  | grep -iE "error:|BUILD (SUCCEEDED|FAILED)" || true

echo "▸ signing (appex then app)"
codesign --force --sign "$ID" --options runtime --timestamp --entitlements "$EXT_ENT" \
  "$BUILT/Contents/PlugIns/Claude in Safari Extension.appex"
codesign --force --sign "$ID" --options runtime --timestamp --entitlements "$APP_ENT" "$BUILT"

if [ "$NOTARIZE" = "1" ]; then
  echo "▸ notarizing"
  ZIP="$(mktemp -d)/CiS.zip"
  ditto -c -k --keepParent "$BUILT" "$ZIP"
  xcrun notarytool submit "$ZIP" \
    --key "$CIS_ASC_KEY_PATH" --key-id "$CIS_ASC_KEY_ID" --issuer "$CIS_ASC_ISSUER" --wait \
    | grep "status:" | tail -1
  xcrun stapler staple "$BUILT"
fi

echo "▸ installing to /Applications"
pkill -f "Claude in Safari" 2>/dev/null || true; sleep 1
"$LSREGISTER" -u "$APP" 2>/dev/null || true
rm -rf "$APP"
ditto "$BUILT" "$APP"
"$LSREGISTER" -u "$BUILT" 2>/dev/null || true
"$LSREGISTER" -f "$APP"
open "$APP"; sleep 3
pluginkit -a "$APP/Contents/PlugIns/Claude in Safari Extension.appex" 2>/dev/null || true
pluginkit -e use -i "$EXT_ID" 2>/dev/null || true

echo "▸ Gatekeeper:"; spctl --assess --type execute -v "$APP" 2>&1 || true
echo "✅ done. Restart Safari, then enable the extension in Settings › Extensions."
