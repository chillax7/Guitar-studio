#!/bin/bash
# Renders GuitarStudio/static/app-icon.svg (the single source of truth for
# all icon artwork) into assets/GuitarStudio.icns for the .app bundle.
# scripts/build_app.sh copies the .icns into the bundle if it exists.
#
# Requires rsvg-convert (brew install librsvg) + the stock macOS iconutil.
# The generated .icns is committed to git (it's small and means a fresh
# clone can build the .app without needing librsvg installed).
#
# Usage: scripts/build_icon.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$PROJECT_ROOT/GuitarStudio/static/app-icon.svg"
OUT_DIR="$PROJECT_ROOT/assets"
ICONSET="$OUT_DIR/GuitarStudio.iconset"

RSVG="$(command -v rsvg-convert || echo /opt/homebrew/bin/rsvg-convert)"
[ -x "$RSVG" ] || { echo "rsvg-convert not found — brew install librsvg" >&2; exit 1; }

mkdir -p "$ICONSET"

# macOS iconset: each size plus its @2x pair.
for entry in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
             128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 \
             512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  px="${entry%%:*}"; name="${entry#*:}"
  "$RSVG" -w "$px" -h "$px" "$SVG" -o "$ICONSET/$name.png"
done

iconutil -c icns "$ICONSET" -o "$OUT_DIR/GuitarStudio.icns"
rm -rf "$ICONSET"

echo "Built: $OUT_DIR/GuitarStudio.icns"
