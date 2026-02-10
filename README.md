# WishList

Monorepo for WishList (SaaS wishlist).

## Stack

- `apps/web`: Next.js (App Router) + TypeScript
- `apps/api`: Node.js + Express + TypeScript
- `apps/bot`: Node.js + Telegraf + TypeScript
- `packages/db`: Prisma (schema + client)
- `packages/shared`: shared types + zod schemas

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

# start web+api+bot in parallel
pnpm dev
```

Notes:

- `apps/bot` requires `BOT_TOKEN`. If it's missing, the bot will stay disabled (web+api still run).
- `apps/api` private endpoints require header `X-ADMIN-KEY` equal to `ADMIN_KEY`.
- Default ports: web `3000`, api `3001`, postgres `5432`.

## Production env

`apps/web`:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.wishlistik.ru
NEXT_PUBLIC_SITE_URL=https://wishlistik.ru
```

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
