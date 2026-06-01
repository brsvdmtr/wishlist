# Event Pass — Specification (Research / Pre-Implementation)

> **Status:** SPEC ONLY — no code, no tariff changes, no migrations.
> Document is a decision artefact for E21 (см. `docs/research/06-experiment-backlog.md`).
> Owner: product · Date: 2026-05-25 · Target review: pre-Santa season (≤ 2026-10-31).

This spec extends and refines the E21 entry in the experiment backlog and the
Variant C ("Event-pass-first") section of
`docs/research/03-monetization-paywall-audit.md` § 12. It is intentionally
narrower than Variant C: one SKU, fixed price, one bundle, four messaging
contexts. Multi-pass architecture (Birthday Pass + Santa Pass + NY Pass as
distinct SKUs) is **out of scope** for this spec — that is E22/E23/E24
territory and presupposes a green E21.

---

## 1. Scenarios — when the Pass surfaces

Event Pass is a **single SKU** with **four UX entry points** (messaging
contexts). It is not four different SKUs. The bundle is identical regardless
of entry context; only the headline copy changes.

| # | Scenario | Surface (where the Pass tile appears) | Trigger condition |
|---|----------|----------------------------------------|-------------------|
| 1 | **Birthday** | Paywall sheet when FREE user hits `birthday_reminders_advanced` context (PATCH `/tg/me/birthday-settings` 402). Also: Settings → birthday-reminders preview screen, in the −30 d → +14 d window around `User.birthday`. | `birthdayDate IS NOT NULL` AND now ∈ `[birthday − 30d, birthday + 14d]` |
| 2 | **Santa** | Paywall sheet when FREE user hits any of `santa_multi_wave`, `santa_exclusions`, `santa_exclusion_groups` 402. Also: Santa-create form when `type=MULTI_WAVE` is chosen; Santa pre-season DM (`E23`) and Settings Santa card during `[Nov 1 – Jan 15]`. | Any Santa PRO gate hit OR season window |
| 3 | **New Year** | Paywall sheet on `showcase`, `curated_selections`, `smart_reservations` 402/403 during `[Dec 15 – Jan 15]`. Also: standalone Settings banner during the window. | Date ∈ `[Dec 15, Jan 15]` AND user is FREE |
| 4 | **Group Gift** | `POST /tg/billing/group-gift/checkout` paywall card — added as second tile next to the 79 XTR permanent unlock. Wording: "Or get full PRO for 30 days — includes group gift + reservation pro + url import." | User opens group-gift paywall AND has no `group_gift_unlock` add-on |

**Why one SKU, not four.** Four SKUs = four funnels, four analytics surfaces,
four i18n bundles, four expiry edge cases, four "which pass do I need?"
support tickets. The hypothesis we are testing in E21 is **"does the
non-recurring 49 XTR pricing point convert more buyers than Monthly?"** — that
is a price-pointing question, not a feature-bundling question. Bundling
optimisation is a follow-up experiment after E21 reads green.

**Group Gift is included intentionally.** Currently `group_gift_unlock` is a
permanent 79 XTR add-on, decoupled from PRO. Adding it to Event Pass creates a
**parallel path**: 79 XTR perma OR 49 XTR/30d Pass. We do not remove the
permanent add-on; we add a competing time-bound offer. The risk is captured
in § 6 (cannibalisation of `group_gift_unlock` revenue) and addressed in the
decision rule § 7.

---

## 2. Bundle — what's included

The Pass grants **full PRO entitlements for 30 days** with three deliberate
exclusions (see § 3). For the user, the Pass *feels* like Monthly except:

- It does not auto-renew.
- It costs ~half of Monthly (49 XTR vs 100 XTR).
- It is explicitly framed as "for one event".

| Category | Inclusions inside the Pass |
|----------|----------------------------|
| **Plan limits** | wishlists 10, items 70 / list, participants 20, subscriptions 5 (= PRO defaults) |
| **Core features** | comments, URL import (unlimited), hints (unlimited), advanced privacy (visibility/subs/comments policies) |
| **Reservation PRO** | history, private notes, reminders, purchased flag, filters & sort (= `hasReservationPro` cluster) |
| **Birthday** | All 4 `birthday_reminders_advanced` fields (audience EXTENDED, primaryWishlistId, customMessage, advanced windows) |
| **Santa** | `MULTI_WAVE` campaigns, pair exclusions, group exclusions (= the 3 currently-gated Santa PRO features) |
| **Group Gift** | Same access as `group_gift_unlock` add-on (create collections, invite, manage contributions) — **active only while the Pass is active** |

**Entitlement resolver impact.** `getUserEntitlement` already returns
`isPro: true` for any active `Subscription` row with
`status ∈ ('ACTIVE', 'CANCELLED')` AND `currentPeriodEnd > now()`. A
`billingPeriod='event_pass'` row satisfies that check by construction, so all
PRO gates flip to "unlocked" without per-route changes. The only resolver
work is exposing `billingPeriod` to the UI (already done — Settings reads
`subscription.billingPeriod`).

**Group Gift access via Pass.** Group-gift access is exposed today as the
`hasGroupGift` field on `getEffectiveEntitlements`' return value, computed
at `apps/api/src/services/entitlement.ts:299`:
```ts
hasGroupGift: godMode || addOns.some(a => a.addonType === GROUP_GIFT_SKU)
```
To include Group Gift inside Event Pass, the predicate becomes
`godMode || isPro || addOns.some(...)`. That is a one-line change at the
single predicate site (out of scope for this spec — captured in § 5.4).
Consumers (`routes/group-gifts.routes.ts:194`, `routes/billing.routes.ts:484`,
`routes/items.routes.ts:112`, `routes/wishlists.routes.ts:153`) read the
field, not the predicate, so no consumer changes are needed.

---

## 3. Exclusions — what's NOT in the Pass (anti-cannibalisation)

These are deliberately **kept out** so Monthly retains a defensible value
proposition over 30 days, and so Lifetime keeps a 24-month moat over a stack
of 12 Passes.

| Excluded benefit | Where Monthly still wins | Rationale |
|------------------|--------------------------|-----------|
| **Showcase + curated selections** | Showcase is the canonical "always-on" PRO surface — public profile, curated lists. Requires continuity; a 30-day on/off cycle would confuse subscribers and break SEO/referral. | Discontinuous showcase = dead links + lost followers. Recurring users need recurring billing. |
| **Smart Reservations** (per-list, currently 15 XTR add-on) | Per-wishlist permanent unlock model is incompatible with a 30-day window — owner enables smart res on a wishlist *and then keeps it on indefinitely*. | Smart res lifecycle is per-list-permanent, not per-user-temporal. Pass user would lose the wishlist's smart-res config every 30 days. |
| **Secret Reservation** (24 XTR add-on) | Already decoupled from PRO; keeping it out of Pass keeps the impulse-buy add-on funnel intact. | Add-on conversion is already healthy; bundling subtracts from a working channel. |
| **Renewal reminders** | Pass is explicitly **non-recurring** — no 7d/1d "your pass expires" DM. Just a one-time "Pass active" confirmation at purchase. | Reminder = renewal nudge = recurring-feel. Pass marketing is "buy once for the event"; a reminder undermines that frame. (Re-evaluated in § 7 decision rule.) |

**Why these four and not others.** The boundary line is:
- **In-Pass:** features whose value is fully consumed within a 30-day event
  window (a birthday happens once, a Santa season runs once, a group gift
  collection completes in days/weeks).
- **Out-of-Pass:** features whose value is **continuity** (showcase, smart-res
  per-list config) or already monetised on a working separate channel
  (secret reservation, smart reservations).

This is the testable hypothesis: that the in/out split correctly carves the
two populations (event-buyers vs. continuity-buyers) into two SKUs.

---

## 4. Pricing — 49 XTR / 30 days

**Launch test price: 49 XTR for 30 days.** Non-recurring.

| Comparable | Price | Period | Pass premium / discount |
|------------|-------|--------|--------------------------|
| Monthly (current) | 100 XTR | 30 days (auto-renew) | Pass is **−51 %** of Monthly for same window |
| Yearly (current) | 800 XTR | 365 days (one-time) | Monthly equiv ~66 XTR; Pass is **−26 %** vs Monthly-equiv |
| Lifetime | 2 490 XTR | permanent | 12 Passes/yr would equal lifetime in ~4.2 years — does NOT undercut |
| `group_gift_unlock` (perma) | 79 XTR | permanent | Pass at 49 XTR underprices add-on; mitigated by 30-day expiry |
| `gift_notes_unlock` | 19 XTR (PRO bundled) | permanent | Pass owns gift notes through PRO bundle |

**Env-var name:** `PRO_EVENT_PASS_PRICE_XTR=49`. Follows the existing
`PRO_PRICE_XTR=100` / `PRO_YEARLY_PRICE_XTR=800` / `PRO_LIFETIME_PRICE_XTR=2490`
pattern in `apps/api/src/services/entitlement.ts:68–70`.

**Period:** 30 days = `2592000` seconds (= `PRO_SUBSCRIPTION_PERIOD`).
Reuse the constant rather than introducing `PRO_EVENT_PASS_PERIOD_SECONDS`
unless we ever want a different window (e.g. 60 days for Birthday Pass in a
follow-up experiment).

**Currency:** XTR (Telegram Stars). Same as all current monetisation.

**Bucket strategy for the experiment.** E21 ships 50/50 on the four entry
contexts in § 1. Pass tile shown to ~50 % of FREE users hitting those contexts;
the other ~50 % see only the existing Monthly / Yearly / Lifetime tiles.
Assignment via `getExperimentAssignment(userId, 'e21_event_pass')` — the
stable-hash sticky bucketing in `apps/api/src/services/experiments.service.ts`.
Sticky for the row's lifetime (no manual TTL needed; rows persist per the
existing experiment-service convention). See § 5.5 for the full plumbing.

**Price is a test value, not a final price.** Decision rule § 7 specifies what
happens to price at 30 / 60 / 90 days based on observed elasticity. Pricing
review at +60 days is **mandatory**, not optional.

---

## 5. Required changes — checklist (spec, NOT implementation)

The list below is **what the implementation PR would need to do**. None of it
is being done in this document. The list exists so the eventual PR can be
scoped accurately and so § 6 risks have concrete coupling surfaces.

### 5.1 Schema / DB

- **`Subscription.billingPeriod`** is already a `String?` (not a Prisma
  enum) — see `packages/db/prisma/schema.prisma:431`. Adding the string
  literal `'event_pass'` requires **no migration**. The lifetime guard in
  `apps/bot/src/payments.ts:69` already checks
  `billingPeriod === LIFETIME_BILLING_PERIOD`; nothing else hard-codes the
  set of valid values.
- The `@@unique([userId, planCode])` constraint on `Subscription` means
  one user has at most one PRO row. A user buying Event Pass **upserts**
  the same row as Monthly/Yearly/Lifetime — see § 5.4 for downgrade
  semantics. **Implication for analytics:** stacking a second Pass
  (§ 6.4) produces one `Subscription` row but two `PaymentEvent` rows.
  Emit `event_pass.purchased` **per `PaymentEvent` row**, not per
  `Subscription` upsert — otherwise the second purchase disappears from
  funnels and § 7.3's "repurchase rate within 60 days" metric is
  unmeasurable. Same rule for refund handling (§ 5.10).
- New analytics events (dot-separated, lowercase to match project
  convention used by `subscription.expired`, `santa.gate_hit`, etc.):
  `event_pass.paywall_shown`, `event_pass.cta_clicked`,
  `event_pass.purchased`, `event_pass.expired`,
  `event_pass.repurchased_within_60d`.
  Added to `packages/shared/src/analyticsEvents.ts`. No DB schema change.
  All five emitted via `trackProductEvent` so they land in
  `AnalyticsEvent` with consistent userId / props shape.

### 5.2 Expiry scheduler

The existing **subscription-expiry scheduler** in
`apps/api/src/schedulers/billing.ts:76–109` already sweeps every
`Subscription` row where `status ∈ ('ACTIVE','CANCELLED')` AND
`currentPeriodEnd ≤ now()` AND `billingPeriod != 'lifetime'`. A row with
`billingPeriod='event_pass'` is picked up **for free** by this sweep —
no new scheduler module is needed.

What IS new: a single `event_pass.expired` analytics emit inside the
existing per-row loop (already emits `subscription.expired`; we add a
branch on `billingPeriod === 'event_pass'`).

E21 backlog entry hints at a dedicated `event-pass-expiry` scheduler —
that's actually wrong for our current code, the existing one covers it.
This spec corrects the backlog entry.

### 5.3 Payment handling

A new bot processor `applyProEventPassPayment` in
`apps/bot/src/payments.ts`, modelled on the existing
`applyProYearlyPayment` (which is also one-time, non-recurring):

- Invoice payload format: `pro_event_pass:<tgId>:<sessionId>`
- Currency literal: `'XTR'` (Telegram Stars), exact-string match to
  Monthly/Yearly/Lifetime — `PaymentEvent.currency` is a `String`
  column, drift to `'xtr'` or `'Stars'` would break dashboards.
- Idempotency via `PaymentEvent.telegramPaymentChargeId` `@unique` (same as
  monthly/yearly).
- Lifetime guard branch: a Pass purchase by a lifetime user records
  `payment_success_post_lifetime` audit event and **does not overwrite**
  the lifetime row. (Same pattern as monthly/yearly already do.)
- `Subscription` upsert: `billingPeriod='event_pass'`, `currentPeriodEnd =
  startFrom + 30d`, `cancelAtPeriodEnd=true` (nothing to auto-renew),
  `status='ACTIVE'`. See § 5.4 for `startFrom`.
- `PaymentEvent.eventType='payment_success_event_pass'` (new value).
- New `PaymentOutcome` variant `{ kind: 'pro_event_pass_activated'; subId;
  periodEnd; stackedFromExisting }` returned to the bot wrapper.

A matching new branch in the bot's `pre_checkout_query` validator must
recognise the `pro_event_pass:` payload prefix and accept it.

**Honest read of the Lifetime guard.** The "lifetime guard" branch above
audits with `payment_success_post_lifetime` but **does not refund** — by
the time `successful_payment` reaches the bot, Stars have already been
debited. This is the same flawed-by-design behaviour
`applyProMonthlyPayment` and `applyProYearlyPayment` have today
(`apps/bot/src/payments.ts:69–84` and `:183–198`). Pass mirrors the
existing pattern rather than fixing it upstream; the upstream fix is out
of scope for E21 but the symptom is tracked as a pre-launch verification
step in § 7.1.

### 5.4 Downgrade / stacking logic

This is the **most subtle** of the changes. Three cases:

| Buyer's current state | Pass purchase behaviour |
|-----------------------|--------------------------|
| **FREE** (no active sub) | New row: `billingPeriod='event_pass'`, `currentPeriodEnd = now + 30d`. Trivial. |
| **Active Monthly** (`billingPeriod='monthly'`, auto-renewing) | **BLOCK at checkout** (return `alreadySubscribed=true`). Monthly user buying Pass doubles up — Monthly continues auto-billing while Pass adds nothing visible. Confusing + wasteful. Mirror the existing duplicate-Monthly block in `apps/api/src/routes/billing.routes.ts:226`. |
| **Active Yearly / Cancelled-Monthly / Cancelled-Event-Pass** (non-recurring sub still in window) | **STACK**: `startFrom = max(now, existingSub.currentPeriodEnd)`, `currentPeriodEnd = startFrom + 30d`. Same pattern as `applyProYearlyPayment` at `apps/bot/src/payments.ts:202–208`. Keeps the user's remaining paid time intact. |
| **Active Lifetime** | **LIFETIME GUARD**: record `payment_success_post_lifetime` audit, do not overwrite. Same as monthly/yearly do today. Bot replies with "you already have permanent PRO" message. |

**Reverse downgrade** (Pass active, user buys Monthly/Yearly/Lifetime):

- **Monthly**: this is a real behavioural change, not a one-liner.
  Today the duplicate-Monthly block at
  `apps/api/src/routes/billing.routes.ts:226` fires only when
  `!ent.subscription.cancelAtPeriodEnd`. A Pass user has
  `cancelAtPeriodEnd=true`, so the block does **not** trigger and
  `applyProMonthlyPayment` in `apps/bot/src/payments.ts:60–89` would
  overwrite the row with `now + 30d`, shortening the Pass's remaining
  paid time. **Two options:**
  (a) Treat Pass-then-Monthly as a true upgrade — explicitly
  encouraged, do not stack (the user is moving from one-shot to
  recurring, that's the funnel we want).
  (b) Mirror Yearly's `max(now, currentPeriodEnd)` stacking in
  `applyProMonthlyPayment` so Pass time isn't lost.
  **Recommendation:** (a) — Pass-then-Monthly is the conversion event
  we measure (§ 7.3 "Pass repurchase rate" and the second-Pass
  upsell follow-up); stacking complicates the funnel attribution
  more than it helps users. Emit `billing.crossbuy_pass_then_monthly`
  on the upsert so we can see how often it happens and revisit if
  users complain about lost days. Document the choice in the
  implementation PR.
- **Yearly / Lifetime**: same stack/overwrite rules already in place;
  no Pass-specific change beyond the analytics tag.

**API endpoint change.** `POST /tg/billing/pro/checkout` body schema
extends:
```ts
plan: z.enum(['monthly', 'yearly', 'lifetime', 'event_pass']).optional()
```
and the `plan === 'event_pass'` branch sets price = `PRO_EVENT_PASS_PRICE_XTR`,
omits `subscription_period` from the invoice body (one-time, like yearly),
and emits payload `pro_event_pass:<tgId>:<sessionId>`.

### 5.5 UI / Mini App

- Paywall sheet (`ProUpsellSheet` in `apps/web/app/miniapp/MiniApp.tsx`):
  add a 4th tile **below** Monthly/Yearly/Lifetime: "Событийный пасс
  · 49 ⭐ · 30 дней · без автопродления" (RU shown; en/zh-CN/hi/es/ar
  per the i18n keys in § 5.6). Reuse the existing plan-tile pattern
  already used by Monthly/Yearly/Lifetime — that pattern is
  `provisional` in `docs/design-system/COMPONENT_REGISTRY.md`, so
  adding a 4th instance does not require a new primitive. If the
  implementation finds the existing JSX is feature-local clone rather
  than an extracted primitive, pause and surface to design ownership
  per `feedback_design_system_skill` before improvising.
- Bucket gating: tile rendered only when the user is in the treatment
  arm of the experiment. **Use the existing assignment service** —
  `getExperimentAssignment(userId, 'e21_event_pass')` in
  `apps/api/src/services/experiments.service.ts`, which lazy-creates an
  `ExperimentAssignment` row (`@@unique([userId, experimentKey])` —
  schema.prisma:1460-1471). Variant string `'treatment'` or `'control'`.
  Server returns the resolved arm via `/tg/me` (new field
  `experiments.e21_event_pass: 'treatment' | 'control' | null`); the
  paywall reads that arm, not a raw bucket integer. **Do not key on
  `tgUser.id mod 100`** — Telegram IDs are sequential and the modulo
  distribution biases early adopters into low-mod buckets. The
  `experiments.service.ts` hash uses a stable salted hash, matching the
  project convention for all experiment assignments.
- Settings → PRO card while Pass is active: show "Событийный пасс · до
  YYYY-MM-DD" instead of the Monthly/Yearly verbiage. Hide the
  cancel CTA (nothing to cancel; the Pass already ends naturally).
- One-time activation confirmation message (post-purchase bot DM) — NOT
  a renewal reminder. Wording: "Pass активирован до DD-MM. После
  истечения вернёшься на FREE."
- **No 7d / 1d expiry reminders** for Event Pass — see § 3 exclusion.
  The existing `apps/api/src/schedulers/pro-renewal.ts` cron filter
  `OR: [{ billingPeriod: 'yearly' }, { cancelAtPeriodEnd: true }]`
  would catch Pass rows (since they have `cancelAtPeriodEnd: true`).
  To exclude: add `NOT: { billingPeriod: 'event_pass' }` to the WHERE.

### 5.6 i18n

New keys in `packages/shared/src/i18n.ts`. The project ships **6 locales**
(`packages/shared/src/i18n.ts:3` — `'ru' | 'en' | 'zh-CN' | 'hi' | 'es' | 'ar'`)
— every new key must have all 6 entries or the i18n typecheck fails.

- `plan_event_pass_title` — "Событийный пасс" (ru)
- `plan_event_pass_subtitle` — "Полный PRO на 30 дней — для одного праздника"
- `api_invoice_title_event_pass`, `api_invoice_desc_event_pass`,
  `api_invoice_label_event_pass` — TG invoice strings (mirror the
  `_yearly` / `_lifetime` set in the same file).
- `bot_event_pass_activated` — bot DM confirming activation.
- `plan_event_pass_expiry_banner` — in-app banner copy for the day-of
  upgrade nudge (§ 6.6).

All RU strings above are placeholders for product-marketing review; the
en/zh-CN/hi/es/ar set goes through the translator workflow before
launch. AR is RTL — confirm the paywall tile renders correctly under
`isRTL(locale) === true` (`packages/shared/src/i18n.ts:37`).

No new `UpsellContext` value — Pass reuses the 4 existing contexts
listed in § 1 (`birthday_reminders_advanced`, `santa_multi_wave`,
`santa_exclusions`, `santa_exclusion_groups`, plus the entry from
`group_gift_unlock` paywall). The Pass tile appears INSIDE those
existing sheets, not as a separate sheet.

### 5.7 Security layer — MANDATORY (per CLAUDE.md iron rules)

Every new state-changing route or extended checkout path must answer
three questions. Pass extends `POST /tg/billing/pro/checkout`; here are
the answers:

- **Rate-limit category.** Reuse the existing `'payment'` category
  in `apps/api/src/security/rateLimits.ts:67` (5 attempts / 10 min
  per actorHash). Already gates the three existing checkout
  endpoints — Pass is the same endpoint with an extra `plan` value,
  so the `tgRouter.all(...)` middleware chain at `index.ts:1568–1575`
  already covers it. No new category needed; do **not** invent a
  new one.
- **Idempotency action key.** Mini App caller passes
  `idempotency: { action: 'billing.checkout:event_pass' }` to
  `tgFetch`, matching `domain.verb:variant` naming from
  `docs/API_SECURITY.md` § 5. `critical: true` (billing-adjacent).
- **Kill switch.** New env var `EVENT_PASS_DISABLED=true` (default
  `false`) short-circuits the checkout branch (returns
  `{ error: 'event_pass_disabled' }` 503) and hides the paywall tile.
  Loaded in `apps/api/src/bootstrap/` env validation, same shape as
  existing `SECURITY_*_ENABLED` flags.
- **Hashing.** No raw `Idempotency-Key` or raw client IP logged;
  reuse `hashIdempotencyKey` / `hashIp` already in the security
  middleware.
- **Analytics:** `event_pass.purchased` (already listed in § 5.1).
  Must include `{ planCode: 'PRO', billingPeriod: 'event_pass',
  totalAmount, stackedFromExisting: boolean }` props for funnel
  attribution.

### 5.8 Testing checklist — MANDATORY (per CLAUDE.md testing rules)

Every new state-changing endpoint ships with happy + at least one
error path. For Event Pass the eventual PR must include:

- **Unit** (`apps/api/src/services/entitlement.test.ts` extension):
  `getEffectiveEntitlements` returns `hasGroupGift: true` when
  `subscription.billingPeriod === 'event_pass'`. Pure logic; mock Prisma OK.
- **Integration — real Postgres** (`apps/api/test/`, runs in CI):
  1. **Happy path:** FREE user buys Pass → `Subscription` row created,
     `billingPeriod='event_pass'`, `currentPeriodEnd ≈ now + 30d`,
     `cancelAtPeriodEnd=true`, `PaymentEvent.eventType =
     'payment_success_event_pass'`.
  2. **Monthly-block:** Active Monthly user attempts Pass checkout →
     `alreadySubscribed=true`, no invoice URL returned. Mirror
     `billing.routes.test.ts` Monthly-dup test.
  3. **Yearly-stack:** Active Yearly user buys Pass → `currentPeriodEnd
     = existing + 30d`, NOT `now + 30d`. Same shape as the existing
     Yearly-on-Yearly stack test.
  4. **Lifetime-guard:** Lifetime user's payment webhook fires for Pass
     payload → `Subscription.billingPeriod` stays `'lifetime'`,
     `PaymentEvent.eventType = 'payment_success_post_lifetime'`. No
     downgrade.
  5. **Pass-on-Pass stack:** Pass user buys second Pass before expiry
     → one `Subscription` row, end = old_end + 30d, two `PaymentEvent`
     rows. Verifies the per-PaymentEvent analytics rule from § 5.1.
  6. **Expiry sweep:** Insert `event_pass` row with `currentPeriodEnd =
     now - 1h`, run the billing scheduler tick, assert status flipped
     to `EXPIRED` and `subscription.expired` analytics event emitted
     once. Also assert `pro-renewal.ts` does **not** fire a 7d/1d DM
     (per § 5.5 filter).
- **Regression (per `feedback_bugfix_lessons.md`):** any bug fix
  surfaced post-launch must add a failing-before-fix test in the same
  commit.

### 5.9 Add-on coexistence with Event Pass

A user who already owns a permanent add-on (most relevant:
`group_gift_unlock` at 79 XTR) and then buys Event Pass should **keep
the add-on after the Pass expires** — add-ons are independent
`UserAddOn` rows, not coupled to the `Subscription` lifecycle. The
expiry sweep in § 5.2 only touches `Subscription.status`; it never
deletes `UserAddOn` rows. This is correct as-designed; capture it
explicitly in the new MONETIZATION.md § 16b so support understands
what to tell users.

The inverse (no add-on, only Pass) loses Group Gift access on Pass
expiry — that's expected and disclosed at purchase. The post-expiry
"upgrade nudge" (§ 6.6) is the user's chance to convert to Monthly
or buy the permanent add-on if they still need ongoing access.

### 5.10 Refund / chargeback handling

Telegram Stars refunds are initiated server-side by an admin via the
TG admin panel and arrive as a webhook (`pre_checkout_query` is not
involved). When a refund fires for a Pass purchase:

- The bot processor receives the refund webhook and **shortens**
  `Subscription.currentPeriodEnd = now()` (immediate expiry), which
  the existing billing sweep then flips to `EXPIRED` on its next
  tick. Do **not** delete the `Subscription` row — audit-trail
  preservation matters.
- A `PaymentEvent` is recorded with `eventType =
  'payment_refund_event_pass'` and amount negative-mirror.
- Analytics emit `event_pass.refunded` with the original-purchase
  reference (charge ID), so § 7.2 kill-criterion refund-rate metric
  is queryable directly.
- If the refunded Pass was stacked on top of an active Yearly: the
  refund shortens the Pass-extended portion only. Implementation
  detail: track per-PaymentEvent extension delta to support this
  correctly. **Spec gap** — if too complex, the launch fallback is
  "refunds shorten to now() regardless of stacking history" and we
  manually reconcile in support. Choose at implementation time;
  flag as a § 7.1 pre-launch decision.

### 5.11 Documentation updates

The implementation PR must update three docs in the same commit:

**`docs/MONETIZATION.md`**:
- § 2 PRO Benefits table: no new row (Pass shares Monthly's benefits
  with the § 3 exclusions; document the exclusions in a new § 16b
  "Event Pass" subsection).
- § 5 Billing Flow: add `event_pass` to the invoice-payload-formats
  and Subscription-States tables. Add `PRO_EVENT_PASS_PRICE_XTR` to
  the env-vars table.
- § 5 PRO Renewal Reminders: note Pass is excluded.
- New § 16b: "Event Pass Monetization" — mirror the § 16a Birthday
  Reminders subsection structure (pricing, what's gated, downgrade
  behaviour, add-on coexistence — see § 5.9).

**`docs/SCHEDULERS.md`**: the `pro-renewal` entry gets a new
filter-clause note ("excludes `billingPeriod='event_pass'`"). The
`billing-expiry` entry gets a one-line "also handles event_pass"
mention.

**`docs/SERVICES.md`**: only update if the implementation PR
extracts a new `services/event-pass.ts` (e.g. for the
`hasGroupGift` predicate change cascading across routers + bot
processor — meets the 3+ consumer threshold in CLAUDE.md). If the
change stays a one-line predicate tweak in `entitlement.ts`,
`SERVICES.md` does not change.

Per the project documentation discipline, monetisation changes
without a MONETIZATION.md update are treated as undocumented and
get rejected at review.

---

## 6. Risks

In rough order of severity. Each risk has a **measurement hook** — the
experiment is not "see how it feels" but "measure these three numbers and
follow the decision rule in § 7".

### 6.1 Cannibalisation of Monthly

**The mechanic.** Monthly is 100 XTR / 30 days. Pass is 49 XTR / 30 days
covering ~90 % of Monthly's value. A rational user who would have bought
Monthly buys Pass instead — we lose 51 XTR per converted user.

**Mitigation in this spec.** § 3 exclusions (showcase, smart-res,
secret-res, no reminders) make Monthly objectively superior on the
"always-on" axis. The hypothesis is that two distinct user populations
exist and prefer different SKUs. If they don't — we'll see Monthly net
sales fall by approximately the volume of new Pass sales, and the test
fails the § 7 decision rule.

**Measurement.** Two metrics, both daily:
- `monthly_purchases_per_day_test_bucket` vs same in control bucket.
  If test bucket is < 70 % of control, cannibalisation is real.
- `net_xtr_per_paying_user_60d_test` vs control. Total revenue / paying
  user, windowed at 60 days post first paywall hit. The Pass test wins
  only if this is **higher**, not just paying-users-count.

### 6.2 Cannibalisation of `group_gift_unlock` (79 XTR perma)

**The mechanic.** Group Gift add-on is 79 XTR permanent. Event Pass at
49 XTR is cheaper AND includes more (full PRO bundle), but expires after
30 days. Question: how often does a user need group gift after the
first 30 days?

**Hypothesis.** Most group gifts are tied to one event (birthday, NY,
graduation). A user who completes the gift in the first 30 days has no
recurring need; the Pass actually fits their behaviour better. The
add-on at 79 XTR was implicitly over-priced for one-shot use.

**Risk if hypothesis is wrong.** Users buy Pass, finish group gift in
12 days, then return 4 months later for the next gift, hit the paywall
again, buy a second Pass for 49 XTR. After 2 Passes (98 XTR) they've
exceeded the perma price (79 XTR). At Pass purchase #2 they should be
upsold the perma add-on or Monthly, not another Pass. **Decision for
E21:** the per-context cross-upsell branch is **explicitly deferred
out of E21 scope** — E21 tests the Pass offer in isolation, not the
upsell ladder. If § 7.3 promote criteria pass, building the
second-Pass-detection-upsell branch is the first E21-success follow-up
PR. Tracked in § 8 follow-ups.

**Measurement.** Track `group_gift_purchases_per_day` (perma add-on)
separately from Pass purchases. If the perma SKU collapses to < 25 % of
its pre-test baseline AND the same users buy ≥ 2 Passes/yr, the perma
SKU should be deprecated or repriced (E24 territory).

### 6.3 "PRO" becomes confusing

**The mechanic.** Today the UI shows: FREE / PRO. After Pass: FREE /
PRO Monthly / PRO Yearly / PRO Lifetime / PRO Event Pass. Users
hitting "Settings → My Plan" see 4 PRO sub-states. Support tickets:
"why is my PRO ending soon?"; "why can't I cancel my Pass?"; "I bought
Pass and Monthly, did I waste money?".

**Mitigation in this spec.**
- Settings card text branches on `billingPeriod` (already done for
  Lifetime via `isLifetimeSubscription`); Pass gets its own copy line.
- Cancel CTA hidden when `billingPeriod === 'event_pass'` (nothing to
  cancel — same pattern as Lifetime).
- Pass tile in paywall has explicit "без автопродления · истекает
  DD.MM" verbiage so user understands at-purchase that it's a one-shot.
- Post-purchase bot DM repeats the expiry date.

**Measurement.** Bot support intent classifier (or simple keyword grep
on `Comment` table where `text LIKE '%pass%'` and Mini App in-app
feedback) should surface confusion. Pre-launch baseline: count
`%subscription%`/`%pro%`/`%cancel%` mentions in the last 30 days. After
launch: track delta; > +20 % implies confusion.

### 6.4 Multiple active Passes / stacking edge cases

**The mechanic.** User buys Pass on day 1, sees it expires day 30; buys
another Pass on day 15. § 5.4 says we stack:
`max(now, currentPeriodEnd) + 30d` → new end is day 45, not day 30.
That's correct from a "no time lost" perspective.

But: there's only ONE Subscription row per user (`@@unique`). The user
paid 2 × 49 = 98 XTR; they have one row with end-date day 45. Audit
trail is in `PaymentEvent` (two rows, one per purchase). UI shows one
expiry date. This is fine — but it's the **first time** our model has
"buy the same SKU twice and have it stack". Yearly already has this
behaviour (see `apps/bot/src/payments.ts:200–208`), so the pattern is
not novel; it just gets exercised more often with a 30-day cycle.

**Risk if we get it wrong.** Buyer buys Pass + Pass mid-period and the
second purchase overwrites instead of stacking → user loses paid time
→ refund + churn + bad bot review. **Mandatory integration test** in
the eventual PR: "Pass purchase against existing Pass extends, does not
overwrite" — same shape as the Yearly stacking test that already
exists.

**Measurement.** `event_pass.purchased_count_per_user_60d` distribution.
If P90 ≥ 3 Passes / 60 days, users would be better off on Monthly —
that's a strong signal to upsell after the second Pass.

### 6.5 Lifetime guard / billingPeriod string-typing

**The mechanic.** `Subscription.billingPeriod` is a `String?`, not a
Prisma enum. Adding `'event_pass'` as a literal is convention-only;
nothing prevents a typo elsewhere in the codebase from writing
`'eventpass'` or `'event-pass'`. The `LIFETIME_BILLING_PERIOD` constant
in `@wishlist/shared` solves this for lifetime — we should add an
`EVENT_PASS_BILLING_PERIOD = 'event_pass'` constant in the same place
and use it everywhere (bot processor, scheduler emit, downgrade
predicate). Combined with the upstream-flawed Lifetime guard
(§ 5.3 "honest read"): Pass inherits the same post-hoc-audit-no-refund
behaviour. Mandatory § 7.1 pre-launch verification covers the
real-money question.

**Measurement.** Pre-prod test: try writing the constant to the DB,
read back, assert resolver flips `isPro=true` and `billingPeriod`
round-trips byte-equal.

### 6.6 Pass-expiry feels like a downgrade event

**The mechanic.** Day 30, Pass expires, user opens app, sees their
showcase is gone (was never in Pass anyway — § 3), birthday-advanced
field is back to FREE default, hint limit shrinks. Even though we
warned at purchase, the lived experience is "I lost stuff".

**Mitigation in spec.**
- Pre-expiry day-of in-app banner (NOT bot DM — see § 3): "Pass
  истекает сегодня. Купить Monthly за 100 ⭐?" with explicit Monthly
  CTA. This is the **one** reminder we allow because it's an UPGRADE
  prompt, not a renewal prompt.
- Downgrade preservation: birthday-advanced fields stay in DB on
  expiry (already true today for Monthly→FREE — see
  `docs/MONETIZATION.md` § 16a). Re-buying Pass restores them.

**Measurement.** `event_pass.expired → next_purchase_within_7d` — if
> 40 %, users were actually on a continuity need and should have been
upsold to Monthly mid-Pass. If < 5 %, the one-shot framing is correct.

---

## 7. Decision rule — go / no-go and launch criteria

### 7.1 Pre-launch (go criteria — must ALL be true to ship)

- [ ] **Spec reviewed** by product + me (this document). No open
  questions in § 5 implementation checklist.
- [ ] **Backlog corrected** — `06-experiment-backlog.md` E21 line 470
  mentions a new `event-pass-expiry` scheduler; this spec § 5.2
  shows the existing one covers it. Update the backlog before
  starting work.
- [ ] **Implementation PR scope** capped at: (1) one new env var,
  (2) one constant in `@wishlist/shared`, (3) one new bot processor
  + one branch in `pre_checkout_query`, (4) one tile in paywall +
  copy, (5) one branch in checkout route schema, (6) one filter in
  pro-renewal scheduler, (7) tests covering the
  Monthly-block/Yearly-stack/Lifetime-guard matrix from § 5.4.
  **No additional refactors.** (Per `feedback_design_system_skill`
  and `index.ts` rules in CLAUDE.md.)
- [ ] **Analytics events shipped first** (before paywall UI changes),
  so we can measure the control-bucket baseline at launch t=0.
- [ ] **Bucket plumbing** verified: `getExperimentAssignment(userId,
  'e21_event_pass')` lazy-creates an `ExperimentAssignment` row
  (`schema.prisma:1460–1471`), persisted variant
  (`'treatment' | 'control'`) is returned by `/tg/me` and read by
  the paywall. Tested under godMode override (godMode users see the
  tile regardless of arm).
- [ ] **Rollback switch** — env var
  `EVENT_PASS_DISABLED=true` short-circuits the checkout branch and
  hides the tile. Required by `docs/API_SECURITY.md` § 9 pattern
  for new monetisation paths.
- [ ] **Lifetime-user charge verification** (CRITICAL — was § 8
  question 4, promoted here because it gates real-money UX). In the
  test bot environment: have a Lifetime test user attempt a Pass
  purchase, complete the Telegram Stars flow, and confirm one of:
  (a) Telegram does NOT debit Stars (best case — `pre_checkout_query`
  rejects upstream), or
  (b) Telegram DOES debit and our `payment_success_post_lifetime`
  audit fires correctly AND we have a documented manual-refund
  runbook the admin can execute within 24 h.
  If (b) and no runbook → block launch. Same verification is owed
  to the existing Monthly/Yearly Lifetime-guard branches but has
  never been formally checked; this is the right moment to close
  that gap for all three SKUs.
- [ ] **Refund handling decision** (§ 5.10 spec gap). Choose between
  "track per-PaymentEvent extension delta for stacking-aware refunds"
  vs "shorten to now() regardless of stacking history + manual
  reconciliation in support". Document the choice in the
  implementation PR description.

### 7.2 Launch + 30 days — kill criteria (any ONE triggers immediate rollback)

| Metric | Threshold | Source |
|--------|-----------|--------|
| Monthly purchases in test bucket | < **65 %** of control bucket purchases | `PaymentEvent` count grouped by `Subscription.billingPeriod='monthly'`, joined to `ExperimentAssignment` on `(userId, experimentKey='e21_event_pass', variant)` |
| Net XTR revenue / paying user (full available history per user, capped at the +30d eval point) in test | < **90 %** of control | `PaymentEvent.totalAmount` sum / distinct paying users. Note: at the +30d eval the 60-day window from § 7.3 is not yet observable — re-evaluate the same metric over the full 60d at the § 7.3 checkpoint. |
| User confusion proxy: in-app feedback containing "пасс" / "pass" / "почему" near `cancel` / `подписк` | > **+30 %** baseline AND absolute count ≥ **10 mentions / week** | `Comment` + bot feedback survey. Minimum-N floor avoids noise: if pre-launch baseline is 3 mentions/week, +30 % = 4 mentions is statistical noise, not a signal. |
| Support escalations (Telegram bot DMs to admin) about Pass | > **5 / week** | Manual log review |
| Refund requests via Telegram Stars refund channel | > **2 % of Pass purchases** | TG admin panel |

### 7.3 Launch + 60 days — promote criteria (must have ≥ 3 of 5 to keep)

| Metric | Threshold | Why this number |
|--------|-----------|-----------------|
| Paying-users count (test vs control) | **+ ≥ 50 %** | E21 hypothesis; below this, the volume play didn't materialise |
| Net XTR revenue / paying user (60d) | **≥ 100 %** of control (i.e. neutral or up) | Cannibalisation guard |
| Pass repurchase rate within 60 days | **5 – 25 %** | < 5 % = true one-shot, fine; > 25 % = users on continuity need, should upsell Monthly (§ 6.4) |
| Group Gift add-on purchases | **≥ 50 %** of pre-launch baseline | If perma SKU dies, we need E24 (price reduction) or deprecation plan |
| Time-to-second-paywall-hit for Pass buyers | distribution stable, P50 unchanged | Catches "users buy Pass, do nothing, churn" |

If 3+ of these are green AND no § 7.2 kill criterion fires: **PROMOTE**.
Roll Pass tile to 100 % of FREE users in the 4 § 1 contexts.

If 0-2 are green AND no kill: **EXTEND TEST** by 30 days, keep 50/50.
Re-evaluate at +90 days. If still 0-2 green: **RETIRE** — Pass is not
the right offer. Pivot to E22 (Birthday Pass — narrower, focused) or
E19 (7-day PRO free trial — different commitment model).

### 7.4 Launch + 90 days — pricing review (mandatory)

Re-run elasticity check. Metric is **Pass purchases per 1 000
`event_pass.paywall_shown` events within the TEST bucket only**
(control bucket never sees the tile and its denominator would be 0).
Numerator: distinct `PaymentEvent.eventType='payment_success_event_pass'`
rows over the same window. Bands:

- **> 80**: price is too low — test 59 XTR for 30 days.
- **40 – 80**: price is right — promote at 49 XTR.
- **< 40**: price is not the issue, the offer is. Consider Variant C
  multi-SKU split (separate Santa Pass at 89 XTR, Birthday Pass at
  39 XTR — different bundles per audience).

---

## 8. Open questions and post-E21 follow-ups

### 8.1 Resolved in-spec

**Q. Should the Pass count toward "PRO users" in our public metrics?**
Yes. A Pass user paid for PRO entitlements; treat them as a paying
user. Disaggregation is already free via
`Subscription.billingPeriod` — public-metric dashboards group by that
column to separate Monthly / Yearly / Lifetime / Event Pass, and
"total paying users" is the sum of distinct `userId` with any
`status='ACTIVE'` sub in window. No new schema, no new field.
Document this in the new MONETIZATION.md § 16b (§ 5.11).

**Q. Group Gift legacy add-on owners — should they see the Pass tile
on the group-gift paywall?** No. The tile is hidden when
`ent.hasGroupGift === true` (the user already owns the add-on, so
"unlock group gift" framing is wrong for them). Add the gate at the
Mini App paywall sheet, NOT server-side — the server still allows
Pass purchase, it's just that no group-gift entry context offers it
to an already-unlocked user. Other 3 contexts (birthday, Santa, NY)
still surface for these users.

### 8.2 Still open at spec sign-off

1. **Per-locale RU/EN copy review** — `plan_event_pass_*` and
   `api_invoice_*_event_pass` strings need product-marketing tone
   review in RU before the translator workflow opens. Captured in
   § 5.6.
2. **Refund-flow stacking decision** — see § 5.10 spec gap and § 7.1
   refund-handling decision item. Pick before implementation PR.

### 8.3 E21-success follow-ups (out of scope for E21, but inform
implementation choices)

- **Per-context pricing.** Variant C in the monetisation audit
  proposes 89 XTR Santa Pass, 39 XTR Birthday Pass, 69 XTR NY Pass,
  39 XTR Anniversary Pass. If E21 reads green at +60d, the natural
  follow-up is to test per-context price differentiation. The
  current `plan` enum (`monthly | yearly | lifetime | event_pass`)
  would extend to `event_pass_birthday | event_pass_santa | ...`
  with shared payment-processor logic. Design the bot processor
  ergonomically so a 5th variant is a price-table lookup, not a
  copy-paste of `applyProEventPassPayment`.
- **Second-Pass-upsell.** When a user buys their second Pass within
  60 days (§ 6.2), the Mini App should surface a "Buy Monthly
  instead?" upsell on the next paywall. Not in E21 scope; sized as
  one follow-up sprint.
- **Permanent Group Gift add-on (79 XTR) repricing or deprecation.**
  E24 (already in the backlog) is the lever. If E21 cannibalises
  the add-on below 25 % of baseline (§ 6.2 measurement), E24
  becomes priority.

---

## 9. References

- `docs/research/06-experiment-backlog.md` § E21 (the primary
  hypothesis), § E22 (adjacent Birthday Pass), § E24 (adjacent Group
  Gift price reduction).
- `docs/research/03-monetization-paywall-audit.md` § 11 (event-pass
  candidates and risks), § 12 Variant C (multi-pass future state).
- `docs/MONETIZATION.md` § 2 (current PRO benefits), § 5 (billing
  flow), § 14 (Group Gift current monetisation), § 16a (Birthday
  Reminders monetisation).
- `apps/api/src/services/entitlement.ts` (PRO plan limits, price
  constants, `getUserEntitlement` resolver).
- `apps/api/src/routes/billing.routes.ts` (checkout endpoint, plan
  enum, duplicate-purchase blocks).
- `apps/api/src/schedulers/billing.ts:76–109` (subscription-expiry
  sweep — covers Pass automatically).
- `apps/api/src/schedulers/pro-renewal.ts:54–75` (renewal reminders —
  needs `NOT { billingPeriod: 'event_pass' }` filter).
- `apps/bot/src/payments.ts` (the three existing PRO payment
  processors; Event Pass processor mirrors `applyProYearlyPayment`).
- `packages/db/prisma/schema.prisma:420–442` (`Subscription` model).
