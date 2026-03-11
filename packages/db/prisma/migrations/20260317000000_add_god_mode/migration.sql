-- AlterTable: add godMode flag to User
ALTER TABLE "User" ADD COLUMN "godMode" BOOLEAN NOT NULL DEFAULT false;
