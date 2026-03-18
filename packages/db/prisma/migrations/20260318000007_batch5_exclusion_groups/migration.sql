-- Batch 5.1: Advanced exclusions — group exclusion model
--
-- Strategy: groups expand to individual pairs in-memory at draw time.
-- No individual SantaExclusion rows are materialized from groups — zero sync complexity.
-- buildExclusionSet() interface is unchanged; the new loadExclusionSet() helper
-- expands groups before calling it.

-- Group entity: named collection scoped to a campaign
CREATE TABLE "SantaExclusionGroup" (
  "id"         TEXT         NOT NULL,
  "campaignId" TEXT         NOT NULL,
  "label"      TEXT         NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SantaExclusionGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SantaExclusionGroup_campaignId_idx"
  ON "SantaExclusionGroup"("campaignId");

ALTER TABLE "SantaExclusionGroup"
  ADD CONSTRAINT "SantaExclusionGroup_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Group membership: userId in a named group
CREATE TABLE "SantaExclusionGroupMember" (
  "id"      TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "userId"  TEXT NOT NULL,
  CONSTRAINT "SantaExclusionGroupMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SantaExclusionGroupMember_groupId_userId_key"
  ON "SantaExclusionGroupMember"("groupId", "userId");

CREATE INDEX "SantaExclusionGroupMember_userId_idx"
  ON "SantaExclusionGroupMember"("userId");

ALTER TABLE "SantaExclusionGroupMember"
  ADD CONSTRAINT "SantaExclusionGroupMember_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "SantaExclusionGroup"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaExclusionGroupMember"
  ADD CONSTRAINT "SantaExclusionGroupMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
