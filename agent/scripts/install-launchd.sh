#!/bin/bash
# Installs a per-user launchd job so the batch indexer starts at login and is
# restarted if it crashes. It exits (and stays stopped) once nothing is left.
#
#   scripts/install-launchd.sh /Volumes/T9/Varun/Photos "/Volumes/T7Shield/Varun/Bandipur (12,13,14-Sep-2026)"
#   scripts/install-launchd.sh --uninstall
set -eu
LABEL="dev.pixdex.indexer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <root-or-album-folder>... | --uninstall" >&2
  exit 1
fi

NODE_DIR="$(dirname "$(command -v node)")"
OLLAMA_DIR="$(dirname "$(command -v ollama 2>/dev/null || echo /usr/local/bin/ollama)")"
LOG="$AGENT_DIR/.index-state/batch.log"
mkdir -p "$AGENT_DIR/.index-state" "$HOME/Library/LaunchAgents"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  echo "  <key>Label</key><string>$LABEL</string>"
  echo '  <key>ProgramArguments</key><array>'
  echo "    <string>$(xml_escape "$AGENT_DIR/scripts/run-index-batch.sh")</string>"
  for folder in "$@"; do echo "    <string>$(xml_escape "$folder")</string>"; done
  echo '  </array>'
  echo "  <key>WorkingDirectory</key><string>$(xml_escape "$AGENT_DIR")</string>"
  echo '  <key>EnvironmentVariables</key><dict>'
  echo "    <key>PATH</key><string>$(xml_escape "$NODE_DIR:$OLLAMA_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")</string>"
  echo '  </dict>'
  echo '  <key>RunAtLoad</key><true/>'
  echo '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>'
  echo '  <key>ThrottleInterval</key><integer>60</integer>'
  echo "  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>"
  echo "  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>"
  echo '</dict></plist>'
} > "$PLIST"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL (log: $LOG)"
echo "Status:    npm run dev -- index-status    (in $AGENT_DIR)"
echo "Uninstall: $0 --uninstall"
