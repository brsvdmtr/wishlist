-- CreateTable
CREATE TABLE "CuratedSelection" (
    "id" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "shareToken" TEXT NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "deactivatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuratedSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuratedSelectionItem" (
    "id" TEXT NOT NULL,
    "curatedSelectionId" TEXT NOT NULL,
    "originalItemId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "priceText" TEXT,
    "currency" "Currency" NOT NULL DEFAULT 'RUB',
    "imageUrl" TEXT,
    "url" TEXT,
    "description" VARCHAR(500),

    CONSTRAINT "CuratedSelectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CuratedSelection_shareToken_key" ON "CuratedSelection"("shareToken");
CREATE INDEX "CuratedSelection_ownerId_idx" ON "CuratedSelection"("ownerId");
CREATE INDEX "CuratedSelection_wishlistId_idx" ON "CuratedSelection"("wishlistId");
CREATE INDEX "CuratedSelection_shareToken_idx" ON "CuratedSelection"("shareToken");
CREATE INDEX "CuratedSelection_expiresAt_idx" ON "CuratedSelection"("expiresAt");
CREATE INDEX "CuratedSelectionItem_curatedSelectionId_idx" ON "CuratedSelectionItem"("curatedSelectionId");

-- AddForeignKey
ALTER TABLE "CuratedSelection" ADD CONSTRAINT "CuratedSelection_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CuratedSelection" ADD CONSTRAINT "CuratedSelection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CuratedSelectionItem" ADD CONSTRAINT "CuratedSelectionItem_curatedSelectionId_fkey" FOREIGN KEY ("curatedSelectionId") REFERENCES "CuratedSelection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
