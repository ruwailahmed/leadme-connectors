#!/usr/bin/env bash
# Customer installer (macOS / Linux). Runs the connector agent as a background service on THIS
# machine: browsers, profiles and sessions stay local. The cloud only holds the licence.
#   curl -fsSL <installer> | bash -s -- --license <key> --url <artifact.tgz>
set -euo pipefail

LICENSE=""; CP="${LEADME_CONTROL_PLANE:-https://leadme-connectors.vercel.app}"
URL="${LEADME_AGENT_URL:-}"; PORT="${LEADME_AGENT_PORT:-4310}"; NO_SERVICE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --license) LICENSE=$2; shift 2 ;;
    --control-plane) CP=$2; shift 2 ;;
    --url) URL=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

[ -n "$LICENSE" ] || { echo "usage: install-agent.sh --license <key> [--control-plane URL] [--url tarball]"; exit 1; }
[ -n "$URL" ] || { echo "missing --url (or LEADME_AGENT_URL) pointing at leadme-agent-<version>.tgz"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 22.18+ is required: https://nodejs.org/en/download"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node 22.18+ required (found $(node -v))"; exit 1; }

DIR="$HOME/.leadme-agent"
LOG="/tmp/leadme-agent.log"
mkdir -p "$DIR"
echo "→ downloading agent"
curl -fsSL "$URL" -o "$DIR/agent.tgz"
tar -xzf "$DIR/agent.tgz" -C "$DIR"

KEY=$(openssl rand -hex 32 2>/dev/null || true)
[ -n "$KEY" ] || KEY=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
umask 077
cat > "$DIR/.env" <<EOF
AGENT_MODE=1
PORT=$PORT
LICENSE_KEY=$LICENSE
CONTROL_PLANE_URL=$CP
CREDENTIALS_KEY=$KEY
EOF
chmod 600 "$DIR/.env"
NODE_BIN=$(command -v node)

if [ "$NO_SERVICE" = "1" ]; then
  echo "→ start manually: cd $DIR && node --env-file-if-exists=.env src/server.ts"
else
  case "$(uname -s)" in
    Darwin)
      PLIST="$HOME/Library/LaunchAgents/com.leadme.agent.plist"
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.leadme.agent</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>--env-file-if-exists=.env</string><string>src/server.ts</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
      launchctl unload "$PLIST" 2>/dev/null || true
      launchctl load -w "$PLIST"
      echo "→ installed as a login service (com.leadme.agent)";;
    Linux)
      UNIT="$HOME/.config/systemd/user/leadme-agent.service"
      mkdir -p "$(dirname "$UNIT")"
      cat > "$UNIT" <<EOF
[Unit]
Description=leadme connector agent
After=network-online.target
[Service]
WorkingDirectory=$DIR
ExecStart=$NODE_BIN --env-file-if-exists=.env src/server.ts
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now leadme-agent
      echo "→ installed as a user service (leadme-agent)";;
    *) echo "→ unknown OS; start manually: cd $DIR && node --env-file-if-exists=.env src/server.ts";;
  esac
fi

echo
echo "Agent:    http://localhost:$PORT"
echo "Licence:  paired with $CP"
echo "Logs:     $LOG"
echo "Stop:     launchctl unload ~/Library/LaunchAgents/com.leadme.agent.plist  (or: systemctl --user stop leadme-agent)"
