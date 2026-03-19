-- CreateTable
CREATE TABLE "SantaParticipantAlias" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "adjectiveKey" TEXT NOT NULL,
    "animalKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaParticipantAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SantaParticipantAlias_roundId_idx" ON "SantaParticipantAlias"("roundId");

-- CreateIndex
CREATE INDEX "SantaParticipantAlias_participantId_idx" ON "SantaParticipantAlias"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "SantaParticipantAlias_roundId_participantId_key" ON "SantaParticipantAlias"("roundId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "SantaParticipantAlias_roundId_alias_key" ON "SantaParticipantAlias"("roundId", "alias");

-- AddForeignKey
ALTER TABLE "SantaParticipantAlias" ADD CONSTRAINT "SantaParticipantAlias_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "SantaRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SantaParticipantAlias" ADD CONSTRAINT "SantaParticipantAlias_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
