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
- Default ports: web `3000`, api `4000`, postgres `5432`.

## Commands

- `pnpm dev`: run `web` + `api` + `bot` in parallel
- `pnpm build`: build everything
- `pnpm lint`: run ESLint from repo root
- `pnpm db:migrate`: `prisma migrate dev` (dev)
- `pnpm db:studio`: `prisma studio`
