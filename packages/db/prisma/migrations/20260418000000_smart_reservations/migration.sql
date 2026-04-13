-- AlterTable: Wishlist — Smart Reservations settings
ALTER TABLE "Wishlist" ADD COLUMN "smartReservationsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Wishlist" ADD COLUMN "smartResTtlHours" INTEGER NOT NULL DEFAULT 72;
ALTER TABLE "Wishlist" ADD COLUMN "smartResAllowExtend" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Wishlist" ADD COLUMN "smartResMaxExtensions" INTEGER NOT NULL DEFAULT 2;

-- AlterTable: ReservationMeta — Smart Reservations snapshot + tracking
ALTER TABLE "ReservationMeta" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "ReservationMeta" ADD COLUMN "extensionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReservationMeta" ADD COLUMN "isSmartRes" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReservationMeta" ADD COLUMN "smartResTtlHours" INTEGER;
ALTER TABLE "ReservationMeta" ADD COLUMN "smartResMaxExtensions" INTEGER;
ALTER TABLE "ReservationMeta" ADD COLUMN "smartResAllowExtend" BOOLEAN;

-- CreateIndex
CREATE INDEX "ReservationMeta_isSmartRes_active_expiresAt_idx" ON "ReservationMeta"("isSmartRes", "active", "expiresAt");
