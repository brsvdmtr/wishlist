-- v2.1 Appearance preferences (theme + accent) for the runtime
-- ThemeProvider switcher in the Mini App. Free users get dark+violet
-- (defaults below); PRO users unlock black + blue/pink/green.
--
-- Server-side validation lives in PATCH /tg/settings/appearance.

ALTER TABLE "User"
  ADD COLUMN "themePreference"  TEXT NOT NULL DEFAULT 'dark',
  ADD COLUMN "accentPreference" TEXT NOT NULL DEFAULT 'violet';
