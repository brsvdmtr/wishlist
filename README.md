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

Generate client:

```bash
npm run prisma:generate
```

Run migrations (dev):

```bash
npm run prisma:migrate
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
