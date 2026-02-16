# WishList

Monorepo for WishList - a public wishlist platform with admin panel and Telegram bot.

## Stack

- `apps/web`: Next.js 14 (App Router) + TypeScript + TailwindCSS
- `apps/api`: Node.js + Express + TypeScript + Zod
- `apps/bot`: Node.js + Telegraf + TypeScript
- `packages/db`: Prisma + PostgreSQL

## Features

- 🎁 Public wishlist pages (`/w/[slug]`)
- 🔐 Admin panel with Basic Auth (`/admin`)
- 🤖 Telegram bot integration
- 📊 Audit logging for admin operations
- ⏱️ Rate limiting for API endpoints
- 📄 Pagination support for large wishlists

## Local development

```bash
pnpm i

# env
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/bot/.env.example apps/bot/.env
cp apps/web/.env.example apps/web/.env.local

# postgres
docker compose -f docker-compose.dev.yml up -d

# prisma (applies existing migrations, generates client)
pnpm db:migrate

# seed demo data
pnpm seed

# start web+api+bot in parallel
pnpm dev

# open demo
# IMPORTANT (Safari): use the full URL with `http://` prefix.
open http://localhost:3000/w/demo
```

Notes:

- `apps/bot` requires `BOT_TOKEN`. If missing, bot is disabled (web+api still run).
- `apps/api` private endpoints require header `X-ADMIN-KEY` equal to `ADMIN_KEY`.
- `/admin` routes require Basic Auth (credentials from env).
- Default ports: web `3000`, api `3001`, postgres `5432`.

### Environment Variables

#### Required for all environments:

**Root `.env`:**
```bash
DATABASE_URL=postgresql://wishlist:wishlist@localhost:5432/wishlist?schema=public
```

**`apps/api/.env`:**
```bash
DATABASE_URL=postgresql://wishlist:wishlist@localhost:5432/wishlist?schema=public
PORT=3001
WEB_ORIGIN=http://localhost:3000
ADMIN_KEY=dev_admin_key              # SECRET: For admin API operations
SYSTEM_USER_EMAIL=owner@local
```

**`apps/web/.env.local`:**
```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_SITE_URL=http://localhost:3000
INTERNAL_API_BASE_URL=http://localhost:3001  # Server-side only
ADMIN_KEY=dev_admin_key              # SERVER-SIDE ONLY (not exposed to browser)
ADMIN_BASIC_USER=admin               # Basic Auth username
ADMIN_BASIC_PASS=change_me           # Basic Auth password
```

**`apps/bot/.env` (optional, для сценариев «Мой список» / «Добавить желание» нужен `ADMIN_KEY`):**
```bash
BOT_TOKEN=your_telegram_bot_token    # Get from @BotFather
ADMIN_KEY=dev_admin_key              # Same as in apps/api (for API calls as Telegram user)
API_BASE_URL=http://localhost:3001
SITE_URL=http://localhost:3000
```

## Testing

### Web Application

1. **Public wishlist page:**
   ```bash
   open http://localhost:3000/w/demo
   ```

2. **Admin panel (requires Basic Auth):**
   ```bash
   # Browser will prompt for username/password
   open http://localhost:3000/admin
   # Credentials: admin / change_me (from .env.local)
   ```

### API Endpoints

1. **Health check:**
   ```bash
   curl http://localhost:3001/health
   # Expected: {"ok":true}
   ```

2. **Public wishlist:**
   ```bash
   curl http://localhost:3001/public/wishlists/demo
   # Returns wishlist with items and tags
   ```

3. **Pagination:**
   ```bash
   curl "http://localhost:3001/public/wishlists/demo/items?limit=10&offset=0"
   # Returns first 10 items with pagination metadata
   ```

4. **Tag filter:**
   ```bash
   curl "http://localhost:3001/public/wishlists/demo/items?tagName=electronics"
   # Returns items filtered by tag name
   ```

5. **Rate limiting test:**
   ```bash
   # Try 11+ reserve requests in 1 minute (should be blocked after 10)
   for i in {1..12}; do
     curl -X POST http://localhost:3001/public/items/ITEM_ID/reserve \
       -H "Content-Type: application/json" \
       -d '{"actorHash":"test-user"}'
     sleep 1
   done
   # 11th request should return 429 Too Many Requests
   ```

### Telegram Bot

1. **Start bot:**
   - Open Telegram and find your bot (username from @BotFather)
   
2. **Test commands:**
   - `/start` - Welcome message
   - `/demo` - Get link to demo wishlist
   - `/w demo` - Get link to specific wishlist
   - `/health` - Check API status
   - `/help` - Show available commands

3. **Test URL parsing:**
   - Send message: "Check this /w/demo"
   - Bot should recognize and send formatted link

4. **Bot — «Мой список» и добавление желаний (Iteration 1):**
   - `/start` — главное меню (➕ Добавить желание, 📋 Мой список, 🔗 Поделиться, ⚙️ Настройки).
   - «📋 Мой список» — если списка нет, бот попросит название и создаст список с slug `tg_<telegram_id>`; иначе покажет пункты и кнопку «Поделиться».
   - «➕ Добавить желание» — ввод названия (и опционально ссылки на второй строке); пункт добавляется в текущий список.
   - «🔗 Поделиться» — ссылка на публичную страницу `/w/<slug>`.
   - В API запросы от бота идут с заголовками `X-ADMIN-KEY` и `X-Telegram-User-Id`; владелец списка определяется по Telegram ID.

## Production Environment

### `apps/web` (.env.local in production):

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.wishlistik.ru
NEXT_PUBLIC_SITE_URL=https://wishlistik.ru
INTERNAL_API_BASE_URL=http://localhost:3001  # Or internal service URL
ADMIN_KEY=STRONG_RANDOM_SECRET_HERE
ADMIN_BASIC_USER=admin
ADMIN_BASIC_PASS=STRONG_PASSWORD_HERE
```

### `apps/api` (.env in production):

```bash
DATABASE_URL=postgresql://user:pass@host:5432/db
PORT=3001
WEB_ORIGIN=https://wishlistik.ru
ADMIN_KEY=STRONG_RANDOM_SECRET_HERE
SYSTEM_USER_EMAIL=admin@wishlistik.ru
NODE_ENV=production
LOG_LEVEL=info
```

### `apps/bot` (.env in production):

```bash
BOT_TOKEN=your_production_bot_token
API_BASE_URL=https://api.wishlistik.ru
SITE_URL=https://wishlistik.ru
```

#### Шаг 3: SITE_URL в боте

В `.env` бота задайте:

```bash
SITE_URL=https://wishlistik.ru
```

И перезапуск бота (как запускаешь: pm2 / docker / systemd). На сервере (в каталоге проекта, с настроенным `.env`):

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate bot
```

## Security Features

### Rate Limiting
- **Read operations** (GET): 120 requests/minute per IP
- **Write operations** (reserve/unreserve/purchase): 10 requests/minute per IP
- Returns `429 Too Many Requests` when exceeded

### Basic Auth
- All `/admin` and `/admin/*` routes require Basic Authentication
- Credentials: `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS` from environment
- Returns `401 Unauthorized` with `WWW-Authenticate` header if invalid

### Admin Key Protection
- `ADMIN_KEY` stored server-side only (never exposed to browser)
- All admin API operations proxied through Next.js route handlers
- Next.js adds `X-ADMIN-KEY` header before calling Express API

### Audit Logging
- All admin operations logged with:
  - Method, path, status code, duration
  - Resource IDs (wishlistId, itemId, tagId)
  - Error details (without exposing secrets)
- Uses Pino logger with structured JSON output
- Pretty output in development, JSON in production

### SEO Protection
- `/admin/*` routes include `X-Robots-Tag: noindex, nofollow` header
- Prevents search engines from indexing admin panel

## Commands

- `pnpm dev`: run `web` + `api` + `bot` in parallel
- `pnpm dev:web`: run `apps/web`
- `pnpm dev:api`: run `apps/api`
- `pnpm build`: build everything
- `pnpm build:web`: build `apps/web`
- `pnpm build:api`: build `apps/api`
- `pnpm lint`: run ESLint from repo root
- `pnpm db:migrate`: `prisma migrate dev` (dev)
- `pnpm db:studio`: `prisma studio`
