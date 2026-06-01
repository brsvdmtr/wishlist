-- Circles (Близкие) — P0.1
-- Private groups of close people: Circle + CircleMembership + CircleInvite +
-- CircleWishlistShare. Surprise invariant lives at the service layer.

-- CreateEnum
CREATE TYPE "CircleType" AS ENUM ('FAMILY', 'FRIENDS', 'COLLEAGUES', 'COUPLE');

-- CreateEnum
CREATE TYPE "CircleRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "CircleMemberStatus" AS ENUM ('ACTIVE', 'LEFT');

-- CreateTable
CREATE TABLE "Circle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CircleType" NOT NULL,
    "emoji" TEXT,
    "coverUrl" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Circle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleMembership" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CircleRole" NOT NULL DEFAULT 'MEMBER',
    "status" "CircleMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "CircleMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleInvite" (
    "token" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleInvite_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "CircleWishlistShare" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "sharedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleWishlistShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Circle_ownerId_idx" ON "Circle"("ownerId");

-- CreateIndex
CREATE INDEX "CircleMembership_userId_status_idx" ON "CircleMembership"("userId", "status");

-- CreateIndex
CREATE INDEX "CircleMembership_circleId_status_idx" ON "CircleMembership"("circleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CircleMembership_circleId_userId_key" ON "CircleMembership"("circleId", "userId");

-- CreateIndex
CREATE INDEX "CircleInvite_circleId_idx" ON "CircleInvite"("circleId");

-- CreateIndex
CREATE INDEX "CircleWishlistShare_circleId_idx" ON "CircleWishlistShare"("circleId");

-- CreateIndex
CREATE INDEX "CircleWishlistShare_wishlistId_idx" ON "CircleWishlistShare"("wishlistId");

-- CreateIndex
CREATE UNIQUE INDEX "CircleWishlistShare_circleId_wishlistId_key" ON "CircleWishlistShare"("circleId", "wishlistId");

-- AddForeignKey
ALTER TABLE "Circle" ADD CONSTRAINT "Circle_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMembership" ADD CONSTRAINT "CircleMembership_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMembership" ADD CONSTRAINT "CircleMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleInvite" ADD CONSTRAINT "CircleInvite_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleWishlistShare" ADD CONSTRAINT "CircleWishlistShare_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleWishlistShare" ADD CONSTRAINT "CircleWishlistShare_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "CircleReservation" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "reserverUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CircleReservation_circleId_idx" ON "CircleReservation"("circleId");

-- CreateIndex
CREATE INDEX "CircleReservation_itemId_idx" ON "CircleReservation"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "CircleReservation_itemId_reserverUserId_key" ON "CircleReservation"("itemId", "reserverUserId");

-- AddForeignKey
ALTER TABLE "CircleReservation" ADD CONSTRAINT "CircleReservation_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleReservation" ADD CONSTRAINT "CircleReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
