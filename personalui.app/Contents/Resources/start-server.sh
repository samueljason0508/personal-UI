#!/bin/bash
# Ensures the panel server is running. Exits 0 once it's reachable, nonzero
# with a message on stderr otherwise. Used by the native app wrapper before
# it opens its window; the terminal launcher (`omp-panel` at the repo root)
# has its own copy of this same logic for the Orca workflow.
set -euo pipefail

DIR="$HOME/git/personal-UI"
PORT="${OMP_PANEL_PORT:-8777}"
URL="http://127.0.0.1:$PORT"
LOG="${TMPDIR:-/tmp}/personalui-server.log"

if [[ ! -f "$DIR/server.ts" ]]; then
	echo "repo not found at $DIR" >&2
	exit 1
fi

BUN=""
for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun "$HOME/.bun/bin/bun"; do
	[[ -x "$candidate" ]] && BUN="$candidate" && break
done
[[ -z "$BUN" ]] && BUN="$(command -v bun || true)"
if [[ -z "$BUN" ]]; then
	echo "bun not found (checked /opt/homebrew/bin, /usr/local/bin, ~/.bun/bin)" >&2
	exit 1
fi

health() { curl -fsS --max-time 2 "$URL/api/ports" >/dev/null 2>&1; }

# A plain `cmd &` here would share this process's own lifecycle and die
# with it on the next restart. A LaunchAgent is its own launchd job,
# independent of whatever launched it, and (since the plist stays on disk)
# comes back up on login too.
LABEL="dev.omp.panel.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if ! health; then
	mkdir -p "$HOME/Library/LaunchAgents"
	cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN</string>
		<string>$DIR/server.ts</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$DIR</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>OMP_PANEL_PORT</key>
		<string>$PORT</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$LOG</string>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
</dict>
</plist>
EOF
	launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
	launchctl bootstrap "$DOMAIN" "$PLIST"
	for _ in $(seq 1 40); do
		health && break
		sleep 0.25
	done
	if ! health; then
		echo "server failed to start, see $LOG" >&2
		exit 1
	fi
fi

echo "$URL"
