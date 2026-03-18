-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('RUB', 'USD');

-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('ALL', 'LINK_ONLY', 'SUBSCRIBERS', 'NOBODY');

-- CreateEnum
CREATE TYPE "SubscribePolicy" AS ENUM ('ALL', 'LINK_ONLY', 'APPROVED', 'NOBODY');

-- AlterTable: add currency to Item
ALTER TABLE "Item" ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'RUB';

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "username" TEXT,
    "bio" VARCHAR(300),
    "avatarUrl" TEXT,
    "birthday" TIMESTAMP(3),
    "hideYear" BOOLEAN NOT NULL DEFAULT false,
    "defaultCurrency" "Currency" NOT NULL DEFAULT 'RUB',
    "notifyComments" BOOLEAN NOT NULL DEFAULT true,
    "notifyReservations" BOOLEAN NOT NULL DEFAULT true,
    "notifySubscriptions" BOOLEAN NOT NULL DEFAULT true,
    "notifyMarketing" BOOLEAN NOT NULL DEFAULT false,
    "profileVisibility" "ProfileVisibility" NOT NULL DEFAULT 'ALL',
    "subscribePolicy" "SubscribePolicy" NOT NULL DEFAULT 'ALL',
    "commentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "hintsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "newWishlistPosition" TEXT NOT NULL DEFAULT 'top',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_username_key" ON "UserProfile"("username");

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
