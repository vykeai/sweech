#!/bin/bash
# Build, sign, notarize, and package SweechBar as a DMG
# Requires: Xcode, valid Developer ID certificate, notarytool credentials
set -euo pipefail

VERSION="${1:-$(node -e "console.log(require('./package.json').version)")}"
APP_NAME="SweechBar"
DMG_NAME="${APP_NAME}-${VERSION}.dmg"
BUILD_DIR="macos-menubar/SweechBar/.build/release"
APP_BUNDLE="macos-menubar/SweechBar.app"
STAGING_DIR=$(mktemp -d)

echo "Building SweechBar v${VERSION}..."

# 1. Build release
cd macos-menubar/SweechBar
swift build -c release
cd ../..

# 2. Copy binary to app bundle
cp "${BUILD_DIR}/${APP_NAME}" "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"

# 3. Sign (requires Developer ID)
if [ -n "${DEVELOPER_ID:-}" ]; then
    echo "Signing with: ${DEVELOPER_ID}"
    codesign --force --deep --sign "${DEVELOPER_ID}" \
        --options runtime \
        --entitlements macos-menubar/SweechBar.entitlements \
        "${APP_BUNDLE}"
else
    echo "Warning: DEVELOPER_ID not set — skipping code signing"
fi

# 4. Create DMG
echo "Creating DMG..."
cp -R "${APP_BUNDLE}" "${STAGING_DIR}/"
ln -s /Applications "${STAGING_DIR}/Applications"
hdiutil create -volname "${APP_NAME}" \
    -srcfolder "${STAGING_DIR}" \
    -ov -format UDZO \
    "${DMG_NAME}"
rm -rf "${STAGING_DIR}"

# 5. Notarize (requires notarytool credentials)
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    echo "Notarizing..."
    xcrun notarytool submit "${DMG_NAME}" \
        --apple-id "${APPLE_ID}" \
        --team-id "${APPLE_TEAM_ID}" \
        --keychain-profile "sweech-notarize" \
        --wait
    xcrun stapler staple "${DMG_NAME}"
    echo "Notarization complete."
else
    echo "Warning: APPLE_ID/APPLE_TEAM_ID not set — skipping notarization"
fi

echo "Done: ${DMG_NAME}"
