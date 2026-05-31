# Documentation Changelog

> Revision history for WishBoard project documentation.

---

## 2026-05-31 — Weekly Documentation Update

**6 docs touched** to reflect the **20 product commits on `origin/main` since the 2026-05-29 weekly pass** (`4cd16f2..a04679c`). Counts held steady at **81 models / 38 enums / 61 screens** — the dead `Tag`/`ItemTag` tables were dropped (−2) and the two E23 Santa pre-season models added (+2), a net wash.

- **DATA_MODEL.md** — Added the E23 models `SantaPreseasonTouch` (per-`(userId, seasonYear)` teaser-DM ledger: A/B variant, segment, send-state, per-touch mute; the >15%-mute kill-switch counts this table directly) and `SantaPreseasonBroadcast` (per-season status latch / write-once lock); bumped the Secret Santa subsystem note **20 → 24 models** (the prose had already drifted 2 behind). Documented `User.godModeActive` (operator on/off toggle restored 2026-05-29; ANDed with env eligibility, can only suppress) and marked `User.godMode` **deprecated/inert**. Added the `santaPreseasonTouches[]` relation. Header note records the Tag-drop / Santa-add count wash. Migrations: `20260529120000_add_user_god_mode_active`, `20260530120000_add_santa_preseason`, `20260530120000_drop_tags`.
- **API_REFERENCE.md** — Added **`GET /admin/billing/reconcile`** (read-only cross-table billing reconciliation; mutations stay CLI-only via `pnpm billing:reconcile`). Noted removal of the legacy tag admin endpoints. Rewrote `POST /tg/me/god-mode` to toggle `godModeActive` (env-eligibility-gated, suppress-only). Added the **binary-vs-weighted experiment-resolver** contract under § A/B Experiments — `WEIGHTED_EXPERIMENT_KEYS` (`yearly-price`), the refusal guard on the binary path / public route, and the shared `persistFirstExposure`.
- **MONETIZATION.md** — Added a **Pricing A/B experiments** table at the top: E17 yearly-price (3-way 800→{600,1000}⭐, first weighted experiment), E24 group-gift-price (79→39⭐), growth-first-limits — all **deployed-but-DORMANT**, with their enable-envs and status docs.
- **FRONTEND_MAP.md** — Documented the **E13 passive guest-view banner** (`GuestViewBanner`, `lib/guestBannerCta.ts`, `guest_banner.*` telemetry) on the `guest-view` screen; noted the decomposition fully landing (last `SettingsRoot`/`PublicProfileRoot` inline IIFEs deleted, `monolith-guards.test.ts` render-site guard, ~1.3k LOC shed) and the removal of fake-interactive "coming soon" stubs (5 dead i18n keys deleted across 6 locales). Screen count held at 61.
- **USER_FLOWS.md** — Added the E13 banner as step 11 of Flow 6 (Guest Viewing), cross-linked to Flow 37 (E11 claim).
- **CURRENT_PRODUCT_STATE.md** — Updated the count-verification note (Tag-drop / Santa-add wash); prepended 7 **Recently Shipped** entries (billing reconciliation, E23 Santa pre-season teaser, Santa funnel analytics, E13 guest banner, dormant pricing experiments, god-mode toggle restoration, dead-Tag removal).
- **CHANGELOG_DOCS.md** — this entry.

**Headline shipped work (20 commits, `4cd16f2..a04679c`):**

- **Billing reconciliation** (`8c9ce22`, hardened `c735a02`/`fdb8127`/`fcc5252` to 10/10) — read-only cross-checks of `PaymentEvent`/`Subscription`/`Purchase` + idempotent CLI relink; `GET /admin/billing/reconcile`; operator runbook.
- **E23 Santa pre-season teaser DM** (`b865df4`) — segmented, A/B-controlled, mute kill-switch; dormant until ~Nov 1. **Secret Santa funnel analytics** (`78a69ad`) — 5 server-authoritative funnel events, anonymity-preserving.
- **E13 passive guest-view banner** (`be3d8bb`, env-wired `ce092d6`, mockup approved `9f360b3`) — ambient guest→owner growth nudge.
- **Pricing experiments, all dormant** — E17 3-way yearly-price (`2f85dcd`, regression guards `a04679c`/`2035051`), E24 group-gift-price (`955ced8`), growth-first-limits (`a049a01`).
- **God-mode** (`8a5eeb5`) — restored the operator on/off toggle (`godModeActive`), decoupled from env eligibility.
- **Dead Tag feature removed** (`dc3dd35` + `306b854`) — code, Prisma models, admin endpoints, docs.
- **Mini App decomposition finish** — render extracted `PublicProfileRoot`/`SettingsRoot`, delete inline IIFEs (`df3e62b`, `56a6b16`); remove fake "coming soon" placeholders (`f34e5a6`).

**Migrations applied this window:**
- `20260529120000_add_user_god_mode_active` — `User.godModeActive` (Boolean, default true).
- `20260530120000_add_santa_preseason` — `SantaPreseasonTouch` + `SantaPreseasonBroadcast`.
- `20260530120000_drop_tags` — drops `Tag` + `ItemTag` tables.

> **Process note:** local `main` had diverged from `origin/main` (1 unpushed duplicate of the billing commit + a large co-mingled working tree of in-flight parallel work). This pass was authored in an **isolated worktree based on `origin/main`** so the docs reflect deployed reality and push as a clean fast-forward, without touching the shared local tree.

---

## 2026-05-29 — Weekly Documentation Update

**5 docs touched** to reflect ~50 product commits since the 2026-05-20 counter refresh (the 2026-05-28 `docs(changelog)` release note covered the prose CHANGELOG; the structured docs below had drifted on counts, monetization model, and the Mini App architecture). MONETIZATION.md was already refreshed in-flight on 2026-05-28 (conservative-pricing pass) and needed no further change this pass.

- **DATA_MODEL.md** — Count bumped **78 → 81 Prisma models** (enums steady at 38). Added 3 new model entries: `HintQuotaCharge` (immutable per-delivered-hint ledger, unique on `hintId`, denormalized non-FK so it outlives its `Hint`; migration `20260521000000`), `ExperimentAssignment` (A/B sticky-bucket, unique `(userId, experimentKey)`; migration `20260522120000`), `UserDailyActivity` (per-user/per-UTC-day product-loop rollup surviving the 90-day AnalyticsEvent TTL; PK `(userId, date)`; migration `20260520000000`). Added `Wishlist.isDefault` + partial unique index `(ownerId) WHERE isDefault = true` (one default per owner; migrations `20260525120000` + `20260525130000`). Added `UserCredits.freeImportsUsed` / `freeImportsPeriod` (free-tier monthly URL-import quota; migration `20260520120000`). Synced `User` relations, indexes table, and ER overview.
- **API_REFERENCE.md** — Router count 23 → 25. **Added:** `GET /tg/experiments/:key` (sticky A/B variant + `experiment.assigned`), 4 research-survey routes (`GET /tg/research/surveys/by-invite/:inviteId`, `.../answer`, `.../complete` [idempotency `critical`], `.../dismiss`), `POST /internal/hints/credit` (bot-called charge-on-delivery, idempotent on `hintId`). **Changed:** hints (PRO gate → FREE monthly quota + `hints_pack_*`), URL import (PRO → FREE monthly quota, credit consumed only on parse ok/partial), reservations (dropped `reservationBeta`, secret-reservation miss 403 → 402), categories (PRO-only → FREE 1 / PRO 20, only CREATE gated, Serializable txn + P2034 `CATEGORY_CONCURRENT_WRITE` 409), Santa hints (FREE 1/campaign), `GET /tg/me/profile` (E04 default-wishlist side effect), onboarding `post_reservation_claim` entry (E11). **New sections:** unified paywall error envelope (402/403/409), CF Worker image proxy (noted as a Cloudflare Worker, not an Express route), 4 new rate-limiter categories.
- **FRONTEND_MAP.md** — Reclassified `MiniApp.tsx` from a ~30k-line monolith to a composition root + first-paint shell after the **F0–F7 decomposition**. Documented 9 cold-path lazy `*Root.tsx` clusters (Santa ~3.3k, Profile ~1.96k, GuestView, GroupGift, Showcase, Settings, GiftNotes, Referral, PublicProfile), 9 extracted `hooks/use*State.ts`, 18 `lib/` modules, `_shared/closure-types.ts`, and the cluster-Root `ctx`-prop pattern. Screen count held at **61** (decomposition added/removed zero screens; the two ToC-missing members `search` + `research-survey` were filled in). Added patterns: lazy cluster loading, chunk-load retry + stale-HTML reload, `useExperiment` (tgReady-gated), E11 post-reservation CTA, E15 reservation display-name prefill; Skeleton primitive now in `@wishlist/ui`.
- **USER_FLOWS.md** — Plans Reference: participants **5 → 10**, added Categories row (1 free / PRO 20), URL-import + hints cells rewritten to free-quota + paid-credits. **Flow 4** retitled "(PRO)" → "(free quota + paid credits)" and rewritten (allowance gate, charge-on-delivered-value, lazy monthly reset, `importQuota` payload). **Flow 9 (Hints)** retitled + rewritten to the FREE-quota charge-on-delivery model (`HintQuotaCharge` ledger, contact-picker mechanic, anti-spam, grace delivery); corrected a stale 72-hour-nudge description. **New Flow 37: Guest → Account Claim (E11)** — experiment-gated post-reservation account-claim CTA (`e11-post-reserve-cta`, `post_reservation_claim` onboarding entry, `guest_owner_cta.*` telemetry). Flow 17 cancel-list annotated (URL-import/hints revert to FREE quota, not lost). ToC updated.
- **CURRENT_PRODUCT_STATE.md** — Models 78 → **81** (named the 3 new models + verification command); enums 38 / screens 61 held. Plan limits: participants 10, url_import/hints moved to "freemium with monthly quotas", categories 1 free / 20 PRO. Referral Program flipped Disabled → **Rolled out (100%), re-enabled 2026-05-28**. 12 new **Recently Shipped** entries prepended.
- **CHANGELOG_DOCS.md** — this entry.

**Headline shipped work since 2026-05-20 (~50 commits):**

- **Conservative-pricing / freemium pivot** — URL import opened to FREE tier (`8a898c7`) with a monthly quota (`UserCredits.freeImportsUsed`/`freeImportsPeriod`, default 5/UTC-month + paid `import_pack_*`), credit consumed only on parse ok/partial; global marketplace parsing + JD.com adapter (`2f8082e`) + scraper-API retry/skip-hopeless/soft cap (`45d8d68`). Hints dropped the hard PRO gate for a FREE monthly quota (`e17452c`) with charge-on-delivery via the new `HintQuotaCharge` ledger (`20260521000000`). Categories went partially-free (1 free/wishlist, 20 PRO; `d7a9c8e`). Santa hint 1/campaign FREE then PRO + `seasonal_decoration` hidden from inventory (`5b9e8f8`). FREE participant limit raised 5 → 10 (`c5bdfb4`). Unified 402/403/409 paywall error envelope across all monetization surfaces (`3f184d7`); reservation PRO contract aligned (`6374154`).
- **A/B experiment infrastructure (Phase 0)** (`81f237c`) — `ExperimentAssignment` sticky-bucket model + `GET /tg/experiments/:key` + `useExperiment` hook gated on `tgReady` to close an initData/401 race (`c2f07a4`).
- **E11 guest-conversion** (`0268fe2`) — experiment-gated post-reservation account-claim CTA for guests; `guest.converted_to_user` first-touch attribution (`90e8f01`) + funnel close (`b5ff648`); operator force-show god-mode (`7ce8b69`) and 3 review-gap fixes (`47f39b3`).
- **E04 default wishlist** (`b9fadd2`) — auto-create a default wishlist for new users; `Wishlist.isDefault` + partial-unique-per-owner index, P2002-then-refetch race handling.
- **E15 reservations review pass** (`a13339a`, `1112809`, `b823a2e`) — display-name prefill from Telegram identity, group-gift migration, KPI enrichment, a11y; surprise-mode privacy invariant pinned (`37e3d60`).
- **Mini App performance — F0–F7 decomposition** — lazy-loaded screen clusters via `next/dynamic` (`9c1e220`, `701fcd9` GuestView ~1.16k, `ce894ea` Santa ~3.16k, plus Profile/Showcase/GroupGift/Settings/GiftNotes/Referral waves), `lib/` + `use*State` hook extraction (`d533f1d`..`5312e7a`), main chunk down to ~295 KB brotli (`f05ead7`). ChunkLoadError auto-retry + stale-HTML 404 auto-reload (`d0f9116`, `53a5b36`); web-chunk durability across deploys (`1f762cf`). Skeleton primitive moved to `@wishlist/ui` (`85bd2a8`).
- **Security wave** — Mini App XSS hygiene + URL-scheme allowlist (`989762d`, `22c9ff3`), DNS-pinning + magic-byte guard + Helmet headers (`547f74b`), Telegram HTML escaping + Serializable txn on item create/restore (`39fe627`), env-only god-mode dropping `User.godMode` DB persistence (`c8564a8`), Santa-campaign cascade on account delete (`2daacd6`), idempotency integration tests on 4 critical routes (`55f2f5c`), CF Worker image proxy (`6e36e20`, `f880d6e`).
- **Next.js 15.5.18 + React 19** (`7e67821`) — CVE-2026-44578 fix; nginx WebSocket-upgrade block kept as defense-in-depth (`a31d2b5`); async-params regression tests (`e4de658`).
- **Referral program re-enabled** at 100% rollout (`06e4eb3`, after `ef19418` disable + gate-closure), with attribution analytics tagging (`1081376`, `3e3e2f6`).
- **Owner-side "Open wish" inline button** on reservation DMs (`3333cf3`).
- **Maintenance worker v2.1 redesign** + CF Worker L1 exposure buffer (`8943664`), pass-through of API 5xx JSON to fetch/XHR clients (`7a022f1`).

**Migrations applied this window (since `20260520000000`):**
- `20260520000000_add_user_daily_activity` — `UserDailyActivity` rollup table (PK `(userId, date)`).
- `20260520120000_add_free_import_quota` — `UserCredits.freeImportsUsed` + `freeImportsPeriod`.
- `20260521000000_add_hint_quota_charge` — `HintQuotaCharge` ledger (unique on `hintId`).
- `20260521084802_reconcile_schema_drift` — schema-drift reconciliation (no model change).
- `20260522120000_add_experiment_assignment` — `ExperimentAssignment` (unique `(userId, experimentKey)`).
- `20260525120000_add_wishlist_is_default` — `Wishlist.isDefault` (Boolean, default false).
- `20260525130000_unique_default_wishlist_per_owner` — partial unique index `(ownerId) WHERE isDefault = true`.

---

## 2026-05-20 — Counter refresh + CURRENT_PRODUCT_STATE.md added to doc-guard

**6 docs + 1 script** to clear `scripts/doc-guard.sh` failures on every push to `main`. Counts had drifted past commits `06332cd` (research-survey: 4 Prisma models + 2 enums) and `7a70069` (Mini App `research-survey` screen), plus earlier 2026-05 commits that bumped totals without refreshing the counters.

- **INDEX.md, DATA_MODEL.md, FRONTEND_MAP.md, CURRENT_PRODUCT_STATE.md** — counter strings bumped to current truth: **78 Prisma models, 38 enums, 61 screens** (derived from `packages/db/prisma/schema.prisma` and the `type Screen` union in `apps/web/app/miniapp/MiniApp.tsx:699-710`). `Last updated` bumped to 2026-05-20 on each.
- **DESIGN_DECISIONS.md** — two `RU+EN` occurrences (lines 489, 891) paraphrased to `Russian + English` so the `RU+EN` stale-pattern check passes. Substance unchanged.
- **scripts/doc-guard.sh** — four hardcoded count assertions (`51 Prisma models, 30 enums`, `51 models`, `36 screens` × 2) bumped to current truth. Added two new assertions against `CURRENT_PRODUCT_STATE.md` (`78 Prisma models` and `61 screens`) so future drift surfaces here too — the previous drift hid for ~3 weeks because that doc wasn't on the guard's truth-marker list.
- **Deferred:** previous canonical strings (`51 models`, `30 enums`, `36 screens`) were NOT added to `stale_patterns` — they appear in this changelog and `RECOVERY_RUNBOOK.md` history; adding them would require per-file excludes. A "compute counts dynamically" refactor of `doc-guard.sh` was also considered and deferred — out of scope for this maintenance pass.
- **CHANGELOG_DOCS.md** — this entry

---

## 2026-05-15 — Weekly Documentation Update

**6 docs touched** to reflect 11 commits since the 2026-05-08 update (`ac8bca6` Pro Lifetime feature already refreshed MONETIZATION/SERVICES/DATA_MODEL § Subscription billingPeriod in-flight):

- **CURRENT_PRODUCT_STATE.md** — Bumped header to 2026-05-15. Added **Pro Lifetime** to Monetization section ("100 XTR/month, **800 XTR/year**, or **2 490 XTR lifetime**"). Added a dedicated **Multi-signal market bucket resolver (2026-05-08)** entry under Analytics (5-signal priority chain, browser headers, geoip-lite, atomic upsert helper, bot `/start` capture, `LOCALE_DETECTION_ENABLED` switch). Added 4 new **Recently Shipped** entries: Pro Lifetime tier (2026-05-09), Multi-signal market bucket resolver (2026-05-08), Item image perf — local cache + lazy load (2026-05-08), Bulk-select bottom bar polish (2026-05-08)
- **DATA_MODEL.md** — Bumped header to 2026-05-15. Added 3 new `User` fields: `lastName`, `username`, `isPremium` (captured opportunistically from Telegram initData / bot `/start`; migration `20260508000000_user_telegram_identity_fields`)
- **API_REFERENCE.md** — Bumped header to 2026-05-15. Added a new **Optional locale-detection request headers** subsection under Auth Headers documenting `X-Browser-Language` (navigator.language) and `X-Browser-Timezone` (Intl) with ASCII validation and the `LOCALE_DETECTION_ENABLED` kill switch. Updated `GET /tg/me/plan` row to include `proLifetimePriceStars` (2 490) and `billingPeriod='lifetime'`. Updated `POST /tg/billing/pro/checkout` to accept `plan='lifetime'` and document the already-lifetime short-circuit response `{ alreadySubscribed: true, lifetime: true }`. Updated subscription `cancel` / `reactivate` rows to document the **409 `lifetime_cannot_cancel`** error
- **FRONTEND_MAP.md** — Bumped header to 2026-05-15. Added new **Pro Lifetime tile (paywall + Settings)** subsection: 2+1 layout, gold tile, ∞ glyph, "Навсегда" badge, Settings lifetime variant, success bottom-sheet, mockup reference. Added **Bulk-select bottom bar (2026-05-08)** subsection: `C.surface` → `C.bg` switch, FAB hidden during selection, mode-aware scroll padding (210/110/90). Added **Item image rendering (2026-05-08)** subsection: lazy/async hints on all 19 `<img>` renders, locally-cached sources for URL-imported items
- **USER_FLOWS.md** — Bumped header to 2026-05-15. Rewrote **Flow 16: PRO Subscription Purchase** to cover the 3-plan paywall (Monthly / Yearly / Lifetime), the `plan` body param, the already-lifetime short-circuit, the celebratory success sheet, and the **lifetime downgrade-protection** edge case (stale `pro_monthly` / `pro_yearly` charges audited as `payment_success_post_lifetime`). Added a lifetime-specific edge case to **Flow 17: PRO Subscription Cancellation** noting hidden CTAs and the 409 backend backstop
- **CHANGELOG_DOCS.md** — this entry

**Headline shipped work since 2026-05-08 (11 commits):**

- **Pro Lifetime tier** (`ac8bca6`) — Third Pro SKU at **2 490 ⭐** one-time, permanent entitlement, no expiry. `Subscription.billingPeriod='lifetime'` is the canonical discriminator; `currentPeriodEnd=2099-12-31` is a sentinel, never used for comparison. Lifetime overrides monthly/yearly on upsert; subsequent stale charges are audited via `payment_success_post_lifetime` and **never** downgrade the row. New API: `plan='lifetime'` on checkout, 409 `lifetime_cannot_cancel` on cancel/reactivate, `proLifetimePriceStars` on `/tg/me/plan`, already-lifetime short-circuit on checkout. Schedulers exclude lifetime via explicit `NOT { billingPeriod: 'lifetime' }` (defensive — sentinel date already keeps it out). Frontend: full-width gold tile in every paywall sheet (variant Б pivot), Settings lifetime card with "Навсегда" pill and hidden cancel CTA, celebratory success sheet. 17 i18n keys × 6 locales. Mockup `pro-lifetime-v1.html` Variant A approved 2026-05-09
- **Multi-signal market bucket resolver** (`82e627d`, `17f768a` code-review iter1) — Closes a 287/375 "unknown" gap on the Сегменты god-mode dashboard. Resolver priority: `lang_code → X-Browser-Language → X-Browser-Timezone → IP country (geoip-lite, lazy + prewarmed) → first_name script regex`. Mini App sends two new request headers. Bot `/start` upserts UserProfile so bot-only users finally get bucketed (closes the 107-user gap immediately for new starts). Atomic SQL upsert (`packages/db/locale-persistence`) is the single source of truth — never downgrades known→unknown. New `User.{lastName,username,isPremium}` (migration `20260508000000_user_telegram_identity_fields`). One-shot backfill `backfill-market-buckets.ts`. 31 unit tests on the resolver chain. Kill switch `LOCALE_DETECTION_ENABLED`. iter1 fixes: dropped trailing $4 fallback that locked-in 'unknown', single atomic upsert on bot `/start`, ASCII validation on the new headers, expanded Unicode coverage in `deriveMarketBucketFromName` (Cyrillic Supplement, Arabic Supplement / Extended / Presentation Forms, Devanagari Extended)
- **Item image perf — local cache + lazy load** (`f98c247`, `3746872` iter 2–5 hardening) — URL-imported items used to store raw external CDN URLs (multi-MB Yandex `/orig`); Mini App rendered all `<img>` eagerly, kicking off ~28 parallel downloads on a 28-item wishlist. Fix: `url-import` runs the parsed image through the existing sharp pipeline (resize 1600 / mozjpeg q80), stores it under `/api/uploads/`, falls back to the remote URL on failure. All 19 item-image `<img>` get `loading="lazy"` + `decoding="async"`. Hardening loop (7.5 → 8 → 7 → 8.5 → 9/10): `limitInputPixels=50M` decompression-bomb guard, strict mime allowlist (no SVG), stream-and-cap on response body, transactional `createItemWithPlacement` so a placement failure rolls back the Item row, `freshlyCachedFilename` tracking for safe orphan cleanup, `unlinkAndLog` helper to surface non-ENOENT failures, strict `--limit` validation on backfill script, `--dry-run` no longer touches network/disk. One-shot backfill `backfill-item-images.ts` for the 78 existing remote-URL items
- **Bulk-select bottom bar polish** (`7cfc983`, `319a36a`, `de48d96`, `2a6255e` docs) — Two-defect cluster: translucent `C.surface` background let items/FAB/counter bleed through (switched to solid `C.bg`); `gridTemplateColumns` was out of sync with child count after `curated_bulk_btn` was added in `f0c5dac`; FAB ("+") not gated on selection modes. Container scroll padding now mode-aware (210 bulk / 110 curated / 90 default). Documented in BUGFIX_LESSONS.md
- **Build fixes** (`341ef74`, `f7c099d`) — `apps/api/src/index.ts` had three leaked `PRO_LIFETIME_PRICE_XTR` imports from an uncommitted parallel branch (TS2305 fail on prod build); fixed forward by removing them. `Dockerfile.bot` build order swapped to build `@wishlist/shared` before `@wishlist/db` since `packages/db/locale-persistence` now imports from shared

**Migrations applied this window:**
- `20260508000000_user_telegram_identity_fields` — adds `User.lastName`, `User.username`, `User.isPremium` (additive; nullable + boolean default false; no data backfill required, captured opportunistically by auth middleware + bot `/start`)

No new Pro Lifetime migration — the Subscription model already had `billingPeriod` as a String, so the lifetime tier shipped without a schema change (purely a value addition + sentinel `currentPeriodEnd=2099-12-31`).

---

## 2026-05-08 — Weekly Documentation Update

**4 docs touched** in this weekly summary; most thematic docs already refreshed in-flight by their commits this week (`docs(api): refresh after P5s closure`, `docs(api): refresh architecture after route and scheduler extraction`, `docs: align ops runbooks with Vultr-first prod state`, `docs(bugfix-lessons): hint window mismatch`, etc.):

- **CURRENT_PRODUCT_STATE.md** — Bumped header to 2026-05-08. Added 6 new **Recently Shipped** entries: API Architecture Refactor closure (P1–P5s), API Security Wave 2, Vultr migration, Contextual reminder deep links, Logging hardening, Hint delivery resilience, Support handoff polish. Expanded **Operational Toggles** to cover Wave 2 security coverage, the Vultr production move, and the new logging cap / `pino-roll` host bind-mount / weekly prune TTL changes
- **API_REFERENCE.md** — Replaced the outdated `~21,300 lines, 220+ handlers` sub-header with the post-refactor reality: `index.ts` is now a **1,789-LOC composition root**; route handlers live in 23 domain routers under `apps/api/src/routes/`; 13 services + 9 schedulers extracted. Endpoints unchanged; only source files moved. Added a **Wave 2 expansion** paragraph to the rate-limit / idempotency section
- **FRONTEND_MAP.md** — Bumped header date. Fixed stale "Calendar — UI scaffold only; backend not yet connected" comment in the Screen Type Union (calendar shipped 2026-04-28 as full feature)
- **CHANGELOG_DOCS.md** — this entry

**Headline shipped work since 2026-05-02 (~60 commits):**

- **API Architecture Refactor — P1–P5s closure** (~45 refactor commits, `eec4b13` + `0090d5f` doc refreshes) — `apps/api/src/index.ts` reduced from ~21,300 LOC to **1,789 LOC** (composition root). 23 domain routers split out (`me`, `referral`, `lightweight tg`, `support`, `birthday-reminders`, `promo`, `gift-notes`, `onboarding`, `selections-archive`, `reservations`, `comments-hints`, `group-gifts`, `billing`, `items`, `wishlists`, `santa`, …). 9 cron schedulers extracted (`cleanup`, `billing`, `referral`, `santa`, `reservations`, `events`, `lifecycle`, `pro-renewal`, `birthday-reminders`). 13 services extracted (`entitlement`, `telegram-auth`, `core helpers`, `url-import`, `analytics`, `referral-hooks`, `santa-season`, plus the previously-shipped `birthday-reminders`, `calendar`, `items`, `lifecycle`, `locale`, `onboarding`, `wishlists`). New backend code MUST go to routes/services/schedulers — `index.ts` is closed
- **API Security Wave 2** (`2aa4d15`, `5726c81`, `dc7e561`, `bbd427b`, `bb575a8`, `754e53b`, `6d9d9c9`) — Idempotency + rate-limit coverage extended to Santa actions, gift-notes (web + api), items Pro extras (priority bump, photo upload multipart), categories, subscriptions, P4 misc state-changing routes. Closes the remaining gap from Wave 1 P0; `/tg/*` POST/PATCH/DELETE coverage is now full
- **Vultr production migration** (`0e7a9f6` + `d26720f`, `f6b32c0`, `e4a4de9` doc updates) — Production moved Timeweb → Vultr Amsterdam (`199.247.24.125`). `git push` deploys via GitHub Actions; ops via `admin-ops.yml`. SSH alias `Host vultr`. Old Timeweb VPS being decommissioned
- **Contextual reminder deep links** (`b5c0e1c` reservations, `2531f53` gift occasions) — New start-param prefixes `rrem_<itemId>__m_<metaId>` and `evnt_<occasionId>` route reminder bot DMs to the relevant entity in the Mini App. Distinguishes 404, 403 `gift_notes_required`, and other errors. Helpers in `apps/api/src/telegram/deepLinks.ts`; parsers in `apps/web/app/miniapp/startParam.ts`. +11 unit tests
- **Logging hardening** (`bb8bdf2`, `1e85ab6`) — Docker `json-file` driver capped 20m × 5 across api/bot/web/postgres; `pino-roll` to host bind-mount (`/opt/wishlist/logs/{api,bot}/`); ops cron `logrotate` weekly × 8 gzip; weekly Docker prune 168h → 72h (build cache had hit 37 GB on 94 GB disk). Bot logger reverted from stalled `pino-roll` worker to main-thread multistream + structured startup logs
- **Hint delivery resilience** (`491a2ba`, `fa0b52d`, `6574323`, `02e2975`, `1e9f65d` revert, `5ac98e8`, `b517c1d`, `95c5707`) — first-click fast & idempotent; cancel stale SENT hints on the 30-min lookup window match; retry recipient `sendMessage` 3× 5s on network failure; reword anonymity confirmation copy. Bot startup classifies aborts as transient and silences config noise. IPv6-first DNS revert (RKN-blocked IPv4 to Telegram still requires the SNAT workaround)
- **Support handoff polish** (`ddd8bae`, `8698d3a`) — `/tg/support/contact` shows active plan, deduplicates metadata in bot DM, Mini App closes after handoff. Misc DX: `APP_RELEASE` env populated from git HEAD during deploy (`053c102`)

**Migrations applied this window:** none (no schema changes since 2026-04-30; last migration was `20260430020000_add_birthday_reminders` covered in the 2026-05-02 entry).

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
