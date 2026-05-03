#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/wishlist}"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"

section() {
  printf '\n=== %s ===\n' "$*"
}

section "System"
hostname || true
date -u '+%Y-%m-%dT%H:%M:%SZ'
uname -a
if command -v lsb_release >/dev/null 2>&1; then
  lsb_release -a || true
elif [ -f /etc/os-release ]; then
  cat /etc/os-release
fi

section "Project"
test -d "$PROJECT_DIR"
cd "$PROJECT_DIR"
pwd
git status --short --branch
git rev-parse --short HEAD
test -f "$COMPOSE_FILE"

section "Required directories"
for dir in /opt/backup /opt/backups/wishlist "$PROJECT_DIR/logs/api" "$PROJECT_DIR/logs/bot"; do
  if [ -d "$dir" ]; then
    echo "ok: $dir"
  else
    echo "missing: $dir"
    exit 1
  fi
done

section "Docker"
docker --version
docker compose version
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

section "Compose config"
if [ -f "$PROJECT_DIR/.env" ]; then
  docker compose --env-file "$PROJECT_DIR/.env" -f "$COMPOSE_FILE" config >/tmp/wishlist-compose-vultr.out
else
  echo "WARN: $PROJECT_DIR/.env is not present yet; checking compose shape without env"
  docker compose -f "$COMPOSE_FILE" config >/tmp/wishlist-compose-vultr.out
fi
echo "compose config ok: /tmp/wishlist-compose-vultr.out"

section "Network listeners"
ss -lntp || true

section "Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw status verbose || true
else
  echo "ufw not installed"
fi

section "Telegram from host"
if curl -4 -fsS -m 10 https://api.telegram.org/ -o /dev/null; then
  echo "telegram IPv4 ok"
else
  echo "telegram IPv4 failed"
fi
if curl -6 -fsS -m 10 https://api.telegram.org/ -o /dev/null; then
  echo "telegram IPv6 ok"
else
  echo "telegram IPv6 failed or unavailable"
fi

section "Docker network dry check"
if docker image inspect curlimages/curl:8.10.1 >/dev/null 2>&1 || docker pull curlimages/curl:8.10.1 >/dev/null 2>&1; then
  docker run --rm curlimages/curl:8.10.1 -4 -fsS -m 10 https://api.telegram.org/ -o /dev/null && echo "container telegram IPv4 ok" || echo "container telegram IPv4 failed"
  docker run --rm curlimages/curl:8.10.1 -6 -fsS -m 10 https://api.telegram.org/ -o /dev/null && echo "container telegram IPv6 ok" || echo "container telegram IPv6 failed or unavailable"
else
  echo "WARN: cannot pull curlimages/curl, skipping container Telegram checks"
fi

section "nginx"
if command -v nginx >/dev/null 2>&1; then
  nginx -t || true
  systemctl is-active nginx || true
else
  echo "nginx not installed"
fi

section "Disk and memory"
df -h /
free -h
docker system df || true

section "Result"
echo "preflight complete"
