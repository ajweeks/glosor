#!/usr/bin/env bash
# Start glosor for public use: load secrets from .env, check they're all set, and run the server,
# plus a Cloudflare Tunnel when TUNNEL_NAME is set. First run creates .env from .env.example.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
  echo "Created .env. Fill in the empty keys, then run ./start.sh again."
  exit 1
fi

set -a
source .env
set +a

missing=()
for var in ANTHROPIC_API_KEY TURNSTILE_SITE_KEY TURNSTILE_SECRET_KEY ACCESS_PASSWORD DAILY_BUDGET_USD SESSION_SECRET; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if (( ${#missing[@]} )); then
  echo "Missing in .env: ${missing[*]}" >&2
  exit 1
fi

[[ -d node_modules ]] || npm install --omit=dev
[[ -f data/corpus.json ]] || npm run build-corpus

PORT=${PORT:-5173}
export PORT

if [[ -n "${TUNNEL_NAME:-}" ]]; then
  command -v cloudflared >/dev/null || { echo "TUNNEL_NAME is set but cloudflared isn't installed." >&2; exit 1; }
  # Requests arrive from the tunnel on localhost, with the visitor's IP as the last X-Forwarded-For hop.
  # Only trusted here: without a proxy in front, that header is whatever the client sends.
  export TRUST_PROXY=1
  cloudflared tunnel --no-autoupdate run --url "http://localhost:$PORT" "$TUNNEL_NAME" &
  tunnel=$!
  trap 'kill $tunnel 2>/dev/null' EXIT
fi

node server.js
