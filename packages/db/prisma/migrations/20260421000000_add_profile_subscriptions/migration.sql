-- CreateTable: ProfileSubscription — follow another user's public profile/showcase
CREATE TABLE "ProfileSubscription" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProfileSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE UNIQUE INDEX "ProfileSubscription_subscriberId_targetUserId_key" ON "ProfileSubscription"("subscriberId", "targetUserId");
CREATE INDEX "ProfileSubscription_subscriberId_idx" ON "ProfileSubscription"("subscriberId");
CREATE INDEX "ProfileSubscription_targetUserId_idx" ON "ProfileSubscription"("targetUserId");

-- AddForeignKeys
ALTER TABLE "ProfileSubscription" ADD CONSTRAINT "ProfileSubscription_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProfileSubscription" ADD CONSTRAINT "ProfileSubscription_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
