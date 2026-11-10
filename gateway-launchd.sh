#!/bin/bash
# gateway-launchd.sh: keep the gateway running on a Mac with a LaunchAgent (starts at login, restarts if it stops).
# The Mac version of the duet-gateway scheduled task. Run it as yourself, not with sudo:
#   ./gateway-launchd.sh            install (or update) and start
#   ./gateway-launchd.sh uninstall  stop and remove
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.duet-gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
[ "$(uname)" = "Darwin" ] || { echo "This script is for macOS." >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo "Run it as yourself, not with sudo." >&2; exit 1; }

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL."
  exit 0
fi

NODE="$(command -v node || true)"
[ -x "$NODE" ] || { echo "Node.js was not found on PATH." >&2; exit 1; }
[ -f "$HERE/config.json" ] || { echo "No config.json in $HERE. Copy config.example.json first." >&2; exit 1; }
chmod 600 "$HERE/config.json"
mkdir -p "$HOME/Library/LaunchAgents"
# launchd starts jobs with a bare PATH; files_search needs rg and upstreams may need python3 or node.
JOB_PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HERE/gateway.mjs</string></array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$JOB_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HERE/gateway.out</string>
  <key>StandardErrorPath</key><string>$HERE/gateway.out</string>
</dict>
</plist>
PLISTEOF
plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "$LABEL is running. Log: $HERE/gateway.log"
