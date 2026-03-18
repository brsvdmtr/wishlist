-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'WAITING_SUPPORT', 'WAITING_USER', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportMessageAuthorRole" AS ENUM ('USER', 'SUPPORT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SupportMessageKind" AS ENUM ('TEXT', 'PHOTO', 'VIDEO', 'DOCUMENT', 'OTHER');

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "ticketCode" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "openedVia" TEXT,
    "supportChatId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorRole" "SupportMessageAuthorRole" NOT NULL,
    "kind" "SupportMessageKind" NOT NULL DEFAULT 'TEXT',
    "text" TEXT,
    "caption" TEXT,
    "telegramUserChatId" TEXT,
    "telegramUserMsgId" INTEGER,
    "telegramSupportChatId" TEXT,
    "telegramSupportMsgId" INTEGER,
    "telegramFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "promptMessageId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_ticketCode_key" ON "SupportTicket"("ticketCode");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_status_idx" ON "SupportTicket"("userId", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_status_updatedAt_idx" ON "SupportTicket"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportMessage_telegramSupportMsgId_idx" ON "SupportMessage"("telegramSupportMsgId");

-- CreateIndex
CREATE INDEX "SupportMessage_telegramUserMsgId_idx" ON "SupportMessage"("telegramUserMsgId");

-- CreateIndex
CREATE INDEX "SupportSession_telegramChatId_promptMessageId_idx" ON "SupportSession"("telegramChatId", "promptMessageId");

-- CreateIndex
CREATE INDEX "SupportSession_expiresAt_idx" ON "SupportSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
