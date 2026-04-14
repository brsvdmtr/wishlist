-- AlterTable: add parentCommentId for one-level reply support
ALTER TABLE "Comment" ADD COLUMN "parentCommentId" TEXT;

-- CreateIndex
CREATE INDEX "Comment_parentCommentId_idx" ON "Comment"("parentCommentId");

-- AddForeignKey: ON DELETE SET NULL so deleting a parent leaves replies as orphaned normal comments
ALTER TABLE "Comment"
  ADD CONSTRAINT "Comment_parentCommentId_fkey"
  FOREIGN KEY ("parentCommentId") REFERENCES "Comment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
