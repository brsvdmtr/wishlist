# WishBoard Vultr Migration Runbook

> Status: completed on 2026-05-03. Production now runs on Vultr Amsterdam
> `199.247.24.125`. The old Timeweb VPS `31.130.149.249` was decommissioned
> from runtime and can be deleted as a VPS/server.

## Current Production State

| Area | Current value |
|------|---------------|
| Production host | Vultr Amsterdam VPS `199.247.24.125` |
| Project path | `/opt/wishlist` |
| Domain | `wishlistik.ru`, `www.wishlistik.ru` |
| DNS A records | both point to `199.247.24.125` |
| Runtime | `postgres`, `api`, `web`, `bot` via Docker Compose |
| API/Web exposure | only through nginx; direct `3000/3001` bind to `127.0.0.1` |
| Backups | local `/opt/backups/wishlist` + Selectel/S3 `wishlist-s3:wishlist-backups` |
| Deploy/Ops | GitHub Actions secrets target Vultr |
| Old Timeweb VPS | runtime stopped, crontab removed |

## What Was Migrated

- PostgreSQL production database.
- Uploads Docker volume.
- Production `.env`.
- TLS certificates and nginx site.
- Docker images/runtime for `api`, `web`, and `bot`.
- GitHub Actions deploy/admin-ops target.
- Backup cron, watchdog cron, and Docker prune cron.
- Operational documentation.

## Final Verified Checks

Migration was considered complete after these checks passed:

```bash
curl -fsS https://wishlistik.ru/api/health
curl -fsS -o /dev/null -w 'miniapp=%{http_code}\n' https://wishlistik.ru/miniapp
gh workflow run admin-ops.yml -R brsvdmtr/wishlist -f action=health-check
```

Verified results on 2026-05-03:

- API health: `ok:true`, `maintenance:false`.
- Mini App route: HTTP `200`.
- Containers on Vultr: `postgres`, `api`, `web`, `bot` all `Up`.
- Bot polling: `getMe ok`.
- Bot heartbeat: fresh in `ServiceHeartbeat`.
- Failed Prisma migrations: `0`.
- Users restored: `369`.
- Uploads restored: `80` files.
- GitHub Actions deploy to Vultr succeeded.
- GitHub Actions admin health-check to Vultr succeeded.
- Direct external `199.247.24.125:3000/3001` blocked.
- Local backup on Vultr created successfully.
- Selectel/S3 backup upload from Vultr verified by remote size.

## Backup Verification

Manual backup test run on Vultr:

```bash
ssh -i ~/.ssh/timeweb_wishlist root@199.247.24.125
cd /opt/wishlist
/opt/wishlist/ops/backup.sh
cd /opt/backups/wishlist
sha256sum -c wishlist_YYYYMMDD_HHMMSS.tar.gz.sha256
rclone ls wishlist-s3:wishlist-backups/ | tail -5
```

Known verified archive from migration day:

```text
/opt/backups/wishlist/wishlist_20260503_144939.tar.gz
wishlist-s3:wishlist-backups/wishlist_20260503_144939.tar.gz
```

## Vultr Cron

Production crontab on Vultr:

```cron
*/5 * * * * node /opt/wishlist/ops/watchdog/health-watchdog.mjs >> /var/log/watchdog.log 2>&1
0 3 * * * /opt/wishlist/ops/backup.sh >> /var/log/wishlist-backup.log 2>&1
0 4 * * 0 docker system prune -af --filter "until=168h" >> /var/log/docker-prune.log 2>&1
```

Weekly check:

```bash
ssh -i ~/.ssh/timeweb_wishlist root@199.247.24.125
crontab -l
tail -20 /var/log/wishlist-backup.log
tail -20 /var/log/watchdog.log
rclone ls wishlist-s3:wishlist-backups/ | tail -5
```

## Timeweb Decommission State

Old VPS: `31.130.149.249`.

Actions completed on 2026-05-03:

- DNS switched away from Timeweb to Vultr.
- `api`, `web`, `bot`, and `postgres` containers stopped.
- Old crontab saved to `/root/crontab.wishlist.decommissioned.20260503`.
- Old crontab removed.

Conclusion: the Timeweb VPS/server can be deleted. Do not delete the domain or
DNS account if `wishlistik.ru` is still managed through the Timeweb panel.

## Rollback Notes

Rollback to Timeweb is no longer a simple DNS flip after users have written to
Vultr. If a rollback is ever needed:

1. Freeze Vultr runtime.
2. Create a fresh Vultr backup with `/opt/wishlist/ops/backup.sh`.
3. Restore that backup onto a replacement server.
4. Point DNS to the replacement server.
5. Run GitHub Actions `admin-ops health-check`.

Do not restart the old Timeweb runtime blindly; its database is stale after the
Vultr cutover.

## Related Docs

- [INFRA_AND_ENV.md](./INFRA_AND_ENV.md)
- [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md)
- [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)
- [WEEKLY_OPS_CHECKLIST.md](./WEEKLY_OPS_CHECKLIST.md)
