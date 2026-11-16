#!/usr/bin/env bash
#
# Cloudflare quick tunnel for Movie Creator (Linux/macOS).
#
# Gives the app a public HTTPS URL (https://xxxx.trycloudflare.com) so the web
# app and APK are reachable from any network, not just the LAN. No account
# needed. The URL changes every start and lives only while this runs; for a
# permanent hostname use a named tunnel in Cloudflare Zero Trust.
#
# Safety: with a tunnel the server is on the internet. Set APP_AUTH_TOKEN in
# .env, or the (billable) AI endpoints are open to anyone.
set -euo pipefail

PORT="${PORT:-3000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
TOOLS="$ROOT/tools"
mkdir -p "$TOOLS"

case "$(uname -s)" in
  Darwin) BIN="cloudflared-darwin-amd64" ;;
  *)      BIN="cloudflared-linux-amd64" ;;
esac
EXE="$TOOLS/cloudflared"
[ -f "$EXE" ] || { echo "Downloading cloudflared ..."; curl -fsSL -o "$EXE" "https://github.com/cloudflare/cloudflared/releases/latest/download/$BIN"; chmod +x "$EXE"; }

LOG="$TOOLS/tunnel.log"
: > "$LOG"
echo "Opening a tunnel to http://127.0.0.1:$PORT ..."
"$EXE" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate --logfile "$LOG" &
CF_PID=$!

URL=""
for _ in $(seq 1 60); do
  sleep 1
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
done

if [ -z "$URL" ]; then
  echo "No tunnel URL after 60s. See $LOG" >&2
  kill "$CF_PID" 2>/dev/null || true
  exit 1
fi

cat <<EOF

PUBLIC URL : $URL
Landing    : $URL/landing
Dashboard  : $URL/dashboard
Android APK: $URL/android

Open these on the tablet and phone (works on mobile data too).
Stop the tunnel: kill $CF_PID

NOTE: set APP_AUTH_TOKEN in .env before exposing this to the internet.
EOF

wait "$CF_PID"
