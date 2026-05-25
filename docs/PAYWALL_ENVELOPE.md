# Paywall Error Envelope — Unified Contract

**Status:** canonical · **Introduced:** 2026-05-25 · **Owner:** backend + Mini App

## What changed

Before 2026-05-25, paywall-adjacent endpoints emitted **six distinct JSON
shapes** for 402/403/409 responses (see audit in the conversation that
introduced this doc). Every new monetization surface added another parsing
branch on the Mini App side. This document pins the single contract every
new state-changing route must use.

The helper lives at [`apps/api/src/services/paywall.ts`](../apps/api/src/services/paywall.ts);
the Mini App parser lives at [`apps/web/app/miniapp/lib/paywall.ts`](../apps/web/app/miniapp/lib/paywall.ts).

## Envelope

```ts
type PaywallErrorBody = {
  error: 'pro_required' | 'addon_required' | 'plan_limit_reached';
  feature: string;          // gated feature key (matches Mini App UpsellContext)
  context?: string;         // sub-feature (e.g., 'audience' for birthday-advanced)
  planCode?: string;        // 'FREE' | 'PRO' (typed wide on the wire)
  limit?: number;           // numeric ceiling (plan_limit_reached, optional elsewhere)
  current?: number;         // current usage
  priceXtr?: number;        // add-on price in Telegram Stars
  skuCode?: string;         // recommended SKU to purchase
  // Legacy / quota-specific fields (preserved by opt-in for cached clients):
  freeLimit?: number;       // FREE-tier quota limit (hints / url_import)
  freeUsed?: number;
  paidCredits?: number;
  packs?: readonly string[];
  paywall?: string;         // legacy tag (e.g., 'categories')
  message?: string;         // optional human-readable message
};
```

## HTTP status codes

| Status | Meaning | Frontend behavior |
|--------|---------|-------------------|
| **402** | User can buy / upgrade (`pro_required`, `addon_required`, `plan_limit_reached`) | Auto-show `ProUpsellSheet` via `paywallContextFromError(...)`. |
| **403** | Access denied; purchase wouldn't help (hard denial — wrong user, archived wishlist, banned). | Show a toast. **No** upsell. |
| **409** | State conflict, e.g., guest hit owner's plan ceiling. | Show a toast (often "ask owner to upgrade"). No upsell on requester side. |

Rule of thumb: **if the user clicking *Buy* would unblock the action, use 402.**
Otherwise use 403 (denial) or 409 (conflict).

## Error codes

| Code | When | Example |
|------|------|---------|
| `pro_required` | Feature is in the PRO plan; FREE users cannot enable it. | `feature: 'showcase'`, `feature: 'birthday_reminders_advanced'`, `feature: 'categories'` |
| `addon_required` | Feature is purchasable as a one-time add-on. | `feature: 'group_gift'` + `skuCode: 'group_gift_unlock'`, `feature: 'hints'` + `skuCode: 'hints_pack_5'` |
| `plan_limit_reached` | Numeric ceiling hit; FREE→PRO upgrade or slot add-on resolves it. | `feature: 'wishlist_limit'` + `limit: 2`, `current: 2`, `skuCode: 'extra_wishlist_slot'` |

## Builders

```ts
import {
  makeProRequired,
  makeAddonRequired,
  makePlanLimitReached,
  sendPaywall,
} from '../services/paywall';

// PRO subscription unlocks the feature.
return sendPaywall(res, 402, makeProRequired('showcase', {
  planCode: ent.plan.code,
}));

// One-time add-on; priceXtr auto-resolves from the SKU default table
// (override by passing priceXtr explicitly when an env-var is in play).
return sendPaywall(res, 402, makeAddonRequired('group_gift', {
  skuCode: 'group_gift_unlock',
  priceXtr: GROUP_GIFT_PRICE_XTR,
}));

// Numeric plan limit; emit current + limit so the upsell sheet shows usage.
return sendPaywall(res, 402, makePlanLimitReached('wishlist_limit', {
  limit: ent.effectiveWishlistLimit,
  current: count,
  planCode: ent.plan.code,
  skuCode: 'extra_wishlist_slot', // hint for the add-on cross-sell
}));

// 409 conflict — requester can't buy this away (e.g., guest hits owner limit).
return sendPaywall(res, 409, makePlanLimitReached('participant_limit', {
  limit: result.limit,
  current: result.count,
}));
```

The helpers preserve `freeLimit / freeUsed / paidCredits / packs / paywall /
message` for backward compatibility with cached Mini App clients. New clients
should read the canonical `error / feature / skuCode / priceXtr / limit /
current` fields instead.

## Frontend integration

```ts
import { parsePaywallError, paywallContextFromError } from './lib/paywall';

const body = await res.json().catch(() => null);
const parsed = parsePaywallError(res.status, body);
const ctx = paywallContextFromError(parsed); // → UpsellContext | null

if (ctx) {
  showUpsell(ctx, { auto: true });
} else {
  pushToast(parsed?.message ?? t('toast_plan_limit', locale), 'error');
}
```

`parsePaywallError` accepts both the new envelope and the six legacy variants
(`import_quota_exhausted`, `hint_quota_exhausted`, `group_gift_required`,
`gift_notes_required`, `smart_reservations_required`,
`secret_reservations_required`, plus `Plan limit reached` / `Pro required` /
`Pro feature` string variants).

`paywallContextFromError` returns `null` for status 403 (denial) and 409
(conflict) — callers should fall back to a toast for these. Only 402 triggers
the upsell sheet.

## Migration status (2026-05-25)

| Surface | File | Status |
|---|---|---|
| URL import quota | [`import.routes.ts`](../apps/api/src/routes/import.routes.ts) | ✓ migrated |
| URL import (bot path) | [`internal.routes.ts`](../apps/api/src/routes/internal.routes.ts) | ✓ migrated |
| Hints quota | [`hints.routes.ts`](../apps/api/src/routes/hints.routes.ts) | ✓ migrated |
| Categories | [`wishlists.routes.ts`](../apps/api/src/routes/wishlists.routes.ts) | ✓ migrated |
| Wishlist limit | [`wishlists.routes.ts`](../apps/api/src/routes/wishlists.routes.ts) | ✓ migrated |
| Subscription limit | [`wishlists.routes.ts`](../apps/api/src/routes/wishlists.routes.ts) | ✓ migrated |
| Visibility / subs / comment policy | [`wishlists.routes.ts`](../apps/api/src/routes/wishlists.routes.ts) | ✓ migrated **(403 → 402)** |
| Smart reservations | [`wishlists.routes.ts`](../apps/api/src/routes/wishlists.routes.ts) | ✓ migrated |
| Curated selection | [`wishlists.routes.ts`](../apps/api/src/routes/wishlists.routes.ts) | ✓ migrated |
| Item / placement / readonly | [`items.routes.ts`](../apps/api/src/routes/items.routes.ts), [`wishlists.routes.ts`](../apps/api/src/routes/wishlists.routes.ts) | ✓ migrated |
| Drafts limit | [`import.routes.ts`](../apps/api/src/routes/import.routes.ts), [`internal.routes.ts`](../apps/api/src/routes/internal.routes.ts) | ✓ migrated |
| Showcase | [`me.routes.ts`](../apps/api/src/routes/me.routes.ts) | ✓ migrated **(403 → 402)** |
| Birthday advanced | [`me.routes.ts`](../apps/api/src/routes/me.routes.ts) | ✓ migrated |
| Don't-gift | [`me.routes.ts`](../apps/api/src/routes/me.routes.ts), [`wishlists.routes.ts`](../apps/api/src/routes/wishlists.routes.ts) | ✓ migrated |
| Reservation PRO cluster | [`reservations.routes.ts`](../apps/api/src/routes/reservations.routes.ts) | ✓ migrated |
| Secret reservations | [`reservations.routes.ts`](../apps/api/src/routes/reservations.routes.ts) | ✓ migrated **(403 → 402)** |
| Participant limit (guest-side) | [`reservations.routes.ts`](../apps/api/src/routes/reservations.routes.ts) | ✓ migrated **(402 → 409)** |
| Comments | [`comments.routes.ts`](../apps/api/src/routes/comments.routes.ts) | ✓ migrated |
| Group gifts | [`group-gifts.routes.ts`](../apps/api/src/routes/group-gifts.routes.ts) | ✓ migrated **(403 → 402)** |
| Gift notes | [`services/entitlement.ts`](../apps/api/src/services/entitlement.ts) | ✓ migrated **(403 → 402)** |
| Santa multi-wave / exclusions / exclusion groups | [`santa.routes.ts`](../apps/api/src/routes/santa.routes.ts) | ✓ migrated |
| Billing add-on caps (`cap_reached`) | [`billing.routes.ts`](../apps/api/src/routes/billing.routes.ts) | intentionally **not migrated** — these are state conflicts in the add-on checkout flow, not paywall errors; 409 is already correct. |

## Status-code migrations to note

These endpoints **changed HTTP status** as part of the unification:

| Endpoint | Before | After | Rationale |
|---|---|---|---|
| `PATCH /tg/me/showcase` | 403 | **402** | Showcase is purchasable via PRO. |
| `POST /tg/me/showcase/cover` | 403 | **402** | Same. |
| `DELETE /tg/me/showcase/cover` | 403 | **402** | Same. |
| `PATCH /tg/wishlists/:id` (visibility / subs / comment policy) | 403 | **402** | Wishlist privacy is purchasable via PRO. |
| `POST /tg/group-gifts/*` (when `hasGroupGift` is false) | 403 | **402** | Group gifts unlock via `group_gift_unlock` add-on. |
| Gift Notes gate (any consumer of `requireGiftNotes`) | 403 | **402** | Unlock via `gift_notes_unlock` add-on. |
| `POST /tg/reservations/secret` (when secret reservations off) | 403 | **402** | Unlock via `secret_reservation_unlock` add-on. |
| `POST /tg/items/:id/reserve` (participant limit, guest-side) | 402 | **409** | Guest cannot buy PRO for the owner — it's a state conflict, not a paywall the requester can resolve. |

## Iron rules — new state-changing routes

- **Pick the status by purchase-path**: 402 if buyable, 403 if denied, 409 if conflict the requester can't fix.
- **Always use a builder** — `makeProRequired` / `makeAddonRequired` / `makePlanLimitReached`. Never construct the envelope inline.
- **Pick a feature key that matches a Mini App `UpsellContext`** when an upsell sheet exists for the feature. If a new feature needs a new UpsellContext, add it to both `MiniApp.tsx` and `paywall.ts` (frontend `FEATURE_TO_CONTEXT`).
- **For add-ons, pass `skuCode`** — `priceXtr` auto-resolves from the SKU default table. Pass `priceXtr` explicitly only when the price is env-overridable (`GROUP_GIFT_PRICE_XTR`, `GIFT_NOTES_PRICE_XTR`, `SECRET_RESERVATION_PRICE_XTR`).
- **For numeric limits, always emit `current` + `limit`** so the upsell sheet can render "2 of 2 used".
- **Never reuse plain-English `error` strings** like `'Pro required'` — these are now machine-readable codes (`pro_required` / `addon_required` / `plan_limit_reached`). Use `message: '...'` for human copy.

## Tests

- Unit tests for the helper: [`apps/api/src/services/paywall.test.ts`](../apps/api/src/services/paywall.test.ts) (24 cases).
- Frontend parser tests: [`apps/web/app/miniapp/lib/paywall.test.ts`](../apps/web/app/miniapp/lib/paywall.test.ts) (30 cases).
- Per-endpoint contract tests: [`apps/api/src/services/paywall-envelopes.test.ts`](../apps/api/src/services/paywall-envelopes.test.ts) (21 cases).

When migrating a new endpoint, add (or update) the contract test for that
endpoint in `paywall-envelopes.test.ts` so the wire format is locked at the
helper boundary.

## Related docs

- [docs/API_SECURITY.md](API_SECURITY.md) — idempotency, rate limits.
- [docs/MONETIZATION.md](MONETIZATION.md) — plans, SKUs, prices.
- [docs/API_ARCHITECTURE_RULES.md](API_ARCHITECTURE_RULES.md) — service vs route layering.
