-- Drop the Tag / ItemTag subsystem (dead feature — see docs/research/tags-decision.md).
-- Zero organic data in prod (only seed rows on the demo wishlist); the job tags
-- solved (item grouping) is covered by WishlistCategory. All code consumers were
-- removed first (admin CRUD, public ?tag filter + tags includes, public-web tag UI,
-- admin tag UI + proxy routes, seed). This migration is the contract step.
--
-- Rollback: re-create the tables/indexes/FKs exactly as defined in the init
-- migration 20260210151944_init (DDL preserved in docs/research/tags-decision.md §10.2).

-- DropForeignKey
ALTER TABLE "ItemTag" DROP CONSTRAINT "ItemTag_itemId_fkey";
ALTER TABLE "ItemTag" DROP CONSTRAINT "ItemTag_tagId_fkey";
ALTER TABLE "Tag" DROP CONSTRAINT "Tag_wishlistId_fkey";

-- DropTable
DROP TABLE "ItemTag";
DROP TABLE "Tag";
