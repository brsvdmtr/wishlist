-- AddColumn: Wishlist.archivedAt (soft-archive wishlists)
ALTER TABLE "Wishlist" ADD COLUMN "archivedAt" TIMESTAMP(3);
