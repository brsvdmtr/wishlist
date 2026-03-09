-- AlterTable: Add telegramChatId to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramChatId" TEXT;

-- AlterTable: Add description, reservationEpoch, reserverUserId to Item
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "description" VARCHAR(500);
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "reservationEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "reserverUserId" TEXT;

-- CreateEnum: CommentType
DO $$ BEGIN
  CREATE TYPE "CommentType" AS ENUM ('USER', 'SYSTEM');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- CreateTable: Comment
CREATE TABLE IF NOT EXISTS "Comment" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" "CommentType" NOT NULL DEFAULT 'USER',
    "authorActorHash" TEXT,
    "authorDisplayName" TEXT,
    "text" VARCHAR(300) NOT NULL,
    "reservationEpoch" INTEGER NOT NULL DEFAULT 0,
    "scheduledDeleteAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Comment_itemId_createdAt_idx" ON "Comment"("itemId", "createdAt");
CREATE INDEX IF NOT EXISTS "Comment_scheduledDeleteAt_idx" ON "Comment"("scheduledDeleteAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Comment" ADD CONSTRAINT "Comment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
