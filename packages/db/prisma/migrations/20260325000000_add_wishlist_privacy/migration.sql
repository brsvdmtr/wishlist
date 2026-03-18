-- CreateEnum
CREATE TYPE "WishlistVisibility" AS ENUM ('LINK_ONLY', 'PUBLIC_PROFILE', 'PRIVATE');

-- CreateEnum
CREATE TYPE "AllowSubscriptions" AS ENUM ('ALL', 'NOBODY');

-- CreateEnum
CREATE TYPE "CommentPolicy" AS ENUM ('ALL', 'SUBSCRIBERS');

-- AlterTable: add privacy columns with safe defaults
ALTER TABLE "Wishlist"
  ADD COLUMN "visibility"         "WishlistVisibility" NOT NULL DEFAULT 'LINK_ONLY',
  ADD COLUMN "allowSubscriptions" "AllowSubscriptions" NOT NULL DEFAULT 'ALL',
  ADD COLUMN "commentPolicy"      "CommentPolicy"      NOT NULL DEFAULT 'ALL';
