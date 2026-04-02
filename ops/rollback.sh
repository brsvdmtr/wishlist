#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# WishBoard production rollback
#
# Usage:
#   ./ops/rollback.sh bot        # rollback bot to last successful release
#   ./ops/rollback.sh api web    # rollback api and web
#   ./ops/rollback.sh all        # rollback everything
#
# Reads the last known-good commit SHA from .deploy/last-successful-release,
# checks out that code, rebuilds the specified services, runs health checks,
# and returns the repo to main.
# ──────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="/opt/wishlist"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
DEPLOY_DIR="$PROJECT_DIR/.deploy"
RELEASE_FILE="$DEPLOY_DIR/last-successful-release"
HEALTH_URL="https://wishlistik.ru/api/health"
HEALTH_DEEP_URL="https://wishlistik.ru/api/health/deep"
BOT_HEARTBEAT_WAIT=75

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[rollback]${NC} $*"; }
warn() { echo -e "${YELLOW}[rollback]${NC} $*"; }
fail() { echo -e "${RED}[rollback]${NC} $*" >&2; exit 1; }

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

# ── Read last successful release ──────────────────────────────────────────────

cd "$PROJECT_DIR"

if [ ! -f "$RELEASE_FILE" ]; then
  fail "No last-successful-release found at $RELEASE_FILE. Cannot rollback."
fi

TARGET_SHA=$(cat "$RELEASE_FILE")
CURRENT_SHA=$(git rev-parse HEAD)
SHORT_TARGET=$(echo "$TARGET_SHA" | cut -c1-7)
SHORT_CURRENT=$(git rev-parse --short HEAD)

if [ "$TARGET_SHA" = "$CURRENT_SHA" ]; then
  fail "Already on last successful release ($SHORT_TARGET). Nothing to rollback."
fi

log "Rolling back: ${SERVICES[*]}"
log "  Current:  $SHORT_CURRENT"
log "  Target:   $SHORT_TARGET"

# ── Enable maintenance mode ──────────────────────────────────────────────────

if $NEEDS_MAINTENANCE; then
  log "Enabling MAINTENANCE_MODE"
  "$PROJECT_DIR/ops/maintenance/on.sh"
fi

# ── Checkout target SHA ───────────────────────────────────────────────────────

log "Checking out $SHORT_TARGET..."
git checkout "$TARGET_SHA" -- .

# ── Build & deploy ────────────────────────────────────────────────────────────

log "Building: ${SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" build "${SERVICES[@]}"

log "Starting containers: ${SERVICES[*]}"
docker compose -f "$COMPOSE_FILE" up -d "${SERVICES[@]}"

log "Waiting for containers to initialize..."
sleep 10

# ── Health checks ─────────────────────────────────────────────────────────────

log "Checking container status..."
docker compose -f "$COMPOSE_FILE" ps

log "Health check: $HEALTH_URL"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)
if [ "$HTTP_STATUS" != "200" ]; then
  warn "Health check returned HTTP $HTTP_STATUS"
  fail "Rollback health check failed. Manual intervention required."
fi
log "  /health → $HTTP_STATUS ✓"

if $HAS_BOT; then
  log "Bot rolled back — waiting ${BOT_HEARTBEAT_WAIT}s for heartbeat..."
  sleep "$BOT_HEARTBEAT_WAIT"
fi

log "Deep health check: $HEALTH_DEEP_URL"
DEEP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_DEEP_URL" || true)
if [ "$DEEP_STATUS" != "200" ]; then
  warn "Deep health check returned HTTP $DEEP_STATUS"
  fail "Rollback deep health check failed. Manual intervention required."
fi
log "  /health/deep → $DEEP_STATUS ✓"

# ── Disable maintenance mode ──────────────────────────────────────────────────

if $NEEDS_MAINTENANCE; then
  log "Disabling MAINTENANCE_MODE"
  "$PROJECT_DIR/ops/maintenance/off.sh"

  # The Docker image has MAINTENANCE_MODE=true baked in (COPY . . includes .env).
  # off.sh only updates the host file. Patch the running container and restart.
  for s in "${SERVICES[@]}"; do
    if [[ "$s" = "api" ]]; then
      CONTAINER=$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null || true)
      if [ -n "$CONTAINER" ]; then
        docker exec "$CONTAINER" sed -i 's/MAINTENANCE_MODE=true/MAINTENANCE_MODE=false/' /app/.env 2>/dev/null || true
        log "Restarting api to apply MAINTENANCE_MODE=false..."
        docker compose -f "$COMPOSE_FILE" restart api
        sleep 5
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

# ── Return to main branch ────────────────────────────────────────────────────

log "Restoring repo to main branch..."
git checkout main -- .

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Rollback successful${NC}"
echo -e "${GREEN}  Rolled back to: $SHORT_TARGET${NC}"
echo -e "${GREEN}  Services:       ${SERVICES[*]}${NC}"
echo -e "${GREEN}  Health:         /health ✓  /health/deep ✓${NC}"
echo -e "${GREEN}  Repo:           restored to main${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
warn "The repo is on main but containers run code from $SHORT_TARGET."
warn "Fix the issue on main, then deploy again with: ./ops/deploy.sh ${SERVICES[*]}"
