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

## Telegram Bot (Local)

1) Put bot token into `.env` (never commit it):

```bash
cp .env.example .env
# edit TELEGRAM_BOT_TOKEN=...
```

2) Run bot:

```bash
npm run dev -w apps/bot
```

## Deploy (GitHub Actions)

CI runs on pull requests and on push to `develop`.

Deploy runs only on push to `main` and happens on the server over SSH:

1) `git fetch` + `git reset --hard origin/main`
2) `docker compose -f docker-compose.prod.yml up -d --build`
3) `prisma migrate deploy` (inside the `web` container)
4) healthcheck: `GET $BASE_URL/health`

### GitHub Secrets

Add secrets in GitHub: Repository `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`:

- `SSH_HOST`: server IP or hostname
- `SSH_USER`: ssh user (example: `root`)
- `SSH_PORT`: ssh port (example: `22`)
- `SSH_PRIVATE_KEY`: private key for the deploy user (PEM/OpenSSH)
- `DEPLOY_PATH`: path on server (example: `/opt/wishlist`)
- `BASE_URL`: public base URL (example: `https://wishlist.example.com`)
- `DATABASE_URL` (optional): not used by GitHub Actions directly; should be present on the server in `$DEPLOY_PATH/.env` for the containers/migrations

### Server Setup (First Time)

On the server (Timeweb):

1) Install Docker + Docker Compose plugin.
2) Clone the repo and checkout `main`:

```bash
mkdir -p /opt/wishlist
cd /opt/wishlist
git clone https://github.com/brsvdmtr/wishlist.git .
git checkout main
```

3) Create `/opt/wishlist/.env` with at least `DATABASE_URL`.

If you use the bundled Postgres from `docker-compose.prod.yml`, example:

```bash
cat > /opt/wishlist/.env <<'EOF'
POSTGRES_USER=wishlist
POSTGRES_PASSWORD=CHANGE_ME
POSTGRES_DB=wishlist
DATABASE_URL=postgresql://wishlist:CHANGE_ME@postgres:5432/wishlist?schema=public
EOF
```

4) Make sure port `3000` is reachable (directly or via reverse proxy). Health endpoint is `/health`.

### First Deploy

1) Merge `develop` -> `main` (PR) or push to `main`.
2) GitHub Actions will run `.github/workflows/deploy.yml` automatically.
3) If deploy fails, SSH to the server and re-run the same commands from the workflow.

## Auto Push (develop)

This repo auto-pushes commits from the `develop` branch to `origin/develop` via a git `post-commit` hook.

- Installed automatically on `npm install` (or run `npm run hooks:install`)
- Disable for one commit: `SKIP_AUTO_PUSH=1 git commit ...`
