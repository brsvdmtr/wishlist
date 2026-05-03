# Weekly Ops Checklist

> 5 minutes, every Monday. Not optional.

## On the server

```bash
ssh vultr
```

### 1. Health

```bash
curl -s https://wishlistik.ru/api/health/deep | python3 -m json.tool
```

Expected: `"ok": true`, bot heartbeat `ageSec < 120`.

### 2. Containers

```bash
docker compose -f /opt/wishlist/docker-compose.prod.yml ps
```

Expected: all 4 containers `Up`, postgres `healthy`.

### 3. Last backup in Selectel

```bash
rclone ls wishlist-s3:wishlist-backups/ | tail -3
```

Expected: an archive from the last 24–48 hours, size > 0 and consistent with
previous backups (small variations are normal as the DB grows).

### 4. Local backups

```bash
ls -lht /opt/backups/wishlist/ | head -5
```

Expected: daily archives, oldest ~14 days. Verify checksum of the latest:

```bash
cd /opt/backups/wishlist && sha256sum -c $(ls -t wishlist_*.tar.gz.sha256 | head -1)
# Expected: wishlist_YYYYMMDD_HHMMSS.tar.gz: OK
```

### 5. Backup log

```bash
tail -20 /var/log/wishlist-backup.log
```

Expected: last run shows "Backup ... complete", upload complete, no errors.

### 6. Watchdog log

```bash
tail -10 /var/log/watchdog.log
```

Expected: recent `all healthy` entries, no alert loop.

### 7. Disk space

```bash
df -h / && docker system df
```

Expected: disk < 80%, Docker images reasonable.

### 8. Memory

```bash
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}"
```

Expected: API < 200MB, Bot < 100MB, Web < 100MB, Postgres < 200MB.

### 9. Cron is alive

```bash
crontab -l
```

Expected: 3 entries (watchdog, backup, docker prune).

---

## Red flags (act immediately)

- Health check returns non-200 → check logs, consider rollback
- Bot heartbeat > 120s → bot is zombie, restart: `./ops/deploy.sh bot`
- No backup in Selectel for 2+ days → check cron, check backup.sh manually
- Disk > 80% → `docker system prune -af --filter "until=72h"`
- Container restarting → `docker compose logs --tail 50 <service>`

---

## Monthly (first Monday of month)

- [ ] Run restore drill from Selectel backup (see [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md))
- [ ] Verify `sha256sum -c` on the latest archive in Selectel after `rclone copy`
- [ ] Check Selectel S3 billing
- [ ] Review docker image sizes — prune if > 10GB total
- [ ] Check SSL cert expiry: `echo | openssl s_client -connect wishlistik.ru:443 2>/dev/null | openssl x509 -noout -dates`
- [ ] Confirm the most recent S3 archive is < 24–48 hours old (catches a silent backup-pipeline regression)
