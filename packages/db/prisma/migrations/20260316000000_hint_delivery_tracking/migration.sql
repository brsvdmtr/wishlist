-- AlterEnum: add DELIVERED to HintStatus
ALTER TYPE "HintStatus" ADD VALUE 'DELIVERED';

-- AlterTable: add delivery tracking columns
ALTER TABLE "Hint" ADD COLUMN "sentCount" INTEGER;
ALTER TABLE "Hint" ADD COLUMN "pendingCount" INTEGER;
ALTER TABLE "Hint" ADD COLUMN "deliveredAt" TIMESTAMP(3);
