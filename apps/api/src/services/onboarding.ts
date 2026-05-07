// Onboarding domain (P5s-3 — extracted from apps/api/src/index.ts).
//
// 13 identifiers + 6 types/records + 2 demo-item dictionaries that drive
// the `hello_activation` onboarding flow. Bodies byte-identical to their
// previous in-place definitions in index.ts.
//
// Strategy hybrid:
//   - 12 identifiers (consts, types, pure functions, async Prisma readers)
//     — Strategy B / direct import. Routes import from here.
//   - 1 identifier (`completeOnboarding`) — Strategy A. Closes over
//     `trackEvent` (analytics out of P5s scope), so exposed as a factory
//     `createCompleteOnboarding({ trackEvent })`. Index.ts wires it once
//     and passes the resulting function through `registerOnboardingRouter`
//     and `registerItemsRouter` deps unchanged.
//
// Consumers:
//   - apps/api/src/routes/onboarding.routes.ts — uses 12/13 + completeOnboarding.
//   - apps/api/src/routes/items.routes.ts — uses getDemoTemplate, isMeaningfulEdit,
//     completeOnboarding, ONBOARDING_KEY, ONBOARDING_VERSION, FORCED_ROLLOUT_USERS
//     (demo-item lifecycle on POST /items, PATCH /items/:id, DELETE /items/:id,
//     POST /items/:id/copy).
//
// Note: web has its own independent `resolveMarketSegment` in
// `@wishlist/shared` — these are duplicated by design (api derivation
// from request locale; web derivation from client locale).

import { prisma } from '@wishlist/db';
import {
  getOnboardingMeta,
  type Locale,
  type OnboardingVariant,
} from '@wishlist/shared';

// ── Types ──────────────────────────────────────────────────────────────────

export type VariantKey = 'wildberries' | 'goldapple' | 'ozon' | 'yandex_market' | 'amazon' | 'zalando' | 'sephora' | 'apple';
export type MarketSegment = 'ru' | 'global';
export type CompletionReason =
  | 'demo_converted'
  | 'real_item_created'
  | 'demo_deleted_then_real_created'
  | 'demo_moved_to_user_wishlist'
  | 'try_import_completed'
  | 'catalog_selected'
  | 'manual_created';

export interface DemoItemTemplate {
  title: string;
  url: string;
  price: number;
  currency: 'RUB' | 'USD';
  priority: 'MEDIUM';
  imageUrl: string;
  description: string;
}

export type RuVariantKey = 'wildberries' | 'goldapple' | 'ozon' | 'yandex_market';

export type EligibilityResult = {
  eligible: boolean;
  reason: string;
  forcedRollout: boolean;
  draftsHaveUserContent: boolean;
};

// ── Constants ──────────────────────────────────────────────────────────────

export const ONBOARDING_KEY = 'hello_activation';
export const ONBOARDING_VERSION = 1;
export const RU_VARIANTS: VariantKey[]     = ['wildberries', 'goldapple', 'ozon', 'yandex_market'];
export const GLOBAL_VARIANTS: VariantKey[] = ['amazon', 'zalando', 'sephora', 'apple'];

// Centralised forced-rollout gate. actorHashes in this set bypass real-item eligibility check.
// entryPoint is always overridden to 'forced_rollout_test' for these users.
export const FORCED_ROLLOUT_USERS = new Set<string>(
  (process.env.ONBOARDING_FORCED_USERS ?? '').split(',').filter(Boolean)
);

// Demo item templates — verbatim agreed content. Do not abbreviate URLs or descriptions.
export const DEMO_ITEMS: Record<RuVariantKey, DemoItemTemplate> = {
  wildberries: {
    title: 'Подарочный сертификат Wildberries',
    url: 'https://www.wildberries.ru/gift/certificates',
    price: 5000,
    currency: 'RUB',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/wb-cert.jpg',
    description:
      'Это хороший подарок на любой повод: день рождения, да и просто так. Сертификат можно потратить на любые покупки на Wildberries, кроме нового сертификата. И каждый найдёт то, что ему по душе.',
  },
  goldapple: {
    title: 'Подарочный сертификат Золотое Яблоко',
    url: 'https://goldapple.ru/cards?srsltid=AfmBOoptUMZa5NGi5PprPHvbcFkRKveW0MDLqc62SrbWenwhpxr1y2H3',
    price: 5000,
    currency: 'RUB',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/goldapple-cert.jpg',
    description:
      'Это хороший подарок на любой повод: день рождения, да и просто так. Сертификат можно потратить на любые покупки в Золотом Яблоке, кроме нового сертификата. И каждый найдёт то, что ему по душе.',
  },
  ozon: {
    title: 'Подарочный сертификат Ozon',
    url: 'https://www.ozon.ru/landing/giftcertificates/?__rr=1',
    price: 5000,
    currency: 'RUB',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/ozon-cert.jpg',
    description:
      'Это хороший подарок на любой повод: день рождения, да и просто так. Сертификат можно потратить на любые покупки на Ozon, кроме нового сертификата. И каждый найдёт то, что ему по душе.',
  },
  yandex_market: {
    title: 'Подарочный сертификат Яндекс Маркет',
    url: 'https://market.yandex.ru/card/podarochnyy-sertifikat-yandeks-market-elektronnyy/103670724746?do-waremd5=n5Az0T5R47tdLDQ0qAMd5Q&ogV=-12',
    price: 5000,
    currency: 'RUB',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/ym-cert.jpg',
    description:
      'Это хороший подарок на любой повод: день рождения, да и просто так. Сертификат можно потратить на любые покупки на Яндекс Маркете, кроме нового сертификата. И каждый найдёт то, что ему по душе.',
  },
};

export const GLOBAL_DEMO_ITEMS: Record<string, DemoItemTemplate> = {
  amazon: {
    title: 'Amazon Gift Card',
    url: 'https://www.amazon.com/dp/B004LLIKVU',
    price: 50,
    currency: 'USD',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/global/amazon-gift-card.jpg',
    description:
      'A great gift for any occasion. The recipient can choose exactly what they want from millions of products on Amazon.',
  },
  zalando: {
    title: 'Zalando Gift Voucher',
    url: 'https://www.zalando.co.uk/giftvouchers/',
    price: 50,
    currency: 'USD',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/global/zalando-gift-card.jpg',
    description:
      'A stylish and flexible gift. Perfect for fashion, shoes, accessories and more on Zalando.',
  },
  sephora: {
    title: 'Sephora Gift Card',
    url: 'https://www.sephora.com/gift-cards',
    price: 50,
    currency: 'USD',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/global/sephora-gift-card.jpg',
    description:
      'A beauty gift that works for almost any occasion. Great for skincare, makeup, fragrance and self-care essentials.',
  },
  apple: {
    title: 'Apple Gift Card',
    url: 'https://www.apple.com/shop/buy-giftcard/giftcard',
    price: 50,
    currency: 'USD',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/global/apple-gift-card.jpg',
    description:
      'A premium digital gift for apps, devices, accessories, entertainment and more across the Apple ecosystem.',
  },
};

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Derive market segment from resolved locale. */
export function resolveMarketSegment(locale: Locale): MarketSegment {
  return locale === 'ru' ? 'ru' : 'global';
}

/** Derive segment from a stored variantKey (for call-sites that only have the key). */
export function variantKeyToSegment(variantKey: string): MarketSegment {
  return (GLOBAL_VARIANTS as string[]).includes(variantKey) ? 'global' : 'ru';
}

// Onboarding v2 is now the default for ALL new users.
// A/B experiment concluded — v2_try won and became the main flow.
// Historical variants (v1_demo) are still supported for users already assigned to them.
export function assignOnboardingVariant(_telegramId?: string): { variant: OnboardingVariant; source: 'rollout_config' } {
  return { variant: 'v2_try', source: 'rollout_config' };
}

/** Look up demo template from either pool by variantKey. */
export function getDemoTemplate(variantKey: string): DemoItemTemplate | undefined {
  return (DEMO_ITEMS as Record<string, DemoItemTemplate>)[variantKey] ?? GLOBAL_DEMO_ITEMS[variantKey];
}

/** True if a demo item has not been meaningfully edited (safe to delete on dismiss). */
export function isDemoItemUntouched(
  item: { title: string | null; url: string | null; priceText: string | null; becameRealAt: Date | null },
  template: DemoItemTemplate,
): boolean {
  if (item.becameRealAt !== null) return false;
  if (item.title !== template.title) return false;
  if (item.url !== template.url) return false;
  const itemPrice = item.priceText ? Number(item.priceText) : null;
  if (itemPrice !== template.price) return false;
  return true;
}

/** True if any meaningful field differs from the original demo template. */
export function isMeaningfulEdit(
  update: { title?: string; url?: string | null; price?: number | null; description?: string | null },
  template: DemoItemTemplate,
): boolean {
  if (update.title !== undefined && update.title !== template.title) return true;
  if (update.url !== undefined && update.url !== template.url) return true;
  if (update.price !== undefined && update.price !== template.price) return true;
  if (update.description !== undefined && update.description !== template.description) return true;
  return false;
}

// ── Async readers (Prisma) ─────────────────────────────────────────────────

/** Count real items for the given user across all wishlists. */
export async function countRealItemsForActivation(userId: string): Promise<number> {
  return prisma.item.count({
    where: {
      wishlist: { ownerId: userId },
      isDemo: false,
      originType: { not: 'DEMO' },
      status: { notIn: ['DELETED', 'PURCHASED', 'COMPLETED'] },
    },
  });
}

/** True if SYSTEM_DRAFTS contains any real (non-demo) items for this user. */
export async function hasDraftsUserContent(userId: string): Promise<boolean> {
  const count = await prisma.item.count({
    where: {
      wishlist: { ownerId: userId, type: 'SYSTEM_DRAFTS' },
      isDemo: false,
      originType: { not: 'DEMO' },
      status: { notIn: ['DELETED', 'PURCHASED', 'COMPLETED'] },
    },
  });
  return count > 0;
}

export async function checkOnboardingEligibility(
  userId: string,
  actorHash: string,
): Promise<EligibilityResult> {
  const draftsHaveUserContent = await hasDraftsUserContent(userId);

  // Centralised forced-rollout check — always wins, bypasses real-item count.
  if (FORCED_ROLLOUT_USERS.has(actorHash)) {
    return { eligible: true, reason: 'forced_rollout_test', forcedRollout: true, draftsHaveUserContent };
  }

  const state = await prisma.userOnboardingState.findUnique({
    where: { userId_onboardingKey_version: { userId, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
  });
  if (state?.status === 'COMPLETED') return { eligible: false, reason: 'already_completed', forcedRollout: false, draftsHaveUserContent };
  if (state?.status === 'DISMISSED') return { eligible: false, reason: 'already_dismissed', forcedRollout: false, draftsHaveUserContent };

  const realItemCount = await countRealItemsForActivation(userId);
  if (realItemCount > 0) return { eligible: false, reason: 'has_real_items', forcedRollout: false, draftsHaveUserContent };

  return { eligible: true, reason: 'no_onboarding_state', forcedRollout: false, draftsHaveUserContent };
}

// ── Factory: completeOnboarding (closes over trackEvent) ───────────────────

export type TrackEventFn = (event: string, userId?: string, props?: Record<string, unknown>) => void;
export type CompleteOnboardingFn = (userId: string, reason: CompletionReason) => Promise<void>;

/** Complete the onboarding for a user. Idempotent — no-op if already COMPLETED/DISMISSED.
 *  Always fires 'onboarding_completed' analytics event on the first (real) completion. */
export function createCompleteOnboarding(deps: { trackEvent: TrackEventFn }): CompleteOnboardingFn {
  const { trackEvent } = deps;
  return async function completeOnboarding(userId: string, reason: CompletionReason): Promise<void> {
    const state = await prisma.userOnboardingState.findUnique({
      where: { userId_onboardingKey_version: { userId, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
    });
    if (!state || state.status === 'COMPLETED' || state.status === 'DISMISSED') return;

    const meta = getOnboardingMeta(state.metaJson);
    const now = new Date();
    await prisma.userOnboardingState.update({
      where: { id: state.id },
      data: { status: 'COMPLETED', completedAt: now, completionReason: reason },
    });

    // Set becameRealAt only when the demo item itself was meaningfully converted.
    if (reason === 'demo_converted' && state.demoItemId) {
      await prisma.item.updateMany({
        where: { id: state.demoItemId, isDemo: true },
        data: { becameRealAt: now },
      });
    }

    // Analytics — fires exactly once per completion (guard above prevents re-entry).
    const isLegacyV1 = (meta.onboardingVariant ?? 'v1_demo') === 'v1_demo';
    trackEvent('onboarding_completed', userId, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      variant_key: state.variantKey ?? null,
      entry_point: state.entryPoint ?? null,
      completion_reason: reason,
      forced_rollout: FORCED_ROLLOUT_USERS.has(userId),
      market_segment: state.variantKey ? variantKeyToSegment(state.variantKey) : 'ru',
      onboarding_variant: meta.onboardingVariant ?? 'v1_demo',
      acquisition_path: meta.acquisitionPath ?? null,
      experiment_phase: isLegacyV1 ? 'legacy_recovery' : 'post_rollout',
      onboarding_flow: isLegacyV1 ? 'v1_demo_recovery' : 'main_v2',
    });
  };
}
