# Documentation Changelog

> Revision history for WishBoard project documentation.

---

## 2026-05-02 — Weekly Documentation Update

**6 docs updated** to reflect ~50 commits since the 2026-04-24 weekly update (the 2026-04-30 entry covered Birthday Reminders only):

- **CURRENT_PRODUCT_STATE.md** — Added **Events Calendar v2.1** and **Wishlist Emoji** to Core Features. Added **API Security Layer (Wave 1 P0)** to Operational Toggles. Updated model count `67 → 73`, enum count `35 → 36`. Replaced the "Calendar Screen scaffold" Recently Shipped bullet (now in Core) with API Security, Wishlist Emoji, Bot Network Resilience, Profile race-safe upsert
- **DATA_MODEL.md** — Updated counts to 73 models / 36 enums. Added enum `IdempotencyStatus`. Added 4 new models: `GiftOccasionReminder`, `Holiday`, `CalendarInboxEntry`, `IdempotencyKey`. Updated `GiftOccasion` with v2.1 enrichment fields (emoji, eventTime, location, budget min/max/currency, source, holidayKey, country, three soft-link FKs, five Year-Recap fields). Updated `GiftOccasionIdea` with `imageUrl`. Added `Wishlist.emoji` and `User.calendarOnboardingSeenAt` fields plus the new calendar relations on User
- **API_REFERENCE.md** — Updated header to reflect ~21,300 lines / 220+ handlers. Added Idempotency-Key contract block under Rate Limiters. Updated GiftOccasion CRUD body shapes with all v2.1 fields. Added new **Events Calendar v2.1** subsection: 4 reminder routes, 2 idea-photo routes, 4 calendar-feed/holiday routes, 3 inbox routes, 3 onboarding/year-recap routes (16 new endpoints total)
- **FRONTEND_MAP.md** — Bumped header date. Promoted screen #59 (`calendar`) from "scaffold, backend not connected" to "full feature". Added a new **Wave 4 primitives (provisional)** subsection documenting `PageTitle`, `PickerRow`, `SettingsList`, `TabBar`, `TextField` and the `btnPrimary`/`btnGhost`/`btnSecondary` migration to `<Button>`
- **USER_FLOWS.md** — Bumped header date. Added flow 36: **Events Calendar v2.1**, covering first-launch onboarding, today-context banner, occasion creation (custom emoji + day/month/year date sheets), holiday import (with `(ownerUserId, holidayKey)` dedup), friend-birthday import (with `linkedUserId` SetNull semantics), idea cards with photo upload (multipart lock-only), reminder lifecycle, inbox, mark-DONE/Year-Recap, and edge cases (UTC-midnight `daysUntil`, soft-link SetNull, multipart idempotency)
- **CHANGELOG_DOCS.md** — this entry

**Key shipped features (commits since 2026-04-24):**

- **Events Calendar v2.1** (`e9980b2` + many polish commits) — full feature with backend; holiday & friend-bday import, reminders, inbox, year-recap, expandable idea cards with photos
- **API Security Layer Wave 1 P0** (`cd77290`) — Idempotency keys, per-category rate limits (18 categories), IP throttle. Soft-require on critical routes. Multipart routes lock-only. Three env kill switches (`SECURITY_*_ENABLED`)
- **Wishlist Emoji** (`ec952da`, `77b2713`, `f07351d`) — User-pickable emoji on each wishlist with single-grapheme + emoji-only validation
- **Wave 4 UI primitive adoption** (~30 commits) — 5 new primitives extracted to `packages/ui/`; ~330 raw-color sites migrated to CSS custom properties; all `btnPrimary`/`btnGhost`/`btnSecondary` spread props swapped for `<Button>`
- **Bot Network Resilience** (`3851c4b`, `a496fb0`) — heartbeat watchdog, error-noise filters, lifecycle dead-air alarm, startup-noise silencer
- **Profile race-safe upsert** (`788b3a1`) — replaced fragile `upsert` with `create + catch P2002`
- **Calendar polish** — round 1 (`ea6b568`), round 2 (`6212217`), round 3 (`f610963`), photo upload + price caret (`c420661`), expandable cards + keyboard scroll (`2ad5cb7`), `daysUntil` UTC fix (`05df77f`), explicit `lineHeight` on idea inputs (`a7723e4`)
- **Birthday Reminders polish** (`3a10c2a`, `ef4c707`) — post-review critical fixes + commenters/skip-reasons/conversions audit (already documented 2026-04-30)
- **HeroCard + StickyCTAFade primitives** (`516e775`) and CSS-vars Phase 3 migration (`d46f9e9`, `f5c0bbf`)

**Migrations applied this window:**
- `20260427000000_add_wishlist_emoji`
- `20260428000000_add_events_calendar_v2`
- `20260428000001_seed_holidays_v1`
- `20260429000000_add_idempotency_keys`
- `20260430000000_add_idea_image_url`
- `20260430010000_add_calendar_onboarding_seen`
- `20260430020000_add_birthday_reminders` (covered in 2026-04-30 entry)

---

## 2026-04-30 — Birthday Reminders Feature Documentation

**10 docs updated** to reflect the newly-shipped Birthday Reminders feature (bot-driven social notifications + self-reminders to update wishlist):

- **API_REFERENCE.md** — added Birthday Reminders section with 6 user endpoints + 1 admin metrics endpoint (`GET/PATCH /tg/me/birthday-settings`, `GET /tg/birthday-reminders/muted`, `POST /tg/birthday-reminders/mute`, `DELETE /tg/birthday-reminders/mute/:userId`, `GET /tg/birthday-reminders/resolve/:deliveryId`, `GET /tg/admin/birthday-reminders/metrics`)
- **BACKEND_MAP.md** — added cron job §13 for `processBirthdayReminders` (hourly, 9–22 MSK send window, 50/run retry batch, daily cap 3 friend reminders/recipient, `BIRTHDAY_REMINDERS_ENABLED` kill switch)
- **DATA_MODEL.md** — added 8 new `UserProfile` fields (`notifyBirthdays`, `birthdayFriendReminders`, `birthdayOwnerReminders`, `birthdayAudience`, `birthdayAdvancedWindowsEnabled`, `birthdayPrimaryWishlistId`, `birthdayCustomMessage`, `birthdayOptInPromptSeenAt`) and 2 new models (`BirthdayReminderDelivery`, `BirthdayReminderMute`) with full field tables, indexes, and unique constraints
- **SETTINGS_AND_PRIVACY.md** — added "Birthday reminders" subsection covering opt-in default, recipient opt-out, audience rule (no passive views), Pro-gated 402 fields, mute mechanism, owner day-of soft message policy
- **TELEGRAM_FLOW.md** — added `br_<deliveryId>` deep-link prefix and `bdm:<deliveryId>` callback action for mute. Note that bot does not send the original DM — the API does, with an inline keyboard whose web_app button uses `br_<id>`
- **MONETIZATION.md** — added `birthday_reminders_advanced` to `UpsellContext` union, added 402 row to feature flags table, added §16a Birthday Reminders Monetization with field-by-field Pro gates and downgrade behaviour
- **ANALYTICS_AND_GODMODE.md** — added God Mode dashboard endpoint `/tg/admin/birthday-reminders/metrics` with readiness/delivery/engagement/mutes/scheduler/alerts fields, plus full event list (settings/opt-in/mutes/Pro/scheduler/bot/Mini App attribution/owner attribution) and `birthday.*` pattern row
- **USER_FLOWS.md** — added Flow 35 covering opt-in sheet, scheduler stages, recipient acts on bot DM, owner self-reminder, edge cases (no public wishlist, hideYear, profile private, mute, daily cap, bot blocked, downgrade, Feb-29)
- **CURRENT_PRODUCT_STATE.md** — added Birthday Reminders entry to Recently Shipped
- **CHANGELOG_DOCS.md** — this entry

**Mockup reference:** `docs/design-system/mockups/proposed/birthday-reminders.html` (DRAFT, awaiting promotion to `approved/`).

**FAQ note:** the WishBoard FAQ lives in-app (i18n keys `faq_q*` in `packages/shared/src/i18n.ts`), not as a standalone `docs/FAQ.md`. The seven proposed Q/A entries (where birthday data comes from, who can see it, age display consent, how to disable, why notifications arrive, how to mute one person, no-public-wishlist behaviour) are unmerged pending the human owner's decision on whether to add them to the in-app FAQ accordion.

---

## 2026-04-24 — Weekly Documentation Update

**6 docs updated** to reflect ~111 commits (April 17–24):

- **CURRENT_PRODUCT_STATE.md** — screen count 58→59 (calendar), yearly PRO plan, v2.1 UI refresh, FloatingNav, appearance customisation, updated feature flags
- **DATA_MODEL.md** — added `themePreference` and `accentPreference` fields on `User` model
- **API_REFERENCE.md** — updated `GET /tg/me/plan` response (`proYearlyPriceStars`, `appearance`, `billingPeriod`); updated `POST /tg/billing/pro/checkout` for monthly/yearly param; updated `PATCH /tg/me/settings` for appearance
- **MONETIZATION.md** — added yearly PRO plan (800 XTR one-time), updated Plans table, added env vars, updated checkout flow, added PRO renewal reminders section
- **FRONTEND_MAP.md** — screen count 58→59, added `calendar` screen, updated `Screen` type union, updated `C` color values to v2.1 palette, added FloatingNav and appearance theme docs, added `UpsellContext 'appearance'`
- **CHANGELOG_DOCS.md** — this entry

**Key shipped features:**

- **v2.1 UI Refresh** — 80 wave items (W1–W80) complete; glass morphism, mesh gradients, accent glow across all screens
- **FloatingNav** — persistent bottom nav globally replaces outer home tab bar (W47/W69)
- **Yearly PRO Plan** — 800 XTR one-time; monthly/yearly paywall toggle; renewal reminder DMs at 7d and 1d before expiry
- **Appearance Customisation** (PRO) — theme dark/black + accent violet/blue/pink/green; stored server-side on `User`
- **Calendar Screen** — new UI scaffold (W30), backend stub pending
- **Billing resilience** — `createTgInvoiceLink` retry wrapper; 503 on TG API timeout instead of 500

---

## 2026-04-17 — Weekly Documentation Update

**7 docs updated** to reflect changes from ~50 commits (April 10–17):

- **CURRENT_PRODUCT_STATE.md** — added 13 new features, updated counts (67 models / 35 enums / 58 screens / 14 SKUs)
- **DATA_MODEL.md** — added 9 new models, 4 new enums, new fields on User/UserProfile/Wishlist/ReservationMeta/Comment
- **API_REFERENCE.md** — added ~40 new endpoints (showcase, curated selections, secret reservations, item placements, referral, profile subscriptions, don't gift per-wishlist, link management)
- **MONETIZATION.md** — added 2 new SKUs (secret_reservation_unlock 24 XTR, smart_reservations_unlock 15 XTR), 14 total
- **FRONTEND_MAP.md** — added 12 new screens (gift-notes-onboarding, first-share-prompt, curated-view, link-management, guest-link-expired, item-unavailable, secret-reservation-detail, secret-reservation-paywall, showcase-editor, showcase-preview, referral, referral-history), 58 total
- **USER_FLOWS.md** — added 7 new flows (Secret Reservations, Smart Reservations, Showcase, Curated Selections, Profile Subscriptions, Referral Program, Item Placements), 34 total
- **CHANGELOG_DOCS.md** — this entry

**Key shipped features:**

- Showcase — PRO premium profile with cover, bio, sizing preferences, pinned wishlists
- Curated Selections ("часть вишлиста") — share a subset of items via PRO temp link with subscriptions
- Smart Reservations — time-limited reservations with auto-release, reminders, extensions (per-wishlist add-on)
- Secret Reservations — reserve items without owner seeing who reserved (24 XTR add-on)
- Item Placements — share a single wish across multiple wishlists
- Profile Subscriptions — follow users' public profiles
- Referral Program (gated) — invite-a-friend PRO rewards, fraud detection, admin dashboard
- Per-wishlist Don't Gift — three-mode settings (global/custom/disabled) per wishlist
- Comment Quick Reply — threaded replies from notifications
- Link Management — view and revoke all active share links
- Gift Notes onboarding — demo-first paywall and 4-step onboarding

---

## 2026-04-10 — Weekly Documentation Update

**19 docs updated** to reflect changes from 35 commits (April 3--10):

- **CURRENT_PRODUCT_STATE.md** — added 5 new features (Group Gift, Categories, Don't Gift, Maintenance Recovery, Market Segmentation), updated counts
- **DATA_MODEL.md** — added 7 new models, 1 enum, new fields on Item and UserProfile (58 models / 31 enums total)
- **API_REFERENCE.md** — added ~30 new endpoints (group gift suite, categories, don't gift, maintenance)
- **MONETIZATION.md** — added 2 new SKUs (reservation_pro_unlock 50 XTR, group_gift_unlock 79 XTR), 12 total
- **FRONTEND_MAP.md** — added 10 new screens (5 group gift, faq, changelog, legal, legal-doc, onboarding-manual), 46 total
- **USER_FLOWS.md** — added 3 new flows (Group Gift, Categories, Don't Gift), 27 total
- **CHANGELOG_DOCS.md** — this entry

**Key shipped features:**

- Wishlist Categories (full-stack: schema, API, frontend, i18n)
- Group Gift / Совместный подарок (full-stack: 3 new models, 13 API endpoints, 5 screens, 138 i18n keys)
- Don't Gift profile restrictions (PRO feature)
- Maintenance recovery notification system
- Market segmentation analytics infrastructure
- God Mode analytics dashboard redesign
- First-touch source attribution
- Promo-based win-back rewards

---

## 2026-04-02 — Full Documentation Audit

**Scope**: All 19 existing docs updated, 6 new docs created.

### Updated docs

- **INDEX.md** — counts (51 models/30 enums, 36 screens), file sizes, new docs added to map, documentation rules section
- **MONETIZATION.md** — add-on SKU store (10 SKUs), credits system, Gift Notes billing, promo system
- **ACCESS_MATRIX.md** — add-on/credits capabilities, updated entitlements, new routes
- **API_REFERENCE.md** — full endpoint audit (157 routes), new domain sections
- **BACKEND_MAP.md** — updated stats, middleware chain, missing sections
- **TELEGRAM_FLOW.md** — long polling fix, support bridge, deep links, Telegram Stars billing
- **USER_FLOWS.md** — onboarding v2, Gift Notes, add-ons, promo, lifecycle/degradation flows
- **FRONTEND_MAP.md** — 36 screens, 6 locales, RTL, missing screens documented
- **FRONTEND_API_MAP.md** — updated API bindings, 100+ endpoints
- **ARCHITECTURE.md** — long polling, add-ons/credits/lifecycle architecture
- **DATA_MODEL.md** — 51 models, 30 enums, missing models/enums added
- **INFRA_AND_ENV.md** — env vars updated, Docker services verified
- **SETTINGS_AND_PRIVACY.md** — language mode (auto/manual), 6 locales, support ID
- **LINK_IMPORT.md** — marketplace list, pipeline architecture, confidence scoring
- **KNOWN_GAPS_AND_RISKS.md** — new risks added, resolved risks removed
- **BACKUP_CHECKLIST.md** — light refresh, date update
- **RECOVERY_RUNBOOK.md** — model count fix, date update
- **MASTER_RESTORE_GUIDE.md** — light refresh, date update
- **CRITICAL_BACKUP_ACTIONS.md** — light refresh, date update

### New docs

- **CURRENT_PRODUCT_STATE.md** — production feature inventory, rollout states, constraints
- **ONBOARDING_AND_ACTIVATION.md** — onboarding v2, activation logic, experiment flags
- **WEB_EXPANSION_AND_AUTH_MODEL.md** — web/Telegram auth model, public pages
- **ANALYTICS_AND_GODMODE.md** — God Mode dashboard, locale segments, funnel metrics
- **OPERATIONS_RUNBOOK_LIGHT.md** — quick ops reference, post-deploy checks
- **CHANGELOG_DOCS.md** — this file

### Key corrections

- Model/enum counts: 49/14 → 51/30
- Screen count: 33 → 36
- File sizes updated to actual values (API ~11,964, MiniApp ~16,663, bot ~1,190, url-parser ~1,059)
- Bot runtime: "webhook/polling" → "long polling"
- i18n: was ru+en only → now 6 locales (ru, en, zh-CN, hi, es, ar)
- Added missing shipped features: add-on SKUs, credits, Gift Notes, promo, lifecycle, locale segments, Secret Santa, support bridge
