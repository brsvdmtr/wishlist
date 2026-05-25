#!/usr/bin/env bash
# Defense-in-depth: reload nginx after certbot renews any cert.
# certbot installer=nginx already reloads, but this hook fires even if
# config drifts (e.g. someone changes installer or runs `certonly`).
# Logs to syslog and pages Telegram on any failure — a silent reload
# failure means nginx serves the previous cert until the next renewal
# cycle 60 days later catches it.
#
# Install on Vultr (root):
#   sudo install -o root -g root -m 755 \
#       /opt/wishlist/ops/vultr/letsencrypt-deploy-hook.sh \
#       /etc/letsencrypt/renewal-hooks/deploy/01-nginx-reload.sh

set -euo pipefail

ENV_FILE=/opt/wishlist/.env

logger -t certbot-deploy-hook -- "renewed lineage=${RENEWED_LINEAGE:-?} domains=${RENEWED_DOMAINS:-?}"

# Targeted .env reader — pulls one value, trims one pair of surrounding
# quotes and ASCII whitespace. Avoids sourcing the whole file (which
# would export DB creds, payment-provider keys, etc. into this process)
# and dodges docker-env-vs-shell parsing quirks.
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

# Chat IDs are weakly sensitive (the address Telegram uses to deliver
# to a specific chat). Log only the last 4 chars so syslog shipping to
# external systems doesn't leak the full ID.
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
        logger -t certbot-deploy-hook -p user.err -- "cannot alert: BOT_TOKEN or ADMIN_ALERT_CHAT_IDS missing/empty in $ENV_FILE"
        return 0
    fi
    local ids
    IFS=',' read -ra ids <<< "$chat_ids"
    for chat_id in "${ids[@]}"; do
        chat_id=$(printf '%s' "$chat_id" | tr -d '[:space:]')
        if [ -z "$chat_id" ]; then continue; fi
        http_code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
            "https://api.telegram.org/bot${bot_token}/sendMessage" \
            --data-urlencode "chat_id=${chat_id}" \
            --data-urlencode "text=${msg}" || echo "000")
        logger -t certbot-deploy-hook -- "alert chat=$(chat_tag "$chat_id") http=${http_code}"
    done
}

NGINX_T_OUT=$(mktemp)
trap 'rm -f "$NGINX_T_OUT"' EXIT

if ! nginx -t > "$NGINX_T_OUT" 2>&1; then
    while IFS= read -r line || [ -n "$line" ]; do
        logger -t certbot-deploy-hook -p user.err -- "$line"
    done < "$NGINX_T_OUT"
    logger -t certbot-deploy-hook -p user.err -- "nginx -t FAILED; new cert installed but nginx NOT reloaded — serving previous cert until fixed"
    alert_telegram "[URGENT] certbot deploy hook on wishlistik.ru: nginx -t FAILED after cert renewal. New cert on disk but nginx was NOT reloaded. Triage: ssh vultr 'sudo nginx -t'"
    exit 1
fi

while IFS= read -r line || [ -n "$line" ]; do
    logger -t certbot-deploy-hook -- "$line"
done < "$NGINX_T_OUT"

if ! systemctl reload nginx; then
    logger -t certbot-deploy-hook -p user.err -- "systemctl reload nginx FAILED after green nginx -t"
    alert_telegram "[URGENT] certbot deploy hook on wishlistik.ru: systemctl reload nginx FAILED despite green config test. Triage: ssh vultr 'sudo systemctl status nginx && sudo journalctl -u nginx -n 50'"
    exit 1
fi

logger -t certbot-deploy-hook -- "nginx reloaded after cert renewal"
