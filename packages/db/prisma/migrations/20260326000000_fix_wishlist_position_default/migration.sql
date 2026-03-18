-- Fix default for newWishlistPosition: "top" was the wrong default for FREE users.
-- "top" is a PRO feature; FREE users should default to "bottom".
-- Existing stored "top" values for FREE users are handled at API layer (normalized in GET response).
ALTER TABLE "UserProfile" ALTER COLUMN "newWishlistPosition" SET DEFAULT 'bottom';
