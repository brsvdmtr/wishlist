#!/usr/bin/env bash
# Daily check of origin Let's Encrypt cert expiry. Alerts the Telegram
# admin chat once per threshold bucket (14d → 7d → 3d → expired) — never
# every-day spam. State persists in /var/lib/wishlist/ssl-monitor.last-bucket
# and auto-clears once a renewal pushes days_left back above 14, so the
# next cycle alerts fresh. Successful Telegram delivery (HTTP 200) is
# required before the state file is written, so a network outage does
# not silently "ack" an undelivered alert.
#
# Cloudflare edge cert is not checked here — CF rotates it on its own
# schedule.
#
# Runs directly from /opt/wishlist/ops/vultr/ — no install step.
# Invoked from /opt/wishlist/ops/cron/root.crontab.

set -euo pipefail

CERT=/etc/letsencrypt/live/wishlistik.ru/fullchain.pem
ENV_FILE=/opt/wishlist/.env
DOMAIN=wishlistik.ru
STATE_FILE=/var/lib/wishlist/ssl-monitor.last-bucket

mkdir -p "$(dirname "$STATE_FILE")"

read_env_var() {
    local v
    v=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
    case "$v" in
        \"*\") v="${v#\"}"; v="${v%\"}" ;;
        \'*\') v="${v#\'}"; v="${v%\'}" ;;
    esac
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    printf '%s' "$v"
}

chat_tag() {
    local s="$1"
    if [ "${#s}" -le 4 ]; then printf '*%s' "$s"; else printf '...%s' "${s: -4}"; fi
}

alert_telegram() {
    local msg="$1"
    local bot_token chat_ids chat_id http_code
    bot_token=$(read_env_var BOT_TOKEN)
    chat_ids=$(read_env_var ADMIN_ALERT_CHAT_IDS)
    if [ -z "$bot_token" ] || [ -z "$chat_ids" ]; then
        logger -t ssl-monitor -p user.err -- "cannot alert: BOT_TOKEN or ADMIN_ALERT_CHAT_IDS missing/empty in $ENV_FILE"
        return 1
    fi
    local ids sent=0
    IFS=',' read -ra ids <<< "$chat_ids"
    for chat_id in "${ids[@]}"; do
        chat_id=$(printf '%s' "$chat_id" | tr -d '[:space:]')
        if [ -z "$chat_id" ]; then continue; fi
        http_code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
            "https://api.telegram.org/bot${bot_token}/sendMessage" \
            --data-urlencode "chat_id=${chat_id}" \
            --data-urlencode "text=${msg}" || echo "000")
        logger -t ssl-monitor -- "alert chat=$(chat_tag "$chat_id") http=${http_code}"
        if [ "$http_code" = "200" ]; then sent=$((sent + 1)); fi
    done
    if [ "$sent" -eq 0 ]; then return 1; fi
    return 0
}

fail_with_alert() {
    local msg="$1"
    logger -t ssl-monitor -p user.err -- "$msg"
    alert_telegram "[MONITOR-BROKEN] $DOMAIN: $msg" || true
    exit 1
}

if [ ! -r "$CERT" ]; then
    fail_with_alert "cert file unreadable: $CERT"
fi

NOT_AFTER_RAW=$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2 || true)
if [ -z "$NOT_AFTER_RAW" ]; then
    fail_with_alert "openssl returned empty enddate for $CERT"
fi

if ! NOT_AFTER_EPOCH=$(date -d "$NOT_AFTER_RAW" +%s 2>/dev/null); then
    fail_with_alert "date -d failed to parse openssl enddate: '$NOT_AFTER_RAW'"
fi

NOW_EPOCH=$(date +%s)
DAYS_LEFT=$(( (NOT_AFTER_EPOCH - NOW_EPOCH) / 86400 ))

logger -t ssl-monitor -- "cert $DOMAIN days_left=$DAYS_LEFT"

# Smaller bucket = more urgent. Alert once per bucket entry; reset state
# when days_left > 14 (post-renewal) so the next expiry cycle alerts fresh.
if   [ "$DAYS_LEFT" -le 0 ];  then BUCKET=0;  HEAD=EXPIRED
elif [ "$DAYS_LEFT" -le 3 ];  then BUCKET=3;  HEAD=URGENT
elif [ "$DAYS_LEFT" -le 7 ];  then BUCKET=7;  HEAD=WARN
elif [ "$DAYS_LEFT" -le 14 ]; then BUCKET=14; HEAD=NOTICE
else
    rm -f "$STATE_FILE"
    exit 0
fi

LAST_BUCKET=$(cat "$STATE_FILE" 2>/dev/null || echo 99)
case "$LAST_BUCKET" in
    ''|*[!0-9]*) LAST_BUCKET=99 ;;
esac

if [ "$BUCKET" -ge "$LAST_BUCKET" ]; then
    logger -t ssl-monitor -- "bucket=$BUCKET already alerted (last=$LAST_BUCKET); skipping"
    exit 0
fi

MSG="[$HEAD] SSL origin cert $DOMAIN: ${DAYS_LEFT}d left.
Triage:      ssh vultr 'sudo journalctl -u certbot --since=72h --no-pager | tail -50'
Force renew: ssh vultr 'sudo certbot renew --force-renewal'
Doc:         docs/ops/ssl-renewal.md"

if alert_telegram "$MSG"; then
    echo "$BUCKET" > "$STATE_FILE"
fi
