#!/bin/bash
# Generates "Guitar Studio.app" — a minimal double-clickable launcher that
# starts the local server and opens the browser to it.
#
# The .app bundle itself is a build artifact (gitignored, per *.app/ in
# .gitignore) — this script is the actual source of truth, checked into git,
# so the launcher is never a file that only exists un-backed-up on disk
# (exactly the failure mode that made the original rebuild necessary).
#
# Not signed or notarized — this is a personal-use rebuild, not a
# distributed product. First launch will need a right-click > Open (or
# System Settings > Privacy & Security > Open Anyway) to get past Gatekeeper,
# same as any unsigned app.
#
# Usage: scripts/build_app.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$PROJECT_ROOT/Guitar Studio.app"
CONTENTS="$APP_DIR/Contents"

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Guitar Studio</string>
    <key>CFBundleIdentifier</key>
    <string>com.guitarstudio.app</string>
    <key>CFBundleName</key>
    <string>Guitar Studio</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>3.0</string>
    <key>CFBundleVersion</key>
    <string>3.0</string>
    <key>CFBundleGetInfoString</key>
    <string>Guitar Studio 3.0 "Orpheus"</string>
    <key>CFBundleIconFile</key>
    <string>GuitarStudio</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>Guitar Studio needs audio input access for the Play Along live guitar rig.</string>
    <key>NSCameraUsageDescription</key>
    <string>Guitar Studio needs camera access to record performance videos.</string>
</dict>
</plist>
PLIST

cat > "$CONTENTS/MacOS/Guitar Studio" <<'LAUNCHER'
#!/bin/bash
# Guitar Studio launcher: starts the local server (if not already running)
# and opens the browser to it. Loopback-only, no auth — see server.py.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT=8765
URL="http://127.0.0.1:$PORT/"

if ! curl -s -o /dev/null "$URL"; then
  LOG="$DIR/GuitarStudio/server.log"
  # cd first: a double-clicked .app's working directory is whatever Finder
  # gives it (not this project folder), and the engine's relative paths
  # (separated/, output/) resolve against it — belt-and-suspenders on top
  # of backing_track.py now anchoring those paths to its own file location
  # regardless of CWD.
  (cd "$DIR" && "$DIR/venv/bin/python" "$DIR/GuitarStudio/server.py" --port "$PORT" >> "$LOG" 2>&1) &
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "$URL" && break
    sleep 0.5
  done
fi

open "$URL"
LAUNCHER

chmod +x "$CONTENTS/MacOS/Guitar Studio"

# App icon: built from GuitarStudio/static/app-icon.svg by scripts/build_icon.sh
# and committed at assets/GuitarStudio.icns, so a fresh clone doesn't need
# librsvg installed to get an icon'd app.
ICNS="$PROJECT_ROOT/assets/GuitarStudio.icns"
if [ -f "$ICNS" ]; then
  cp "$ICNS" "$CONTENTS/Resources/GuitarStudio.icns"
else
  echo "note: assets/GuitarStudio.icns missing (run scripts/build_icon.sh) — app built without icon" >&2
fi

echo "Built: $APP_DIR"
