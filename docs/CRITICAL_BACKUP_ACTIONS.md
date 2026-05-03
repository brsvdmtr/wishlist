# CRITICAL_BACKUP_ACTIONS.md — Аварийный ручной чеклист

> Updated 2026-05-03: this is now an emergency/manual fallback checklist.
> Normal production backups run on Vultr via `/opt/wishlist/ops/backup.sh` and
> upload to Selectel/S3 — see [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md).

**Когда применять:** при аварийной ручной проверке, перед рискованными
инфраструктурными работами или при подозрении на сбой backup pipeline.
В обычном режиме используется регулярный pipeline:

- `/opt/wishlist/ops/backup.sh` → `/opt/backups/wishlist/wishlist_YYYYMMDD_HHMMSS.tar.gz` + `.sha256`
- Selectel/S3 upload через rclone (`wishlist-s3:wishlist-backups`)
- cron: ежедневно 03:00 UTC (см. [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md))

> SSH-доступ к Vultr: `ssh vultr` (алиас в `~/.ssh/config` на
> `~/.ssh/vultr_wishlist` + `199.247.24.125`).

---

## 1. Сделать дамп базы данных

**Риск:** Полная потеря всех данных пользователей (вишлисты, предметы, бронирования, комментарии).
**Время:** 1 минута.

```bash
ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125

mkdir -p /opt/backup
cd /opt/wishlist
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U wishlist -d wishlist \
  > /opt/backup/db_$(date +%Y%m%d_%H%M%S).sql

# Проверить размер (должен быть > 0):
ls -lh /opt/backup/db_*.sql
```

---

## 2. Скопировать .env файл

**Риск:** Потеря всех секретов (BOT_TOKEN, ADMIN_KEY, пароли). Невозможно восстановить без обращения в @BotFather.
**Время:** 30 секунд.

```bash
# С локальной машины:
scp -i ~/.ssh/vultr_wishlist \
  root@199.247.24.125:/opt/wishlist/.env \
  ~/backup_wishboard_env_$(date +%Y%m%d)

# Или на сервере:
cp /opt/wishlist/.env /opt/backup/env_$(date +%Y%m%d)
```

**Дополнительно:** сохранить BOT_TOKEN и ADMIN_KEY в менеджер паролей (1Password, Bitwarden и т.д.).

---

## 3. Скопировать загруженные фото

**Риск:** Потеря всех фотографий предметов. Пользователям придётся загружать заново.
**Время:** 1-5 минут (зависит от объёма).

```bash
ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125

mkdir -p /opt/backup/uploads_$(date +%Y%m%d)
cd /opt/wishlist
docker cp $(docker compose -f docker-compose.prod.yml ps -q api):/data/uploads/. \
  /opt/backup/uploads_$(date +%Y%m%d)/

# Проверить:
ls -la /opt/backup/uploads_$(date +%Y%m%d)/ | head -10
du -sh /opt/backup/uploads_$(date +%Y%m%d)/
```

---

## 4. Скопировать бэкапы на локальную машину

**Риск:** Если сервер умрёт, бэкапы на нём тоже пропадут. Бэкап на том же сервере — не бэкап.
**Время:** 2-10 минут.

```bash
# С локальной машины:
mkdir -p ~/wishboard_backup_$(date +%Y%m%d)

scp -i ~/.ssh/vultr_wishlist -r \
  root@199.247.24.125:/opt/backup/ \
  ~/wishboard_backup_$(date +%Y%m%d)/

# Проверить:
ls -la ~/wishboard_backup_$(date +%Y%m%d)/
```

---

## 5. Проверить SSL-сертификат

**Риск:** Сертификат истечёт → сайт перестанет открываться → Mini App в Telegram сломается.
**Время:** 30 секунд.

> **На 2026-05-03**: текущий cert валиден до **2026-07-16**, скопирован со старого
> Timeweb VPS вместе с миграцией. Авто-обновление certbot **не настроено на Vultr** —
> см. [KNOWN_GAPS_AND_RISKS.md](./KNOWN_GAPS_AND_RISKS.md) #28. Установить нужно
> до середины июля.

```bash
ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125

# Проверить дату истечения:
echo | openssl s_client -servername wishlistik.ru -connect wishlistik.ru:443 2>/dev/null \
  | openssl x509 -noout -enddate

# Установить certbot на Vultr (одноразовое действие до ~2026-07-16):
apt-get update && apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d wishlistik.ru -d www.wishlistik.ru

# После установки — проверить автообновление:
certbot renew --dry-run
systemctl is-enabled certbot.timer && systemctl is-active certbot.timer
```

---

## 6. Убедиться что git запушен

**Риск:** Незапушенные изменения на сервере будут потеряны.
**Время:** 1 минута.

```bash
ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125

cd /opt/wishlist
git status
git log --oneline -5

# Если есть незакоммиченные изменения (кроме .env):
# git add -A && git commit -m "backup uncommitted changes"
# git push origin main
```

---

## 7. Записать IP-адрес сервера

**Риск:** Если DNS-записи потеряются, нужно знать IP для восстановления.
**Время:** 10 секунд.

```bash
# С любой машины:
dig wishlistik.ru +short
# или
nslookup wishlistik.ru

# Записать результат в менеджер паролей или заметки:
# Сервер Vultr VPS: XX.XX.XX.XX
```

---

## 8. Скопировать nginx конфиг

**Риск:** При переустановке ОС конфиг nginx будет потерян. Без него сайт не заработает.
**Время:** 30 секунд.

```bash
ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125

cp /etc/nginx/sites-enabled/wishlistik.ru /opt/backup/nginx_$(date +%Y%m%d)
```

**Примечание:** конфиг также задокументирован в `docs/INFRA_AND_ENV.md` и `docs/RECOVERY_RUNBOOK.md`.

---

## 9. Настроить автоматический бэкап БД (cron)

**Риск:** Ручные бэкапы забываются. Без автоматизации потеря данных — вопрос времени.
**Время:** 2 минуты.

```bash
ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125

# Создать скрипт бэкапа:
cat > /opt/backup/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/backup"
DATE=$(date +%Y%m%d_%H%M%S)

# Дамп БД (используем docker compose exec для независимости от имён контейнеров)
cd /opt/wishlist && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U wishlist -d wishlist | gzip > "$BACKUP_DIR/db_$DATE.sql.gz"

# Удалить бэкапы старше 14 дней
find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime +14 -delete

echo "[$DATE] Backup completed: db_$DATE.sql.gz"
EOF

chmod +x /opt/backup/backup.sh

# Добавить в cron (каждый день в 3:00):
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/backup/backup.sh >> /opt/backup/backup.log 2>&1") | crontab -

# Проверить:
crontab -l
```

---

## 10. Проверить что всё работает

**Риск:** Можно думать что всё ок, а сервис уже лежит.
**Время:** 1 минута.

```bash
# Health check:
curl -s https://wishlistik.ru/api/health
# Ожидается: {"ok":true}

# Web:
curl -s -o /dev/null -w "%{http_code}" https://wishlistik.ru/
# Ожидается: 200

# Mini App:
curl -s -o /dev/null -w "%{http_code}" https://wishlistik.ru/miniapp
# Ожидается: 200

# Docker:
ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125 \
  "docker compose -f /opt/wishlist/docker-compose.prod.yml ps"
# Ожидается: все 4 сервиса running/healthy

# Бот:
# Открыть Telegram → найти @WishHub_bot → /start → должен ответить
```

---

## Чеклист для печати

```
[ ] 1. pg_dump базы данных              → /opt/backup/db_YYYYMMDD.sql
[ ] 2. Скопировать .env                 → локальная машина + менеджер паролей
[ ] 3. Скопировать uploads              → /opt/backup/uploads_YYYYMMDD/
[ ] 4. scp бэкапов на локальную машину  → ~/wishboard_backup_YYYYMMDD/
[ ] 5. Проверить SSL                    → certbot renew --dry-run
[ ] 6. Проверить git push               → git status + git push
[ ] 7. Записать IP сервера              → менеджер паролей
[ ] 8. Скопировать nginx конфиг         → /opt/backup/nginx_YYYYMMDD
[ ] 9. Настроить cron для авто-бэкапа   → crontab -l
[ ] 10. Smoke test всех сервисов        → curl health + Docker ps
```

---

## Сводка: что теряется без бэкапа

| Артефакт | Без бэкапа | С бэкапом |
|----------|-----------|-----------|
| Код | Восстановимо из GitHub | — |
| БД (пользователи, вишлисты) | **ПОТЕРЯ НАВСЕГДА** | Восстановление за 5 мин |
| Фото предметов | **ПОТЕРЯ НАВСЕГДА** | Восстановление за 5 мин |
| .env (секреты) | Частично восстановимо (BOT_TOKEN из @BotFather, остальное — генерировать заново) | Восстановление за 1 мин |
| Nginx конфиг | Восстановимо из docs | — |
| SSL-сертификат | certbot сгенерирует новый (~2 мин) | — |
