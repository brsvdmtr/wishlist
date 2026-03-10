-- Add firstName to User
ALTER TABLE "User" ADD COLUMN "firstName" TEXT;

-- Create CommentReadCursor table
CREATE TABLE "CommentReadCursor" (
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommentReadCursor_pkey" PRIMARY KEY ("userId","itemId")
);

-- Add indexes
CREATE INDEX "CommentReadCursor_userId_idx" ON "CommentReadCursor"("userId");

-- Add foreign keys
ALTER TABLE "CommentReadCursor" ADD CONSTRAINT "CommentReadCursor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommentReadCursor" ADD CONSTRAINT "CommentReadCursor_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
