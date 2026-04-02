#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# WishBoard production deploy
#
# Usage:
#   ./ops/deploy.sh bot          # deploy bot only
#   ./ops/deploy.sh api          # deploy api (with maintenance window)
#   ./ops/deploy.sh web          # deploy web (with maintenance window)
#   ./ops/deploy.sh api web      # deploy multiple services
#   ./ops/deploy.sh all          # deploy api + web + bot
#
# Requires: run from /opt/wishlist on the production server
# ──────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="/opt/wishlist"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
DEPLOY_DIR="$PROJECT_DIR/.deploy"
HEALTH_URL="https://wishlistik.ru/api/health"
HEALTH_DEEP_URL="https://wishlistik.ru/api/health/deep"
BOT_HEARTBEAT_WAIT=75

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
fail() { echo -e "${RED}[deploy]${NC} $*" >&2; exit 1; }

# ── Parse arguments ───────────────────────────────────────────────────────────

VALID_SERVICES="api web bot"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <service...> | all"
  echo "Services: $VALID_SERVICES"
  exit 1
fi

SERVICES=()
if [ "$1" = "all" ]; then
  SERVICES=(api web bot)
else
  for arg in "$@"; do
    if ! echo "$VALID_SERVICES" | grep -qw "$arg"; then
      fail "Unknown service: $arg (valid: $VALID_SERVICES)"
    fi
    SERVICES+=("$arg")
  done
fi

HAS_BOT=false
NEEDS_MAINTENANCE=false
for s in "${SERVICES[@]}"; do
  [ "$s" = "bot" ] && HAS_BOT=true
  [[ "$s" = "api" || "$s" = "web" ]] && NEEDS_MAINTENANCE=true
done

log "Services to deploy: ${SERVICES[*]}"

# ── Pre-flight checks ────────────────────────────────────────────────────────

cd "$PROJECT_DIR"

[ -f .env ] || fail ".env not found in $PROJECT_DIR"

SHA=$(git rev-parse --short HEAD)
FULL_SHA=$(git rev-parse HEAD)
BRANCH=$(git branch --show-current)

log "Commit: $SHA ($BRANCH)"

mkdir -p "$DEPLOY_DIR"
echo "$FULL_SHA" > "$DEPLOY_DIR/last-attempted-release"

# ── Enable maintenance mode (api/web only) ────────────────────────────────────

if $NEEDS_MAINTENANCE; then
  log "Enabling MAINTENANCE_MODE (suppresses watchdog alerts)"
  "$PROJECT_DIR/ops/maintenance/on.sh"
fi

# ── Build ─────────────────────────────────────────────────────────────────────

log "Building: ${SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" build "${SERVICES[@]}"

# ── Deploy ────────────────────────────────────────────────────────────────────

log "Starting containers: ${SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" up -d "${SERVICES[@]}"

log "Waiting for containers to initialize..."
sleep 10

# ── Post-deploy checks ───────────────────────────────────────────────────────

log "Checking container status..."
docker compose -f "$COMPOSE_FILE" ps

echo ""
for s in "${SERVICES[@]}"; do
  log "Logs for $s (last 15 lines):"
  docker compose -f "$COMPOSE_FILE" logs --tail=15 "$s" 2>&1 | tail -15
  echo ""
done

log "Health check: $HEALTH_URL"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
if [ "$HTTP_STATUS" != "200" ]; then
  warn "Shallow health check returned HTTP $HTTP_STATUS"
  fail "Health check failed. MAINTENANCE_MODE is still ON. Investigate manually."
fi
log "  /health → $HTTP_STATUS ✓"

# For bot deploys: wait for heartbeat to refresh before deep check
if $HAS_BOT; then
  log "Bot deployed — waiting ${BOT_HEARTBEAT_WAIT}s for heartbeat to refresh..."
  sleep "$BOT_HEARTBEAT_WAIT"
fi

log "Deep health check: $HEALTH_DEEP_URL"
DEEP_RESPONSE=$(curl -s "$HEALTH_DEEP_URL" || true)
DEEP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_DEEP_URL" || true)

if [ "$DEEP_STATUS" != "200" ]; then
  warn "Deep health check returned HTTP $DEEP_STATUS"
  echo "$DEEP_RESPONSE"
  fail "Deep health check failed. MAINTENANCE_MODE is still ON. Investigate manually."
fi
log "  /health/deep → $DEEP_STATUS ✓"

# Parse bot heartbeat age from response
if $HAS_BOT; then
  BOT_AGE=$(echo "$DEEP_RESPONSE" | grep -o '"ageSec":[0-9]*' | head -1 | cut -d: -f2)
  if [ -n "$BOT_AGE" ] && [ "$BOT_AGE" -lt 120 ] 2>/dev/null; then
    log "  bot heartbeat: ${BOT_AGE}s ago ✓"
  else
    warn "Bot heartbeat age: ${BOT_AGE:-unknown}s"
    fail "Bot heartbeat stale or missing. MAINTENANCE_MODE is still ON."
  fi
fi

# ── Disable maintenance mode ──────────────────────────────────────────────────

if $NEEDS_MAINTENANCE; then
  log "Disabling MAINTENANCE_MODE"
  "$PROJECT_DIR/ops/maintenance/off.sh"

  # The Docker image has MAINTENANCE_MODE=true baked in (COPY . . includes .env).
  # off.sh only updates the host file. We must also patch the running container
  # and restart so the API process picks up MAINTENANCE_MODE=false.
  for s in "${SERVICES[@]}"; do
    if [[ "$s" = "api" ]]; then
      CONTAINER=$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null || true)
      if [ -n "$CONTAINER" ]; then
        docker exec "$CONTAINER" sed -i 's/MAINTENANCE_MODE=true/MAINTENANCE_MODE=false/' /app/.env 2>/dev/null || true
        log "Restarting api to apply MAINTENANCE_MODE=false..."
        docker compose -f "$COMPOSE_FILE" restart api
        sleep 5
        # Quick health re-check after restart
        RS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
        if [ "$RS" != "200" ]; then
          warn "Post-maintenance restart health check returned $RS"
        else
          log "  post-restart /health → $RS ✓"
        fi
      fi
    fi
  done
fi

# ── Record success ────────────────────────────────────────────────────────────

echo "$FULL_SHA" > "$DEPLOY_DIR/last-successful-release"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Deploy successful${NC}"
echo -e "${GREEN}  Commit:   $SHA ($BRANCH)${NC}"
echo -e "${GREEN}  Services: ${SERVICES[*]}${NC}"
echo -e "${GREEN}  Health:   /health ✓  /health/deep ✓${NC}"
if $HAS_BOT; then
echo -e "${GREEN}  Bot:      heartbeat ${BOT_AGE}s ✓${NC}"
fi
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
log "Smoke test reminder:"
log "  1. Open https://wishlistik.ru/miniapp in Telegram"
log "  2. Send /start to @WishHub_bot"
