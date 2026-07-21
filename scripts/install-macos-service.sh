#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${XTREME_BOOKMARKS_DATA_DIR:-$HOME/.xtreme-bookmarks}"
PORT="${XTREME_BOOKMARKS_PORT:-3848}"
LABEL="com.xtreme-bookmarks.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/XtremeBookmarks"
NODE_BIN="$(command -v node)"

if [[ ! -f "$ROOT_DIR/dist/cli.js" ]]; then
  echo "Building Xtreme Bookmarks..."
  (cd "$ROOT_DIR" && npm run build)
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$DATA_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT_DIR/dist/cli.js</string>
    <string>web</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>XTREME_BOOKMARKS_DATA_DIR</key>
    <string>$DATA_DIR</string>
    <key>XTREME_BOOKMARKS_NO_OPEN</key>
    <string>1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/server-error.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Xtreme Bookmarks service installed."
echo "URL: http://127.0.0.1:$PORT/"
echo "Logs: $LOG_DIR"
