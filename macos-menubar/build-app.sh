#!/usr/bin/env bash
# build-app.sh — builds SweechBar.app bundle
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SWEECHBAR_DIR="$SCRIPT_DIR/SweechBar"
APP_DIR="$SCRIPT_DIR/SweechBar.app"
CONTENTS="$APP_DIR/Contents"

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

echo "→ Done: $APP_DIR"
echo ""
echo "To install: cp -r '$APP_DIR' ~/Applications/"
echo "To run now: open '$APP_DIR'"
