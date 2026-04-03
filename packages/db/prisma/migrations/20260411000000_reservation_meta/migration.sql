-- CreateTable
CREATE TABLE "ReservationMeta" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "reserverUserId" TEXT NOT NULL,
    "note" VARCHAR(500),
    "purchased" BOOLEAN NOT NULL DEFAULT false,
    "purchasedAt" TIMESTAMP(3),
    "reminderAt" TIMESTAMP(3),
    "reminderSent" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationMeta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReservationMeta_itemId_reserverUserId_key" ON "ReservationMeta"("itemId", "reserverUserId");

-- CreateIndex
CREATE INDEX "ReservationMeta_reserverUserId_active_idx" ON "ReservationMeta"("reserverUserId", "active");

-- CreateIndex
CREATE INDEX "ReservationMeta_reminderAt_reminderSent_idx" ON "ReservationMeta"("reminderAt", "reminderSent");

-- AddForeignKey
ALTER TABLE "ReservationMeta" ADD CONSTRAINT "ReservationMeta_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
