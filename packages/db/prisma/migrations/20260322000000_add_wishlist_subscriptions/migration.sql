-- CreateTable: WishlistSubscription
CREATE TABLE "WishlistSubscription" (
    "id" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "WishlistSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SubscriptionUnread
CREATE TABLE "SubscriptionUnread" (
    "id" TEXT NOT NULL,
    "subId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,

    CONSTRAINT "SubscriptionUnread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WishlistSubscription_wishlistId_subscriberId_key" ON "WishlistSubscription"("wishlistId", "subscriberId");
CREATE INDEX "WishlistSubscription_subscriberId_idx" ON "WishlistSubscription"("subscriberId");
CREATE INDEX "WishlistSubscription_wishlistId_idx" ON "WishlistSubscription"("wishlistId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionUnread_subId_entityId_fieldName_key" ON "SubscriptionUnread"("subId", "entityId", "fieldName");
CREATE INDEX "SubscriptionUnread_subId_idx" ON "SubscriptionUnread"("subId");

-- AddForeignKey
ALTER TABLE "WishlistSubscription" ADD CONSTRAINT "WishlistSubscription_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WishlistSubscription" ADD CONSTRAINT "WishlistSubscription_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionUnread" ADD CONSTRAINT "SubscriptionUnread_subId_fkey" FOREIGN KEY ("subId") REFERENCES "WishlistSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
