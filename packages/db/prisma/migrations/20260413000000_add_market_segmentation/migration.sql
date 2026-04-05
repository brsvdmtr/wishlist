-- Add market segmentation fields to UserProfile
ALTER TABLE "UserProfile" ADD COLUMN "normalizedLocale" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "marketBucket" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "supportedImportRegion" BOOLEAN;

-- Backfill existing users from their stored language (raw Telegram language_code)
-- normalizedLocale: same logic as normalizeLocale() in i18n.ts
UPDATE "UserProfile" SET "normalizedLocale" = CASE
  WHEN "languageMode" = 'manual' AND "manualLanguage" IS NOT NULL THEN "manualLanguage"
  WHEN language IS NOT NULL THEN CASE
    WHEN LOWER(language) LIKE 'ru%' THEN 'ru'
    WHEN LOWER(language) LIKE 'en%' THEN 'en'
    WHEN LOWER(language) LIKE 'zh%' THEN 'zh-CN'
    WHEN LOWER(language) LIKE 'hi%' THEN 'hi'
    WHEN LOWER(language) LIKE 'es%' THEN 'es'
    WHEN LOWER(language) LIKE 'ar%' THEN 'ar'
    ELSE 'en'
  END
  WHEN "defaultCurrency" = 'RUB' THEN 'ru'
  ELSE 'en'
END
WHERE "normalizedLocale" IS NULL;

-- marketBucket: fine-grained segmentation (does NOT default unknowns to 'en')
UPDATE "UserProfile" SET "marketBucket" = CASE
  WHEN "languageMode" = 'manual' AND "manualLanguage" IS NOT NULL THEN
    CASE
      WHEN "manualLanguage" = 'ru' THEN 'ru'
      WHEN "manualLanguage" = 'ar' THEN 'ar'
      WHEN "manualLanguage" = 'en' THEN 'en'
      WHEN "manualLanguage" = 'hi' THEN 'hi'
      WHEN "manualLanguage" = 'zh-CN' THEN 'zh-CN'
      WHEN "manualLanguage" = 'es' THEN 'es'
      ELSE 'other_known'
    END
  WHEN language IS NOT NULL THEN CASE
    WHEN LOWER(language) LIKE 'ru%' THEN 'ru'
    WHEN LOWER(language) LIKE 'ar%' THEN 'ar'
    WHEN LOWER(language) LIKE 'en%' THEN 'en'
    WHEN LOWER(language) LIKE 'hi%' THEN 'hi'
    WHEN LOWER(language) LIKE 'zh%' THEN 'zh-CN'
    WHEN LOWER(language) LIKE 'es%' THEN 'es'
    ELSE 'other_known'
  END
  WHEN "defaultCurrency" = 'RUB' THEN 'ru'
  ELSE 'unknown'
END
WHERE "marketBucket" IS NULL;

-- supportedImportRegion: true only for Russian market
UPDATE "UserProfile" SET "supportedImportRegion" = ("marketBucket" = 'ru')
WHERE "supportedImportRegion" IS NULL;
