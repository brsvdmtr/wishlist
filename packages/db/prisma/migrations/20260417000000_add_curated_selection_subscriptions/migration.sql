-- CreateTable
CREATE TABLE "CuratedSelectionSubscription" (
    "id" TEXT NOT NULL,
    "curatedSelectionId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuratedSelectionSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CuratedSelectionSubscription_curatedSelectionId_subscriberId_key" ON "CuratedSelectionSubscription"("curatedSelectionId", "subscriberId");
CREATE INDEX "CuratedSelectionSubscription_subscriberId_idx" ON "CuratedSelectionSubscription"("subscriberId");
CREATE INDEX "CuratedSelectionSubscription_curatedSelectionId_idx" ON "CuratedSelectionSubscription"("curatedSelectionId");

-- AddForeignKey
ALTER TABLE "CuratedSelectionSubscription" ADD CONSTRAINT "CuratedSelectionSubscription_curatedSelectionId_fkey" FOREIGN KEY ("curatedSelectionId") REFERENCES "CuratedSelection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CuratedSelectionSubscription" ADD CONSTRAINT "CuratedSelectionSubscription_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
