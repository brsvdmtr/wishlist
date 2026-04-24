# Documentation Changelog

> Revision history for WishBoard project documentation.

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
