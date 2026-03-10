-- CreateEnum
CREATE TYPE "HintStatus" AS ENUM ('SENT', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Hint" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "status" "HintStatus" NOT NULL DEFAULT 'SENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Hint_itemId_idx" ON "Hint"("itemId");

-- CreateIndex
CREATE INDEX "Hint_senderUserId_createdAt_idx" ON "Hint"("senderUserId","createdAt");

-- CreateIndex
CREATE INDEX "Hint_expiresAt_idx" ON "Hint"("expiresAt");

-- AddForeignKey
ALTER TABLE "Hint" ADD CONSTRAINT "Hint_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hint" ADD CONSTRAINT "Hint_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
