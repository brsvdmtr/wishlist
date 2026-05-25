# SSL renewal — Vultr origin (wishlistik.ru)

**Last updated:** 2026-05-25

Origin nginx on Vultr (`199.247.24.125`) terminates TLS for traffic from
Cloudflare. Cloudflare maintains its own edge certificate for browser-facing
TLS; this doc covers **only the origin cert** issued by Let's Encrypt.

| | |
|--|--|
| Cert path | `/etc/letsencrypt/live/wishlistik.ru/fullchain.pem` |
| Key path | `/etc/letsencrypt/live/wishlistik.ru/privkey.pem` |
| Domains | `wishlistik.ru`, `www.wishlistik.ru` |
| Issuer | Let's Encrypt (ECDSA, intermediate E7/E8) |
| Renewal config | `/etc/letsencrypt/renewal/wishlistik.ru.conf` |
| Authenticator | `nginx` (HTTP-01 via Cloudflare passthrough) |
| Installer | `nginx` (in-place rewrite + reload) |
| Timer | `certbot.timer` (twice daily, systemd) |
| Deploy hook | `/etc/letsencrypt/renewal-hooks/deploy/01-nginx-reload.sh` (source: [ops/vultr/letsencrypt-deploy-hook.sh](../../ops/vultr/letsencrypt-deploy-hook.sh)) |
| Expiry monitor | Runs in-tree at [ops/vultr/ssl-expiry-monitor.sh](../../ops/vultr/ssl-expiry-monitor.sh) (no install step — matches watchdog/backup pattern). Cron entry in [ops/cron/root.crontab](../../ops/cron/root.crontab), 09:00 UTC daily. |
| Dedup state | `/var/lib/wishlist/ssl-monitor.last-bucket` (one of 14/7/3/0; auto-clears once `days_left > 14`) |
| Alert channel | Telegram bot → `ADMIN_ALERT_CHAT_IDS` from `/opt/wishlist/.env` (one ID or comma-separated; **no inline `# comment` syntax** on `BOT_TOKEN` / `ADMIN_ALERT_CHAT_IDS` lines — the comment is parsed as part of the value, alerts silently 404) |

The Cloudflare edge cert (visible to browsers) rotates automatically inside
Cloudflare. Nothing to do on our side; if a CF edge cert ever fails to renew,
the failure surfaces in the Cloudflare dashboard, not here.

---

## How HTTP-01 works through Cloudflare

DNS for `wishlistik.ru` is proxied through Cloudflare, and the Vultr firewall
only accepts ports 80/443 from CF edge ranges (see `ufw status`). HTTP-01
challenge requests from Let's Encrypt therefore hit Cloudflare first; CF
proxies `/.well-known/acme-challenge/*` to origin nginx unmodified, the
nginx authenticator answers, and the validation succeeds. This was verified
end-to-end with `certbot renew --dry-run` on 2026-05-25.

If Cloudflare is ever taken out of the path (DNS-only / removed), HTTP-01
will still work — LE will hit Vultr directly, and ufw allows port 80/443
from anywhere the DNS record points to. No certbot reconfiguration needed.

---

## Check current cert

```bash
# On Vultr (origin cert that nginx serves to Cloudflare):
ssh vultr "sudo openssl x509 -in /etc/letsencrypt/live/wishlistik.ru/fullchain.pem \
    -noout -subject -issuer -dates"

# Browser-visible cert (Cloudflare edge — independent of origin):
echo | openssl s_client -servername wishlistik.ru -connect wishlistik.ru:443 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates
```

Expected: origin issuer `Let's Encrypt`, edge issuer `Let's Encrypt` via
Cloudflare. If the edge issuer is `Cloudflare Inc ECC CA-3` or similar, CF
has fallen back to a Cloudflare-managed cert — still valid, no action needed.

---

## Manual renewal

```bash
# Dry-run first (no rate-limit impact, no cert change):
ssh vultr "sudo certbot renew --dry-run"

# Force a real renewal (use sparingly — 5 dup-cert/week LE limit):
ssh vultr "sudo certbot renew --force-renewal"

# After renewal, verify nginx picked up the new cert:
ssh vultr "sudo openssl x509 -in /etc/letsencrypt/live/wishlistik.ru/fullchain.pem -noout -dates"
ssh vultr "sudo journalctl -t certbot-deploy-hook -n 20 --no-pager"
```

The deploy hook (`01-nginx-reload.sh`) runs `nginx -t` and `systemctl reload
nginx` on every successful renewal. If `nginx -t` fails the hook exits
non-zero and **does not reload**, leaving the previous cert in service —
investigate before forcing a reload.

---

## Check the renewal timer

```bash
ssh vultr "systemctl list-timers certbot.timer"
ssh vultr "systemctl status certbot.timer"
ssh vultr "sudo journalctl -u certbot -n 50 --no-pager"
ssh vultr "sudo tail -100 /var/log/letsencrypt/letsencrypt.log"
```

Expected: `Trigger:` in a few hours, `Active: active (waiting)`, recent
log entries ending in `Certificate not yet due for renewal` (until <30 days
before expiry, at which point certbot actually renews).

There is also `/etc/cron.d/certbot` from the Debian package, but it self-
disables when `/run/systemd/system` exists (it does), so the systemd timer
is authoritative.

---

## Check the expiry monitor

```bash
# Last run (logs to syslog with tag ssl-monitor):
ssh vultr "sudo journalctl -t ssl-monitor -n 20 --no-pager"

# Force a run (alerts only if <=14 days AND a stricter bucket than last sent):
ssh vultr "sudo /opt/wishlist/ops/vultr/ssl-expiry-monitor.sh"

# Inspect dedup state (one of: 14, 7, 3, 0 — or file missing if days_left > 14):
ssh vultr "sudo cat /var/lib/wishlist/ssl-monitor.last-bucket 2>/dev/null || echo '(no state — healthy)'"

# Verify cron entry:
ssh vultr "sudo crontab -l | grep ssl-expiry-monitor && systemctl is-active cron"
```

To test the alert path without waiting for actual expiry, scripted
backup-and-restore — don't live-edit the monitor in place during an
incident:

```bash
SCRIPT=/opt/wishlist/ops/vultr/ssl-expiry-monitor.sh
ssh vultr "sudo cp $SCRIPT $SCRIPT.bak && \
    sudo sed -i 's/-le 14 \]/-le 999 ]/' $SCRIPT && \
    sudo rm -f /var/lib/wishlist/ssl-monitor.last-bucket"

# First run — expect Telegram alert + state file written:
ssh vultr "sudo $SCRIPT"
ssh vultr "sudo cat /var/lib/wishlist/ssl-monitor.last-bucket"   # must show 14

# Second run — expect skip (dedup):
ssh vultr "sudo $SCRIPT && sudo journalctl -t ssl-monitor -n 3 --no-pager"

# Restore (script is in-tree but the test mutated it; `git checkout` also works):
ssh vultr "sudo mv $SCRIPT.bak $SCRIPT && \
    sudo rm -f /var/lib/wishlist/ssl-monitor.last-bucket"
```

The snippet above exercises the `[NOTICE]` head (14d bucket). To also
exercise `[URGENT]` (3d) and `[EXPIRED]` (0d) — the heads on-call most
needs to recognize on sight — repeat with stricter cutoffs:

```bash
# Re-backup, swap a stricter arm, clear state, run, restore:
ssh vultr "sudo cp $SCRIPT $SCRIPT.bak && \
    sudo sed -i 's/-le 3 \]/-le 999 ]/' $SCRIPT && \
    sudo rm -f /var/lib/wishlist/ssl-monitor.last-bucket && \
    sudo $SCRIPT && \
    sudo mv $SCRIPT.bak $SCRIPT"
# Same with `-le 0` for [EXPIRED].
```

The second run is only idempotent if the first run actually delivered to
Telegram (HTTP 200) — that is what writes the state file. If
`/var/lib/wishlist/ssl-monitor.last-bucket` is missing after the first
run, delivery failed (rate-limit, bot down, wrong chat ID, missing env)
and the script will keep retrying daily. Fix delivery first; the test
does not prove dedup until the state file appears.

---

## Quarterly verification — prove the alert path is still wired

Every 90 days, run the test snippet above. The most common silent-rot
mode is a stale `ADMIN_ALERT_CHAT_IDS` in `/opt/wishlist/.env`
(operator left the chat, bot kicked, ID typo) — the monitor would log
`http=403` or `http=400` per chat and never deliver, but nothing would
page anyone about the broken pager. Calendar it.

---

## Rollback

If a renewal goes wrong (bad cert installed, nginx refuses to reload, edge
TLS breaks):

```bash
# 1. List archived versions (most recent suffix = current):
ssh vultr "sudo ls -la /etc/letsencrypt/archive/wishlistik.ru/"

# 2. Repoint live symlinks to previous version. Example: roll back from
#    cert3.pem to cert2.pem. Repeat for chain/fullchain/privkey.
ssh vultr "sudo ln -sf ../../archive/wishlistik.ru/cert2.pem \
    /etc/letsencrypt/live/wishlistik.ru/cert.pem"
ssh vultr "sudo ln -sf ../../archive/wishlistik.ru/chain2.pem \
    /etc/letsencrypt/live/wishlistik.ru/chain.pem"
ssh vultr "sudo ln -sf ../../archive/wishlistik.ru/fullchain2.pem \
    /etc/letsencrypt/live/wishlistik.ru/fullchain.pem"
ssh vultr "sudo ln -sf ../../archive/wishlistik.ru/privkey2.pem \
    /etc/letsencrypt/live/wishlistik.ru/privkey.pem"

# 3. Test + reload nginx:
ssh vultr "sudo nginx -t && sudo systemctl reload nginx"

# 4. Verify the cert nginx now serves:
ssh vultr "sudo openssl x509 -in /etc/letsencrypt/live/wishlistik.ru/fullchain.pem -noout -dates"
```

If the issue is the renewal config itself (e.g. an `authenticator` change
broke HTTP-01), restore from the package default:

```bash
ssh vultr "sudo cat /etc/letsencrypt/renewal/wishlistik.ru.conf"
# Edit by hand; the file is plain INI. Key fields:
#   authenticator = nginx
#   installer = nginx
#   server = https://acme-v02.api.letsencrypt.org/directory
```

If the entire LE account is hosed, `sudo certbot certonly --nginx -d
wishlistik.ru -d www.wishlistik.ru` re-bootstraps from scratch.

---

## Failure modes seen in this stack

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Server: cloudflare` + 404 on `/.well-known/acme-challenge/...` from origin | Normal — nginx serves 404 when no challenge is in flight | Ignore unless certbot also fails |
| Dry-run fails with `Connection refused` | DNS is in CF DNS-only mode (gray cloud), so LE hits Vultr directly and ufw drops it | Re-enable CF proxy mode (orange cloud) — that is the supported path. Do **not** open ports 80/443 to `0.0.0.0/0` as a workaround unless you have an explicit `trap` to re-close them in the same shell session (`sudo ufw allow 80,443/tcp comment 'TEMP-LE-RENEW'; sudo certbot renew; sudo ufw delete allow 80,443/tcp`). A left-open firewall is the way you find out about the next incident. |
| Renewal succeeds but browsers still see old cert | CF edge caching — purge in CF dashboard, or wait ~24h | Origin cert in browser-visible chain only matters if CF is in DNS-only mode |
| `certbot renew` says "not yet due" forever | `renew_before_expiry` is 30 days; certbot is intentionally lazy | Force with `--force-renewal` only if you have an actual reason |

---

## Bootstrap from repo (rebuild on a new host)

The shell scripts and cron entries in this runbook are tracked in the repo;
they run in-tree under `/opt/wishlist/ops/vultr/` (matching the
`ops/watchdog/` and `ops/backup.sh` patterns) so `git pull` is the
deploy. The one exception is the certbot deploy hook, which certbot
hard-codes to live under `/etc/letsencrypt/renewal-hooks/deploy/` — it
must be installed explicitly. To rebuild the wiring on a fresh host:

```bash
# 1. State dir for the monitor's bucket-dedup file:
ssh vultr "sudo mkdir -p /var/lib/wishlist"

# 2. Deploy hook — pinned ownership so a non-root file in the renewal-hooks
#    dir can't escalate to root on next renewal:
ssh vultr "sudo install -o root -g root -m 755 \
    /opt/wishlist/ops/vultr/letsencrypt-deploy-hook.sh \
    /etc/letsencrypt/renewal-hooks/deploy/01-nginx-reload.sh"

# 3. Cron — the SSL monitor line lives in the canonical root crontab.
#    Apply the whole file (it also contains watchdog/backup/prune):
ssh vultr "sudo crontab -l > /tmp/cron.bak.\$(date +%Y%m%d-%H%M%S) && \
    sudo crontab /opt/wishlist/ops/cron/root.crontab && sudo crontab -l"

# 4. Sanity:
ssh vultr "sudo certbot renew --dry-run"
ssh vultr "sudo /opt/wishlist/ops/vultr/ssl-expiry-monitor.sh"
ssh vultr "sudo journalctl -t ssl-monitor -n 5 --no-pager"
```

To verify the deploy hook end-to-end (fires the hook even on dry-run in
certbot ≥ 2.0):

```bash
ssh vultr "sudo certbot renew --dry-run --deploy-hook \
    /etc/letsencrypt/renewal-hooks/deploy/01-nginx-reload.sh"
ssh vultr "sudo journalctl -t certbot-deploy-hook --since '5 minutes ago' --no-pager"
```

If you edit `ops/vultr/ssl-expiry-monitor.sh` or `ops/cron/root.crontab`,
the next `git pull` (or `git checkout`) on the server picks it up — no
re-install. If you edit `ops/vultr/letsencrypt-deploy-hook.sh`, re-run
step 2 because the installed copy is a snapshot.

---

## Related

- `docs/INFRA_AND_ENV.md` — full env-var inventory (`BOT_TOKEN`, `ADMIN_ALERT_CHAT_IDS`)
- `docs/DEPLOYMENT_RUNBOOK.md` — deploy flow and post-deploy health checks
- `~/.claude/projects/-Users-dmitriy-Wishlist/memory/deploy_server.md` — server / SSH alias
