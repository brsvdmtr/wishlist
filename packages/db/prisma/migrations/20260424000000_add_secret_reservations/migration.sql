-- CreateEnum
CREATE TYPE "SecretReservationStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'FULFILLED', 'CONVERTED_TO_PUBLIC');

-- CreateTable
CREATE TABLE "SecretReservation" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "reserverUserId" TEXT NOT NULL,
    "status" "SecretReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "snapshot" JSONB NOT NULL,
    "updatesAcknowledgedAt" TIMESTAMP(3),
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),

    CONSTRAINT "SecretReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecretReservation_itemId_reserverUserId_key" ON "SecretReservation"("itemId", "reserverUserId");

-- CreateIndex
CREATE INDEX "SecretReservation_reserverUserId_status_idx" ON "SecretReservation"("reserverUserId", "status");

-- CreateIndex
CREATE INDEX "SecretReservation_itemId_idx" ON "SecretReservation"("itemId");

-- AddForeignKey
ALTER TABLE "SecretReservation" ADD CONSTRAINT "SecretReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretReservation" ADD CONSTRAINT "SecretReservation_reserverUserId_fkey" FOREIGN KEY ("reserverUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
