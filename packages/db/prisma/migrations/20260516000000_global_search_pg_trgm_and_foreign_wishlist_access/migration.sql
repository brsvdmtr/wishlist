-- Global Search foundations.
--
-- 1) pg_trgm extension — enables ILIKE/LIKE acceleration via GIN trigram
--    indexes. Postgres ships it as a contrib module on every supported
--    platform (including the Vultr-managed Postgres prod uses); if this
--    fails the search feature must stop at this migration (we made typo
--    tolerance part of the scope). Owner runs the migration as the DB
--    superuser, which has CREATE EXTENSION privilege.
-- 2) ForeignWishlistAccess — history of (user, wishlist) opens for foreign
--    wishlists. Used as a scope source for global search. Never a
--    permission grant; live access is re-checked at search/click time.
--    `sourceRef` pins the credential used to open the wishlist so a
--    revoked / regenerated shareToken drops the row from the search scope
--    even though the table row itself stays.
-- 3) GIN trigram indexes on the title/description/url/name fields the
--    search service queries.
--
-- Production-lock notes (audited 2026-05-16):
--   - All target tables are < 200k rows at current prod scale; CREATE INDEX
--     (non-CONCURRENTLY, holds AccessExclusiveLock during create) takes
--     low-single-digit seconds at this volume. Acceptable downtime spike;
--     no maintenance window required.
--   - If the prod row count grows past ~5M, future GIN additions should
--     migrate via raw SQL outside Prisma's transaction wrapper using
--     `CREATE INDEX CONCURRENTLY`. The indexes here are the baseline;
--     follow-up indexes go in their own migrations.
--   - The partial index predicates (`WHERE col IS NOT NULL`) keep the
--     indexes tight on tables where the field is nullable, avoiding
--     wasted space on null rows.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── ForeignWishlistAccess ──────────────────────────────────────────────────
CREATE TABLE "ForeignWishlistAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "firstOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForeignWishlistAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ForeignWishlistAccess_userId_wishlistId_key"
    ON "ForeignWishlistAccess"("userId", "wishlistId");

CREATE INDEX "ForeignWishlistAccess_userId_lastOpenedAt_idx"
    ON "ForeignWishlistAccess"("userId", "lastOpenedAt");

CREATE INDEX "ForeignWishlistAccess_wishlistId_idx"
    ON "ForeignWishlistAccess"("wishlistId");

ALTER TABLE "ForeignWishlistAccess"
    ADD CONSTRAINT "ForeignWishlistAccess_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ForeignWishlistAccess"
    ADD CONSTRAINT "ForeignWishlistAccess_wishlistId_fkey"
        FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Trigram indexes for global search ──────────────────────────────────────
-- All gin_trgm_ops over lower(...) so `lower(title) ILIKE '%q%'` is index-
-- accelerated AND case-insensitive. Same operator class accelerates prefix
-- matches `lower(title) LIKE 'q%'` that the service uses for ranking.

CREATE INDEX "Wishlist_title_trgm_idx"
    ON "Wishlist" USING gin (lower("title") gin_trgm_ops);

CREATE INDEX "Wishlist_description_trgm_idx"
    ON "Wishlist" USING gin (lower("description") gin_trgm_ops)
    WHERE "description" IS NOT NULL;

CREATE INDEX "Item_title_trgm_idx"
    ON "Item" USING gin (lower("title") gin_trgm_ops);

CREATE INDEX "Item_description_trgm_idx"
    ON "Item" USING gin (lower("description") gin_trgm_ops)
    WHERE "description" IS NOT NULL;

CREATE INDEX "Item_url_trgm_idx"
    ON "Item" USING gin (lower("url") gin_trgm_ops);

CREATE INDEX "WishlistCategory_name_trgm_idx"
    ON "WishlistCategory" USING gin (lower("name") gin_trgm_ops);

CREATE INDEX "UserProfile_displayName_trgm_idx"
    ON "UserProfile" USING gin (lower("displayName") gin_trgm_ops)
    WHERE "displayName" IS NOT NULL;

CREATE INDEX "UserProfile_username_trgm_idx"
    ON "UserProfile" USING gin (lower("username") gin_trgm_ops)
    WHERE "username" IS NOT NULL;

CREATE INDEX "GiftOccasion_title_trgm_idx"
    ON "GiftOccasion" USING gin (lower("title") gin_trgm_ops);

CREATE INDEX "GiftOccasion_personName_trgm_idx"
    ON "GiftOccasion" USING gin (lower("personName") gin_trgm_ops)
    WHERE "personName" IS NOT NULL;
