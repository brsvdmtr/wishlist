-- ═══════════════════════════════════════════════════════════════════════════
-- Idempotency-Key store
--   * IdempotencyStatus enum (processing | completed | failed)
--   * IdempotencyKey table — one row per (key + actorHash + method + path)
--
-- TTL'd (default 24 h, billing 7 d) and purged by an in-process cleanup job
-- once expiresAt passes. Response bodies capped at ~64 KB; oversized or
-- multipart responses are stored with body=null and responseTruncated=true.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Enum ───
CREATE TYPE "IdempotencyStatus" AS ENUM ('processing', 'completed', 'failed');

-- ─── 2. Table ───
CREATE TABLE "IdempotencyKey" (
    "id"                TEXT                NOT NULL,
    "key"               TEXT                NOT NULL,
    "userId"            TEXT,
    "actorHash"         TEXT,
    "actorKey"          TEXT                NOT NULL,
    "method"            TEXT                NOT NULL,
    "path"              TEXT                NOT NULL,
    "requestHash"       TEXT                NOT NULL,
    "responseStatus"    INTEGER,
    "responseBody"      JSONB,
    "responseTruncated" BOOLEAN             NOT NULL DEFAULT false,
    "status"            "IdempotencyStatus" NOT NULL,
    "lockedUntil"       TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3)        NOT NULL,
    "expiresAt"         TIMESTAMP(3)        NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- ─── 3. Indexes ───
CREATE UNIQUE INDEX "IdempotencyKey_key_actorKey_method_path_key"
    ON "IdempotencyKey"("key", "actorKey", "method", "path");

CREATE INDEX "IdempotencyKey_expiresAt_idx"
    ON "IdempotencyKey"("expiresAt");

CREATE INDEX "IdempotencyKey_actorHash_createdAt_idx"
    ON "IdempotencyKey"("actorHash", "createdAt");
