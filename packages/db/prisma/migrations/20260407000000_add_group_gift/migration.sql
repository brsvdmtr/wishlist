-- CreateEnum
CREATE TYPE "GroupGiftStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "GroupGift" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "organizerUserId" TEXT NOT NULL,
    "targetAmount" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'RUB',
    "deadline" DATE,
    "note" VARCHAR(500),
    "pinnedInfo" VARCHAR(1000),
    "status" "GroupGiftStatus" NOT NULL DEFAULT 'OPEN',
    "inviteToken" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupGift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupGiftParticipant" (
    "id" TEXT NOT NULL,
    "groupGiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupGiftParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupGiftMessage" (
    "id" TEXT NOT NULL,
    "groupGiftId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupGiftMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupGift_itemId_key" ON "GroupGift"("itemId");
CREATE UNIQUE INDEX "GroupGift_inviteToken_key" ON "GroupGift"("inviteToken");
CREATE INDEX "GroupGift_organizerUserId_idx" ON "GroupGift"("organizerUserId");
CREATE INDEX "GroupGift_inviteToken_idx" ON "GroupGift"("inviteToken");
CREATE INDEX "GroupGift_status_idx" ON "GroupGift"("status");

CREATE UNIQUE INDEX "GroupGiftParticipant_groupGiftId_userId_key" ON "GroupGiftParticipant"("groupGiftId", "userId");
CREATE INDEX "GroupGiftParticipant_userId_idx" ON "GroupGiftParticipant"("userId");
CREATE INDEX "GroupGiftParticipant_groupGiftId_idx" ON "GroupGiftParticipant"("groupGiftId");

CREATE INDEX "GroupGiftMessage_groupGiftId_createdAt_idx" ON "GroupGiftMessage"("groupGiftId", "createdAt");
CREATE INDEX "GroupGiftMessage_senderUserId_idx" ON "GroupGiftMessage"("senderUserId");

-- AddForeignKey
ALTER TABLE "GroupGift" ADD CONSTRAINT "GroupGift_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupGift" ADD CONSTRAINT "GroupGift_organizerUserId_fkey" FOREIGN KEY ("organizerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupGiftParticipant" ADD CONSTRAINT "GroupGiftParticipant_groupGiftId_fkey" FOREIGN KEY ("groupGiftId") REFERENCES "GroupGift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupGiftParticipant" ADD CONSTRAINT "GroupGiftParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupGiftMessage" ADD CONSTRAINT "GroupGiftMessage_groupGiftId_fkey" FOREIGN KEY ("groupGiftId") REFERENCES "GroupGift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupGiftMessage" ADD CONSTRAINT "GroupGiftMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
