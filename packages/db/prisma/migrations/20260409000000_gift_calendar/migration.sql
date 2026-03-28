-- Gift Calendar & Occasion Automation

CREATE TABLE "GiftPerson" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "linkedUserId" TEXT,
    "displayName" TEXT NOT NULL,
    "telegramUsername" TEXT,
    "relation" TEXT NOT NULL DEFAULT 'OTHER',
    "avatarUrl" TEXT,
    "timezone" TEXT,
    "note" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftPerson_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GiftOccasion" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "personId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'CUSTOM',
    "title" TEXT NOT NULL,
    "eventDate" DATE NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
    "recurrence" TEXT NOT NULL DEFAULT 'NONE',
    "reminderOffsetsJson" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isMuted" BOOLEAN NOT NULL DEFAULT false,
    "suggestWishlist" BOOLEAN NOT NULL DEFAULT true,
    "suggestHint" BOOLEAN NOT NULL DEFAULT true,
    "suggestGiftIdeas" BOOLEAN NOT NULL DEFAULT true,
    "suggestSubscription" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftOccasion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GiftReminderDelivery" (
    "id" TEXT NOT NULL,
    "occasionId" TEXT NOT NULL,
    "daysBefore" INTEGER NOT NULL,
    "yearKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "deepLinkPayload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftReminderDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GiftPlanState" (
    "id" TEXT NOT NULL,
    "occasionId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NONE',
    "selectedItemId" TEXT,
    "selectedWishlistId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftPlanState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GiftOccasionMute" (
    "id" TEXT NOT NULL,
    "occasionId" TEXT NOT NULL,
    "yearKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftOccasionMute_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "GiftPerson_ownerUserId_idx" ON "GiftPerson"("ownerUserId");

CREATE INDEX "GiftOccasion_ownerUserId_idx" ON "GiftOccasion"("ownerUserId");
CREATE INDEX "GiftOccasion_ownerUserId_isActive_idx" ON "GiftOccasion"("ownerUserId", "isActive");
CREATE INDEX "GiftOccasion_personId_idx" ON "GiftOccasion"("personId");

CREATE UNIQUE INDEX "GiftReminderDelivery_occasionId_yearKey_daysBefore_key" ON "GiftReminderDelivery"("occasionId", "yearKey", "daysBefore");
CREATE INDEX "GiftReminderDelivery_status_scheduledFor_idx" ON "GiftReminderDelivery"("status", "scheduledFor");

CREATE UNIQUE INDEX "GiftPlanState_occasionId_key" ON "GiftPlanState"("occasionId");
CREATE INDEX "GiftPlanState_ownerUserId_idx" ON "GiftPlanState"("ownerUserId");

CREATE UNIQUE INDEX "GiftOccasionMute_occasionId_yearKey_key" ON "GiftOccasionMute"("occasionId", "yearKey");
CREATE INDEX "GiftOccasionMute_occasionId_idx" ON "GiftOccasionMute"("occasionId");

-- Foreign Keys
ALTER TABLE "GiftPerson" ADD CONSTRAINT "GiftPerson_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GiftOccasion" ADD CONSTRAINT "GiftOccasion_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GiftOccasion" ADD CONSTRAINT "GiftOccasion_personId_fkey" FOREIGN KEY ("personId") REFERENCES "GiftPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GiftReminderDelivery" ADD CONSTRAINT "GiftReminderDelivery_occasionId_fkey" FOREIGN KEY ("occasionId") REFERENCES "GiftOccasion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GiftPlanState" ADD CONSTRAINT "GiftPlanState_occasionId_fkey" FOREIGN KEY ("occasionId") REFERENCES "GiftOccasion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GiftOccasionMute" ADD CONSTRAINT "GiftOccasionMute_occasionId_fkey" FOREIGN KEY ("occasionId") REFERENCES "GiftOccasion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
