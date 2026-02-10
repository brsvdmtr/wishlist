# Wishlist

Next.js (App Router) + TypeScript + ESLint + Prisma + Postgres.

## Requirements

- Node.js 18+ (recommended 20+)
- Docker (for local Postgres)

## Setup

1) Create `.env` from example:

```bash
cp .env.example .env
```

2) Start Postgres:

```bash
docker compose up -d
```

## Install

```bash
npm install
```

## Prisma

Prisma uses `DATABASE_URL` from the root `.env`.

Generate client:

```bash
npm run prisma:generate
```

Apply migrations (dev):

```bash
npm run prisma:migrate
```

Create a new migration after schema changes:

```bash
npm run prisma:migrate -- --name <migration_name>
```

Open Prisma Studio:

```bash
npm run prisma:studio
```

## Dev

```bash
npm run dev
```

- App: http://localhost:3000
- Health: http://localhost:3000/health

## Deploy (GitHub Actions)

Deploy will be configured via GitHub Actions (workflow will be added later).

## Auto Push (develop)

This repo auto-pushes commits from the `develop` branch to `origin/develop` via a git `post-commit` hook.

- Installed automatically on `npm install` (or run `npm run hooks:install`)
- Disable for one commit: `SKIP_AUTO_PUSH=1 git commit ...`
