-- AlterTable
ALTER TABLE "Item" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Item" ADD COLUMN "purgeAfter" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Item_purgeAfter_idx" ON "Item"("purgeAfter");
