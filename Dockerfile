# Simple production image for the monorepo (apps/web + packages/db)
# MVP-first: keeps dependencies in one layer for reliable Prisma CLI + Next build.

FROM node:20-bookworm-slim

WORKDIR /app

# 1) Install deps (better layer caching)
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN npm ci

# 2) Copy source
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build-time tasks
RUN npm run prisma:generate
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start", "-w", "apps/web"]
