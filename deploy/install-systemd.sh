#!/usr/bin/env bash
#
# Generates and installs a systemd unit for the web dashboard.
#
#   ./deploy/install-systemd.sh --print    # show the unit, install nothing
#   ./deploy/install-systemd.sh            # install, enable and start it
#
# Node's absolute path is resolved here because systemd runs with a minimal
# PATH and would not find a nvm/nodesource install on its own.
#
# Override before running: PORT, HOST, SCRAPER_API_TOKEN, SERVICE_NAME,
# SCRAPER_MAX_CONCURRENT_JOBS, SCRAPER_OUTPUT_DIR, RUN_AS.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-webscraper}"
PORT="${PORT:-3050}"
HOST="${HOST:-127.0.0.1}"
RUN_AS="${RUN_AS:-$(id -un)}"
OUTPUT_DIR="${SCRAPER_OUTPUT_DIR:-$APP_DIR/scraper-output}"
MAX_JOBS="${SCRAPER_MAX_CONCURRENT_JOBS:-2}"
API_TOKEN="${SCRAPER_API_TOKEN:-}"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH. Install Node.js 20+ or run this with the right PATH." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/build/server.js" ]]; then
  echo "build/server.js is missing — run 'npm run build' in $APP_DIR first." >&2
  exit 1
fi

# Playwright caches browsers per user; systemd needs HOME set to find them.
HOME_DIR="$(getent passwd "$RUN_AS" | cut -d: -f6)"
HOME_DIR="${HOME_DIR:-$HOME}"

unit="$(cat <<UNIT
[Unit]
Description=Universal Web Scraper dashboard
Documentation=file://$APP_DIR/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/build/server.js
Restart=on-failure
RestartSec=5

Environment=NODE_ENV=production
Environment=HOME=$HOME_DIR
Environment=PORT=$PORT
Environment=HOST=$HOST
Environment=SCRAPER_OUTPUT_DIR=$OUTPUT_DIR
Environment=SCRAPER_MAX_CONCURRENT_JOBS=$MAX_JOBS
Environment=SCRAPER_LOCALE=tr-TR
Environment=SCRAPER_TIMEZONE=Europe/Istanbul
$( [[ -n "$API_TOKEN" ]] && echo "Environment=SCRAPER_API_TOKEN=$API_TOKEN" )

# Chromium needs a moment to shut down cleanly on stop.
KillSignal=SIGTERM
TimeoutStopSec=20

# Keep the browser from disturbing anything else running on this box.
MemoryMax=2G
TasksMax=512

[Install]
WantedBy=multi-user.target
UNIT
)"

if [[ "${1:-}" == "--print" ]]; then
  echo "$unit"
  exit 0
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "Installing the unit needs root. Re-run with sudo, or use --print and install it yourself." >&2
  exit 1
fi

unit_path="/etc/systemd/system/${SERVICE_NAME}.service"
if [[ -e "$unit_path" ]]; then
  echo "$unit_path already exists. Remove it first, or set SERVICE_NAME to something else." >&2
  exit 1
fi

printf '%s\n' "$unit" > "$unit_path"
chmod 644 "$unit_path"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo
echo "✔ ${SERVICE_NAME}.service installed and started."
echo "  Status : systemctl status $SERVICE_NAME"
echo "  Logs   : journalctl -u $SERVICE_NAME -f"
echo "  Stop   : systemctl stop $SERVICE_NAME"
echo "  Remove : systemctl disable --now $SERVICE_NAME && rm $unit_path && systemctl daemon-reload"
echo
echo "  Dashboard: http://$HOST:$PORT"
[[ "$HOST" == "127.0.0.1" || "$HOST" == "localhost" ]] &&
  echo "  Bound to loopback — reach it with: ssh -L $PORT:127.0.0.1:$PORT $RUN_AS@\$(hostname)"
