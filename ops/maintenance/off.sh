#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/opt/wishlist/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "[maintenance] ERROR: $ENV_FILE not found" >&2
  exit 1
fi

if grep -q '^MAINTENANCE_MODE=' "$ENV_FILE"; then
  sed -i 's/^MAINTENANCE_MODE=.*/MAINTENANCE_MODE=false/' "$ENV_FILE"
else
  echo 'MAINTENANCE_MODE=false' >> "$ENV_FILE"
fi

echo "[maintenance] OFF — watchdog alerts active"
