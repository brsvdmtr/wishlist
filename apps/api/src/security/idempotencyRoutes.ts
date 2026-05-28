// Single source of truth for the IdempotencyOptions of the four
// state-changing routes whose duplication would harm users in concrete
// ways: a duplicate wishlist, a duplicate item, a double-billed Stars
// invoice (PRO subscription), a double-billed add-on purchase.
//
// Both `apps/api/src/index.ts` (production wiring) and
// `apps/api/test/integration/idempotency-critical-routes.test.ts`
// (integration tests) import from this file. A drift between wiring and
// test is therefore a TYPE error or a deleted-symbol error, not a silent
// "test keeps passing while prod is broken" regression. Any change to
// one of these four routes' idempotency contract — endpointKey, TTL,
// critical flag — has to happen here, which forces the test PR to
// re-acknowledge the contract change.
//
// Why these four (and not all 165 protectTgRoute calls)?
// - wishlist/item create: duplicate creation is the most-reported
//   class of double-tap UX bug across mobile clients.
// - billing PRO/add-on checkout: real money. Idempotency on the Stars
//   API is a hard-require; a duplicated invoice is a refund ticket.
// Other state-changing routes share the same middleware machinery and
// inherit its guarantees via the existing factories in `index.ts`; the
// integration test pins these four as representatives + canaries.

import type { IdempotencyOptions } from './idempotency';
import { IDEMPOTENCY_BILLING_TTL_MINUTES } from './types';

export const CRITICAL_IDEMPOTENCY_ROUTES = {
  wishlistCreate: {
    endpointKey: 'POST /tg/wishlists',
    category: 'wishlist.create',
  },
  itemCreate: {
    endpointKey: 'POST /tg/wishlists/:id/items',
    category: 'item.create',
  },
  billingProCheckout: {
    endpointKey: 'POST /tg/billing/pro/checkout',
    category: 'payment',
    ttlMinutes: IDEMPOTENCY_BILLING_TTL_MINUTES,
    critical: true,
  },
  billingAddonCheckout: {
    endpointKey: 'POST /tg/billing/addon/checkout',
    category: 'payment',
    ttlMinutes: IDEMPOTENCY_BILLING_TTL_MINUTES,
    critical: true,
  },
} as const satisfies Record<string, IdempotencyOptions>;
