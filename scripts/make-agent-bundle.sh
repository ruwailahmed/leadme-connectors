#!/usr/bin/env bash
# Build the artifact a customer installs: runtime only (no data, no secrets, no node_modules).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
mkdir -p dist
OUT="dist/leadme-agent-${VERSION}.tgz"
rm -f "$OUT"
tar -czf "$OUT" package.json src public scripts/install-agent.sh scripts/install-agent.ps1
echo "artifact: $OUT"
echo "sha256:   $(shasum -a 256 "$OUT" | awk '{print $1}')"
echo "size:     $(du -h "$OUT" | awk '{print $1}')"
