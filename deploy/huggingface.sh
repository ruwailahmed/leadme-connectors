#!/usr/bin/env bash
set -euo pipefail
# Deploy to a free public Hugging Face Space (Docker, 16 GB RAM, sleeps after ~48 h idle).
# usage: HF_TOKEN=hf_xxx OWNER=your-hf-username ./deploy/huggingface.sh
OWNER=${OWNER:?set OWNER to your Hugging Face username}
NAME=${NAME:-leadme-connectors}
TOKEN=${HF_TOKEN:?set HF_TOKEN (write scope)}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

curl -sS -X POST https://huggingface.co/api/repos/create \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"type\":\"space\",\"name\":\"$NAME\",\"sdk\":\"docker\",\"private\":false}" >/dev/null || true

stage=$(mktemp -d)
cp -R "$ROOT/Dockerfile" "$ROOT/package.json" "$ROOT/src" "$ROOT/public" "$stage"/
cp "$ROOT/deploy/hf-readme.md" "$stage/README.md"

( cd "$stage" \
  && git init -q -b main \
  && git add -A \
  && git -c user.email=deploy@leadme -c user.name=leadme commit -qm "deploy" \
  && git remote add origin "https://user:$TOKEN@huggingface.co/spaces/$OWNER/$NAME" \
  && git push -f origin main )

for kv in APP_PASSWORD CREDENTIALS_KEY TENANT_SECRET SERVICE_TOKEN SESSION_WEBHOOK_SECRET KV_REST_API_URL KV_REST_API_TOKEN PUBLIC_URL; do
  v=$(printenv "$kv" || true)
  if [ -n "$v" ]; then
    curl -sS -X POST "https://huggingface.co/api/spaces/$OWNER/$NAME/secrets" \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"key\":\"$kv\",\"value\":\"$v\"}" >/dev/null
  fi
done

echo "Space page: https://huggingface.co/spaces/$OWNER/$NAME"
echo "App URL:    https://$OWNER-$(echo "$NAME" | tr '_' '-').hf.space"
