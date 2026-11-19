#!/bin/sh
set -eu

src=$(cd "$(dirname "$0")" && pwd)
plugin="$src/../../target/dock-tile/TrackerDockTile.docktileplugin"
mkdir -p "$plugin/Contents/MacOS"
cp "$src/Info.plist" "$plugin/Contents/Info.plist"
xcrun clang -arch arm64 -arch x86_64 -mmacosx-version-min=14.0 -fobjc-arc -bundle \
    -framework AppKit -framework Foundation "$src/TrackerDockTile.m" \
    -o "$plugin/Contents/MacOS/TrackerDockTile"
codesign --force --sign "${APPLE_SIGNING_IDENTITY:--}" "$plugin"
