-- CreateTable: SantaGlobalConfig (singleton, id = 'global')
-- Purpose: global master switch for retiring Secret Santa entirely.
CREATE TABLE "SantaGlobalConfig" (
    "id"           TEXT    NOT NULL DEFAULT 'global',
    "santaEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaGlobalConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SantaSeasonalBroadcastLog
-- Purpose: dedup seasonal Telegram broadcasts — one row per (year, type).
CREATE TABLE "SantaSeasonalBroadcastLog" (
    "id"        TEXT    NOT NULL,
    "year"      INTEGER NOT NULL,
    "type"      TEXT    NOT NULL,
    "sentAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SantaSeasonalBroadcastLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique (year, type) on broadcast log
CREATE UNIQUE INDEX "SantaSeasonalBroadcastLog_year_type_key"
    ON "SantaSeasonalBroadcastLog"("year", "type");

-- Seed the singleton so the server can always read it without conditional create logic.
-- ON CONFLICT DO NOTHING is idempotent — safe to re-run on any environment.
INSERT INTO "SantaGlobalConfig" ("id", "santaEnabled", "updatedAt")
VALUES ('global', true, NOW())
ON CONFLICT ("id") DO NOTHING;
