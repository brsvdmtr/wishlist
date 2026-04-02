# Documentation Changelog

> Revision history for WishBoard project documentation.

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
