#!/usr/bin/env bash
# build-app.sh — builds SweechBar.app bundle
#
# Usage:
#   ./build-app.sh             dev build, no signing (personal use)
#   ./build-app.sh --release   codesign + notarise + staple (distributable)
#
# One-time release setup (do this once per machine):
#   1. Install a "Developer ID Application" certificate into your login keychain
#      (Xcode > Settings > Accounts > Manage Certificates, or Apple Developer portal).
#   2. Store notarisation credentials in a keychain profile (no plaintext secrets):
#        xcrun notarytool store-credentials sweech-notary \
#            --apple-id "you@example.com" \
#            --team-id  "ABCDE12345" \
#            --password "app-specific-password"
#   3. Export the env vars expected by --release:
#        export SWEECH_DEVELOPER_ID="Developer ID Application: Your Name (ABCDE12345)"
#        export SWEECH_NOTARY_PROFILE="sweech-notary"
#
# Both env vars are required when --release is passed; the script exits with a
# clear error before doing any work if either is missing.

set -euo pipefail

RELEASE=0
for arg in "$@"; do
    case "$arg" in
        --release) RELEASE=1 ;;
        -h|--help)
            sed -n '2,22p' "$0"
            exit 0
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SWEECHBAR_DIR="$SCRIPT_DIR/SweechBar"
APP_DIR="$SCRIPT_DIR/SweechBar.app"
CONTENTS="$APP_DIR/Contents"
ENTITLEMENTS_PATH="$SCRIPT_DIR/SweechBar.entitlements"

if [ "$RELEASE" -eq 1 ]; then
    missing=()
    [ -z "${SWEECH_DEVELOPER_ID:-}" ] && missing+=("SWEECH_DEVELOPER_ID")
    [ -z "${SWEECH_NOTARY_PROFILE:-}" ] && missing+=("SWEECH_NOTARY_PROFILE")
    if [ "${#missing[@]}" -gt 0 ]; then
        echo "✗ --release requires: ${missing[*]}" >&2
        echo "  Set SWEECH_DEVELOPER_ID and SWEECH_NOTARY_PROFILE to use --release." >&2
        echo "  See build-app.sh header for one-time setup instructions." >&2
        exit 1
    fi
    if [ ! -f "$ENTITLEMENTS_PATH" ]; then
        echo "✗ Missing entitlements file: $ENTITLEMENTS_PATH" >&2
        exit 1
    fi
fi

echo "→ Building SweechBar (release)..."
cd "$SWEECHBAR_DIR"
swift build -c release 2>&1

BINARY="$SWEECHBAR_DIR/.build/release/SweechBar"
if [ ! -f "$BINARY" ]; then
    echo "✗ Build failed: binary not found at $BINARY"
    exit 1
fi

echo "→ Assembling SweechBar.app..."
rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS"
mkdir -p "$CONTENTS/Resources"

cp "$BINARY" "$CONTENTS/MacOS/SweechBar"
cp "$SWEECHBAR_DIR/AppInfo.plist" "$CONTENTS/Info.plist"

if [ "$RELEASE" -eq 1 ]; then
    echo "→ Codesigning with: $SWEECH_DEVELOPER_ID"
    codesign --force \
        --options runtime \
        --timestamp \
        --sign "$SWEECH_DEVELOPER_ID" \
        --entitlements "$ENTITLEMENTS_PATH" \
        "$APP_DIR"

    echo "→ Verifying signature..."
    codesign --verify --deep --strict --verbose=2 "$APP_DIR"

    ZIP_PATH="$SCRIPT_DIR/SweechBar.zip"
    rm -f "$ZIP_PATH"
    echo "→ Zipping for notarytool submission..."
    /usr/bin/ditto -c -k --keepParent "$APP_DIR" "$ZIP_PATH"

    echo "→ Submitting to Apple notary service (profile: $SWEECH_NOTARY_PROFILE)..."
    xcrun notarytool submit "$ZIP_PATH" \
        --keychain-profile "$SWEECH_NOTARY_PROFILE" \
        --wait

    rm -f "$ZIP_PATH"

    echo "→ Stapling notarisation ticket..."
    xcrun stapler staple "$APP_DIR"

    echo "→ Final Gatekeeper assessment..."
    spctl --assess --type execute --verbose "$APP_DIR"

    echo "→ Done (signed + notarised): $APP_DIR"
else
    echo "→ Done (unsigned dev build): $APP_DIR"
fi

echo ""
echo "To install: cp -r '$APP_DIR' ~/Applications/"
echo "To run now: open '$APP_DIR'"
