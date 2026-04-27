-- Add nullable imageUrl to gift-occasion ideas. Stores the photo path
-- (relative /api/uploads/<file>) populated by POST /tg/gift-occasion-ideas/:id/photo.
ALTER TABLE "GiftOccasionIdea" ADD COLUMN "imageUrl" TEXT;
