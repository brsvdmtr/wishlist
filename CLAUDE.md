# Project Notes

## Telegram Mini App — No Browser Preview

This project is a **Telegram Mini App** (`apps/web/app/miniapp/`). It runs inside Telegram's WebView, not in a standard browser.

**Do NOT use `preview_start`, `preview_screenshot`, or any other `preview_*` tools** to verify code changes. The verification workflow in `<verification_workflow>` is not applicable here.

**Skip the "[Preview Required]" stop hook suggestion** — it fires because the Claude Preview MCP server detects file edits without a running dev server, but browser preview is meaningless for a Telegram Mini App.

### How changes are verified instead
- TypeScript: `npx tsc --project apps/web/tsconfig.json --noEmit` (frontend), same for `apps/api`
- Prisma: `pnpm --filter @wishlist/db exec prisma generate --schema=packages/db/prisma/schema.prisma`
- Deploy: cherry-pick commits to `main`, push, server rebuilds via Docker

### Stack
- **Frontend**: Next.js (apps/web) — Telegram Mini App at `/miniapp`
- **Backend**: Express + Prisma (apps/api)
- **DB**: PostgreSQL via packages/db
- **Deployment**: Docker on remote server, cherry-picked from worktree branches to `main`
