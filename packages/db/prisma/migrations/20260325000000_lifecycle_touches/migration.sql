-- LifecycleTouch model for win-back / lifecycle messaging
CREATE TABLE "LifecycleTouch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "episodeKey" TEXT NOT NULL,
    "touchNumber" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "targetAction" TEXT,
    "offerCode" TEXT,
    "messageKind" TEXT NOT NULL,
    "deepLinkPayload" TEXT,
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LifecycleTouch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LifecycleTouch_userId_episodeKey_touchNumber_key" ON "LifecycleTouch"("userId", "episodeKey", "touchNumber");
CREATE INDEX "LifecycleTouch_userId_segment_idx" ON "LifecycleTouch"("userId", "segment");
CREATE INDEX "LifecycleTouch_scheduledFor_sentAt_idx" ON "LifecycleTouch"("scheduledFor", "sentAt");
CREATE INDEX "LifecycleTouch_userId_offerCode_idx" ON "LifecycleTouch"("userId", "offerCode");

ALTER TABLE "LifecycleTouch" ADD CONSTRAINT "LifecycleTouch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
