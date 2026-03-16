# BACKUP_CHECKLIST.md — Полный чеклист бэкапов WishBoard

---

## 1. Исходный код

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Git-репозиторий | GitHub: `brsvdmtr/wishlist` | Автоматически при `git push` | OK |
| Ветка `claude/wizardly-satoshi` | GitHub | `git push origin claude/wizardly-satoshi` | OK |
| Ветка `main` | GitHub | Проверить: все ли изменения мержатся в main? | ВНИМАНИЕ |
| Локальная копия | Рабочая машина разработчика | `git clone` на второе устройство | Рекомендуется |

**Действие:**
```bash
# Убедиться, что все изменения запушены:
cd /opt/wishlist
git status
git push origin claude/wizardly-satoshi
```

---

## 2. База данных (PostgreSQL)

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Все данные (users, wishlists, items, comments, reservations) | Docker volume `wishlist-prod_wishlist_pg_data` | `pg_dump` | НЕТ АВТОБЭКАПА |
| Схема БД (Prisma) | `packages/db/prisma/schema.prisma` | В git | OK |
| Миграции | `packages/db/prisma/migrations/` | В git | OK |

**Ручной бэкап:**
```bash
# На сервере:
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U wishlist -d wishlist \
  > /opt/backup/db_$(date +%Y%m%d_%H%M%S).sql

# Размер проверить:
ls -lh /opt/backup/db_*.sql
```

**Автоматизация (cron):**
```bash
# Добавить в crontab (crontab -e):
0 3 * * * cd /opt/wishlist && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U wishlist -d wishlist | gzip > /opt/backup/db_$(date +\%Y\%m\%d).sql.gz 2>/dev/null
# Каждый день в 3:00
```

---

## 3. Загруженные файлы (фото)

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| Оригиналы фото (JPEG, сжатые Sharp) | Docker volume `wishlist-prod_wishlist_uploads` | `docker cp` | НЕТ АВТОБЭКАПА |
| Тамбнейлы | Тот же volume | `docker cp` | НЕТ АВТОБЭКАПА |

**Ручной бэкап:**
```bash
mkdir -p /opt/backup/uploads_$(date +%Y%m%d)
docker cp $(docker compose -f docker-compose.prod.yml ps -q api):/data/uploads/. /opt/backup/uploads_$(date +%Y%m%d)/

# Размер:
du -sh /opt/backup/uploads_*/
```

**Автоматизация (cron):**
```bash
0 4 * * 0 tar czf /opt/backup/uploads_$(date +\%Y\%m\%d).tar.gz -C /opt/backup/uploads_latest . 2>/dev/null
# Каждое воскресенье в 4:00
```

---

## 4. Секреты и переменные окружения

| Что | Где хранится | Способ бэкапа | Статус |
|-----|-------------|---------------|--------|
| `.env` (production) | `/opt/wishlist/.env` на сервере | Ручное копирование | КРИТИЧНО |
| `.env.example` (шаблон) | В git | Автоматически | OK |
| `BOT_TOKEN` | `.env` + @BotFather в Telegram | Сохранить в менеджер паролей | КРИТИЧНО |
| `ADMIN_KEY` | `.env` | Сохранить в менеджер паролей | КРИТИЧНО |
| `POSTGRES_PASSWORD` | `.env` | Сохранить в менеджер паролей | КРИТИЧНО |
| `ADMIN_BASIC_PASS` | `.env` | Сохранить в менеджер паролей | КРИТИЧНО |

**Действие:**
```bash
# Скопировать .env на локальную машину:
scp -i ~/.ssh/timeweb_wishlist root@wishlistik.ru:/opt/wishlist/.env ./backup_env_$(date +%Y%m%d)

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
| Домен `wishlistik.ru` | Регистратор (Timeweb?) | Записать логин/пароль от панели | КРИТИЧНО |
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
ssh -i ~/.ssh/timeweb_wishlist root@wishlistik.ru
cd /opt/wishlist
git pull origin claude/wizardly-satoshi
docker compose -f docker-compose.prod.yml up -d --build
```

---

## Расписание бэкапов (рекомендованное)

| Частота | Что | Команда |
|---------|-----|---------|
| Ежедневно 03:00 | База данных | `pg_dump` -> `/opt/backup/` |
| Еженедельно вс 04:00 | Фото/uploads | `docker cp` -> `/opt/backup/` |
| После каждого деплоя | .env | `cp` -> `/opt/backup/` |
| Ежемесячно | Всё -> локальная машина | `scp -r /opt/backup/` |
| Ежемесячно | SSL проверка | `certbot renew --dry-run` |

---

## Быстрая проверка бэкапов

```bash
# Запустить на сервере для проверки всего:
echo "=== Backup Status ==="
echo "DB backups:"
ls -lht /opt/backup/db_* 2>/dev/null | head -3 || echo "  NO DB BACKUPS!"
echo ""
echo "Upload backups:"
ls -lht /opt/backup/uploads_* 2>/dev/null | head -3 || echo "  NO UPLOAD BACKUPS!"
echo ""
echo "Env backups:"
ls -lht /opt/backup/env_* 2>/dev/null | head -3 || echo "  NO ENV BACKUPS!"
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
