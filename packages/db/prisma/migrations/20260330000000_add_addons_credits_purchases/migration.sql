-- Add one-time purchase entitlement tables
-- Safe additive migration; no existing data is modified.

-- UserAddOn: permanent account/wishlist-scoped upgrade slots
CREATE TABLE "UserAddOn" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "addonType" TEXT         NOT NULL,
    "quantity"  INTEGER      NOT NULL DEFAULT 1,
    "targetId"  TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAddOn_pkey" PRIMARY KEY ("id")
);

-- UserCredits: consumable hint / import credit balances
CREATE TABLE "UserCredits" (
    "id"            TEXT         NOT NULL,
    "userId"        TEXT         NOT NULL,
    "hintCredits"   INTEGER      NOT NULL DEFAULT 0,
    "importCredits" INTEGER      NOT NULL DEFAULT 0,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCredits_pkey" PRIMARY KEY ("id")
);

-- Purchase: immutable one-time payment log
CREATE TABLE "Purchase" (
    "id"               TEXT         NOT NULL,
    "userId"           TEXT         NOT NULL,
    "skuCode"          TEXT         NOT NULL,
    "quantity"         INTEGER      NOT NULL DEFAULT 1,
    "targetId"         TEXT,
    "starsPrice"       INTEGER      NOT NULL,
    "telegramChargeId" TEXT         NOT NULL,
    "invoicePayload"   TEXT         NOT NULL,
    "status"           TEXT         NOT NULL DEFAULT 'completed',
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "UserCredits_userId_key"        ON "UserCredits"("userId");
CREATE UNIQUE INDEX "Purchase_telegramChargeId_key"  ON "Purchase"("telegramChargeId");

-- Lookup indexes
CREATE INDEX "UserAddOn_userId_idx"          ON "UserAddOn"("userId");
CREATE INDEX "UserAddOn_userId_addonType_idx" ON "UserAddOn"("userId", "addonType");
CREATE INDEX "Purchase_userId_idx"           ON "Purchase"("userId");
CREATE INDEX "Purchase_telegramChargeId_idx" ON "Purchase"("telegramChargeId");
CREATE INDEX "Purchase_userId_skuCode_idx"   ON "Purchase"("userId", "skuCode");

-- Foreign keys → cascade on user delete
ALTER TABLE "UserAddOn"  ADD CONSTRAINT "UserAddOn_userId_fkey"  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCredits" ADD CONSTRAINT "UserCredits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Purchase"   ADD CONSTRAINT "Purchase_userId_fkey"   FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
