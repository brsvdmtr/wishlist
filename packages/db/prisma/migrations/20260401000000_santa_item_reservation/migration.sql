-- CreateTable: SantaItemReservation
-- Purpose: tracks which wishlist items a giver has "claimed" for their Secret Santa assignment.
-- Distinct from general ReservationEvent — no identity leak to receiver side.
-- Only Santa-flow reservations drive the SELECTED_FROM_WISHLIST gift status.
CREATE TABLE "SantaItemReservation" (
    "id"           TEXT        NOT NULL,
    "assignmentId" TEXT        NOT NULL,
    "itemId"       TEXT        NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaItemReservation_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex: one reservation per (assignment, item)
CREATE UNIQUE INDEX "SantaItemReservation_assignmentId_itemId_key"
    ON "SantaItemReservation"("assignmentId", "itemId");

-- CreateIndex: for fast lookup by assignment
CREATE INDEX "SantaItemReservation_assignmentId_idx"
    ON "SantaItemReservation"("assignmentId");

-- CreateIndex: for cascade-delete lookups by item
CREATE INDEX "SantaItemReservation_itemId_idx"
    ON "SantaItemReservation"("itemId");

-- AddForeignKey: assignment → cascade delete when assignment is deleted (draw reset)
ALTER TABLE "SantaItemReservation"
    ADD CONSTRAINT "SantaItemReservation_assignmentId_fkey"
        FOREIGN KEY ("assignmentId") REFERENCES "SantaAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: item → cascade delete when item is deleted
ALTER TABLE "SantaItemReservation"
    ADD CONSTRAINT "SantaItemReservation_itemId_fkey"
        FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
