#!/usr/bin/env bash
# Start the overnight host (keeps the Mac awake). Detach-safe. Idempotent: kills prior loops.
set -u
cd "$(dirname "$0")/.."
for p in $(pgrep -f 'bash scripts/host.sh' 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
for p in $(pgrep -f 'cloudflared tunnel' 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
for p in $(pgrep -f 'serveo.net' 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
sleep 2
nohup caffeinate -dimsu bash scripts/host.sh >/tmp/leadme-host.out 2>&1 &
echo $! > /tmp/leadme-host.pid
sleep 2
echo "host pid $(cat /tmp/leadme-host.pid)"
