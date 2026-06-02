-- P0.3 «Событийные пуши» — event-driven bot notifications
-- Adds: UserProfile circle-event preference + quiet-hours columns,
-- CircleMembership.mutedAt, and the EventNotification outbox + its enum.

-- AlterTable: UserProfile — circle event push preferences (FREE, default ON)
ALTER TABLE "UserProfile"
  ADD COLUMN "notifyCircleEvents" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifyCircleNewWishes" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifyCircleReservationChanges" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifyCircleJoins" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "quietHoursStart" TEXT NOT NULL DEFAULT '22:00',
  ADD COLUMN "quietHoursEnd" TEXT NOT NULL DEFAULT '09:00',
  ADD COLUMN "notifyTimezone" TEXT;

-- AlterTable: CircleMembership — per-member circle mute
ALTER TABLE "CircleMembership" ADD COLUMN "mutedAt" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "EventNotificationType" AS ENUM ('EVENT_UPCOMING_7D', 'EVENT_UPCOMING_3D', 'NEW_WISH', 'RESERVATION_CHANGED', 'CIRCLE_JOINED');

-- CreateTable
CREATE TABLE "EventNotification" (
    "id" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "circleId" TEXT,
    "type" "EventNotificationType" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "groupKey" TEXT NOT NULL,
    "groupUntil" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventNotification_dedupeKey_key" ON "EventNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "EventNotification_status_groupUntil_idx" ON "EventNotification"("status", "groupUntil");

-- CreateIndex
CREATE INDEX "EventNotification_groupKey_status_idx" ON "EventNotification"("groupKey", "status");

-- CreateIndex
CREATE INDEX "EventNotification_recipientUserId_status_sentAt_idx" ON "EventNotification"("recipientUserId", "status", "sentAt");

-- AddForeignKey
ALTER TABLE "EventNotification" ADD CONSTRAINT "EventNotification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
