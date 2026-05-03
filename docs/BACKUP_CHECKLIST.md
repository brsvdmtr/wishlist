# BACKUP_CHECKLIST.md — Полный чеклист бэкапов WishBoard

> Updated 2026-05-03: production runs on Vultr `199.247.24.125`; daily local
> backups and Selectel/S3 upload are configured and manually verified.

---

## 1. Исходный код

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Git-репозиторий | GitHub: `brsvdmtr/wishlist` | Автоматически при `git push` | OK |
| Ветка `main` | GitHub | `git push origin main` | OK |
| Ветка `main` | GitHub | Проверить: все ли изменения мержатся в main? | ВНИМАНИЕ |
| Локальная копия | Рабочая машина разработчика | `git clone` на второе устройство | Рекомендуется |

**Действие:**
```bash
# Убедиться, что все изменения запушены:
cd /opt/wishlist
git status
git push origin main
```

---

## 2. База данных (PostgreSQL)

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Все данные (users, wishlists, items, comments, reservations) | Docker volume `wishlist-prod_wishlist_pg_data` | `ops/backup.sh` (`pg_dump --format=custom`) | OK |
| Схема БД (Prisma) | `packages/db/prisma/schema.prisma` | В git | OK |
| Миграции | `packages/db/prisma/migrations/` | В git | OK |

**Ручной бэкап:**
```bash
# На Vultr:
cd /opt/wishlist
/opt/wishlist/ops/backup.sh

# Проверить архив и checksum:
ls -lht /opt/backups/wishlist/ | head
cd /opt/backups/wishlist && sha256sum -c wishlist_YYYYMMDD_HHMMSS.tar.gz.sha256
```

**Автоматизация (cron):**
```bash
0 3 * * * /opt/wishlist/ops/backup.sh >> /var/log/wishlist-backup.log 2>&1
```

---

## 3. Загруженные файлы (фото)

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Оригиналы фото (JPEG, сжатые Sharp) | Docker volume `wishlist-prod_wishlist_uploads` | `ops/backup.sh` (`uploads.tar`) | OK |
| Тамбнейлы | Тот же volume | `ops/backup.sh` (`uploads.tar`) | OK |

**Ручной бэкап:**
```bash
cd /opt/wishlist
/opt/wishlist/ops/backup.sh
tar -tf /opt/backups/wishlist/wishlist_YYYYMMDD_HHMMSS.tar.gz | grep uploads.tar
```

**Автоматизация (cron):**
```bash
0 3 * * * /opt/wishlist/ops/backup.sh >> /var/log/wishlist-backup.log 2>&1
```

---

## 4. Секреты и переменные окружения

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| `.env` (production) | `/opt/wishlist/.env` на Vultr | Входит в `ops/backup.sh` archive as `dot-env` | OK |
| `.env.example` (шаблон) | В git | Автоматически | OK |
| `BOT_TOKEN` | `.env` + @BotFather в Telegram | Сохранить в менеджер паролей | КРИТИЧНО |
| `ADMIN_KEY` | `.env` | Сохранить в менеджер паролей | КРИТИЧНО |
| `POSTGRES_PASSWORD` | `.env` | Сохранить в менеджер паролей | КРИТИЧНО |
| `ADMIN_BASIC_PASS` | `.env` | Сохранить в менеджер паролей | КРИТИЧНО |

**Действие:**
```bash
# Скопировать .env на локальную машину:
scp -i ~/.ssh/timeweb_wishlist root@199.247.24.125:/opt/wishlist/.env ./backup_env_$(date +%Y%m%d)

# Или зашифровать на сервере:
gpg --symmetric --cipher-algo AES256 /opt/wishlist/.env
# -> /opt/wishlist/.env.gpg (скопировать этот файл)
```

---

## 5. Конфигурации инфраструктуры

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Nginx конфиг | `/etc/nginx/sites-enabled/wishlistik.ru` | Ручное копирование (также в docs) | Документировано |
| Docker Compose (prod) | `docker-compose.prod.yml` в git | Автоматически | OK |
| Dockerfiles (3 шт.) | `Dockerfile.api`, `.web`, `.bot` в git | Автоматически | OK |
| SSL-сертификаты | `/etc/letsencrypt/live/wishlistik.ru/` | Let's Encrypt (авто-обновление certbot) | ПРОВЕРИТЬ |
| Certbot конфиг | `/etc/letsencrypt/` | `tar` целой директории | Рекомендуется |

**Действие:**
```bash
# Бэкап nginx + certbot:
cp /etc/nginx/sites-enabled/wishlistik.ru /opt/backup/nginx_$(date +%Y%m%d)
tar czf /opt/backup/letsencrypt_$(date +%Y%m%d).tar.gz /etc/letsencrypt/

# Проверить авто-обновление SSL:
certbot renew --dry-run
```

---

## 6. Интеграции с Telegram

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Bot Token | @BotFather + `.env` | Записать в менеджер паролей | КРИТИЧНО |
| Bot Username | @BotFather | Запомнить: `WishHub_bot` | OK |
| Menu Button URL | Устанавливается ботом при /start | Код в `apps/bot/src/index.ts` | OK |
| Mini App URL | @BotFather настройки | `https://wishlistik.ru/miniapp` | Документировано |
| Webhook/Polling | Polling (код) | Автоматически | OK |

**Чеклист Telegram:**
- [ ] Bot Token сохранён в менеджере паролей
- [ ] Bot Username документирован (`WishHub_bot`)
- [ ] Mini App URL в @BotFather: `https://wishlistik.ru/miniapp`
- [ ] Menu button URL: `https://wishlistik.ru/miniapp`
- [ ] Бот использует long polling (НЕ webhook)

---

## 7. Домен и SSL

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Домен `wishlistik.ru` | Регистратор/DNS-панель | Записать логин/пароль от панели | КРИТИЧНО |
| DNS A-запись | Панель регистратора | IP сервера -> документировать | Рекомендуется |
| SSL-сертификат | Let's Encrypt (certbot) | Авто-обновление каждые 90 дней | ПРОВЕРИТЬ |
| SSH-ключ для сервера | `~/.ssh/timeweb_wishlist` | Должен быть на локальной машине | OK |

**Действие:**
```bash
# Проверить текущий IP сервера:
dig wishlistik.ru +short

# Проверить срок SSL:
echo | openssl s_client -servername wishlistik.ru -connect wishlistik.ru:443 2>/dev/null | openssl x509 -noout -dates

# Проверить автообновление certbot:
systemctl status certbot.timer
certbot renew --dry-run
```

---

## 8. Скрипты развёртывания

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Процедура деплоя | `docs/INFRA_AND_ENV.md` | В git | OK |
| Recovery runbook | `docs/RECOVERY_RUNBOOK.md` | В git | OK |
| Build команды | `docker-compose.prod.yml` | В git | OK |
| pnpm scripts | `package.json` (root + apps) | В git | OK |

**Процедура деплоя (документирована):**
```bash
git push origin main
gh workflow run admin-ops.yml -R brsvdmtr/wishlist -f action=health-check
```

---

## Расписание бэкапов (рекомендованное)

| Частота | Что | Команда |
|---------|-----|---------|
| Ежедневно 03:00 | База + uploads + `.env` | `/opt/wishlist/ops/backup.sh` -> `/opt/backups/wishlist/` + Selectel/S3 |
| Еженедельно вс 04:00 | Docker cleanup | `docker system prune -af --filter "until=168h"` |
| Ежемесячно | Restore drill | Скачать архив из Selectel и восстановить в тестовую БД |
| Ежемесячно | SSL проверка | `certbot renew --dry-run` |

---

## Быстрая проверка бэкапов

```bash
# Запустить на сервере для проверки всего:
echo "=== Backup Status ==="
echo "DB backups:"
ls -lht /opt/backups/wishlist/wishlist_*.tar.gz | head -3 || echo "  NO LOCAL BACKUPS!"
echo ""
echo "Selectel backups:"
rclone ls wishlist-s3:wishlist-backups/ | tail -5 || echo "  NO REMOTE BACKUPS!"
echo ""
echo "SSL expiry:"
echo | openssl s_client -servername wishlistik.ru -connect wishlistik.ru:443 2>/dev/null | openssl x509 -noout -enddate
echo ""
echo "Docker volumes:"
docker volume ls | grep wishlist
echo ""
echo "Services:"
docker compose -f /opt/wishlist/docker-compose.prod.yml ps --format "table {{.Name}}\t{{.Status}}"
```
