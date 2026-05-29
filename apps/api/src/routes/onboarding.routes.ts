// Telegram-auth router for /tg/onboarding/* endpoints (9 handlers).
// Mounted via `tgRouter.use(onboardingRouter)` in apps/api/src/index.ts
// alongside the other early P5 routers (~line 1790, after giftNotesRouter).
//
// TDZ: all 13 function deps are hoisted (`function` / `async function`
// declarations); the const deps (ONBOARDING_KEY, ONBOARDING_VERSION,
// FORCED_ROLLOUT_USERS, RU_VARIANTS, GLOBAL_VARIANTS) live at index.ts
// lines 1006–1023 — well before the mount point. No relocation needed
// (unlike P5c/P5e/P5f which had to mount post-`app.use('/tg', tgRouter)`
// because of late-defined `const` deps).
//
// Same factory pattern as P5a/P5b/P5c/P5d/P5e/P5f/P5g. Handler bodies are
// byte-identical to their previous in-place definitions in index.ts —
// only `tgRouter.` -> `onboardingRouter.` and indent +2.
//
// onboardingImportLimiter is migrated WITH the router (lines 7282–7287
// of the pre-P5h index.ts). It is referenced exclusively by POST
// /onboarding/try-import below, so this is a clean migration matching
// P5f's promoLimiter and P5b's referral-only helpers.
//
// Cross-domain coupling (helpers that MUST stay in index.ts and arrive
// through deps): demo-item lifecycle is co-owned by items routes —
// `getDemoTemplate`, `completeOnboarding`, `getOnboardingMeta` (from
// @wishlist/shared, imported here directly), `ONBOARDING_KEY`,
// `ONBOARDING_VERSION`, `FORCED_ROLLOUT_USERS`, `variantKeyToSegment`
// are also called from POST /tg/items (~4520), PATCH /tg/items/:id
// (~5004), DELETE /tg/items/:id (~5104), POST /tg/items/:id/copy (~6541)
// to fire `onboarding_completed` analytics and the `demo_*` completion
// reasons when the demo item is touched. Migrating any of them with
// the router would break those four items handlers.
//
// Plan-limit / entitlement gating: NONE inside this router. Onboarding
// bypasses Pro/limits intentionally — the user's first wishlist + items
// are created free of charge. There is no `getEffectiveEntitlements` /
// `getUserEntitlement` / `ent.plan.*` reference anywhere below; do not
// add one in this file.

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '@wishlist/db';
import {
  t,
  type Locale,
  type MarketSegment,
  type OnboardingMeta,
  type OnboardingVariant,
  type CatalogTemplate,
  getOnboardingMeta,
  getCatalogForSegment,
  deriveMarketBucket,
  isSupportedImportRegion,
} from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { validateUrl } from '../url-parser.js';
import { ensureItemPlacement } from '../placements/ensureItemPlacement';
import { relocateItemPrimary } from '../placements/relocateItemPrimary';
import {
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
  RU_VARIANTS,
  GLOBAL_VARIANTS,
  FORCED_ROLLOUT_USERS,
  resolveMarketSegment,
  variantKeyToSegment,
  assignOnboardingVariant,
  getDemoTemplate,
  isDemoItemUntouched,
  checkOnboardingEligibility,
} from '../services/onboarding';

// ── Local type re-declarations ────────────────────────────────────────────
// Kept in sync with apps/api/src/index.ts:989, 991, 997, 1034 (see audit).
// Re-declared locally instead of `export type` from index.ts to keep
// extraction byte-identical and avoid changing index.ts module surface.
// Same precedent as P5b which duplicated 2 referral types.
type VariantKey = 'wildberries' | 'goldapple' | 'ozon' | 'yandex_market' | 'amazon' | 'zalando' | 'sephora' | 'apple';
type EntryPoint =
  | 'first_open'
  | 'auto_after_first_wishlist'
  | 'organic_returning_underactivated'
  | 'forced_rollout_test'
  | 'manual_cta'
  | 'post_reservation_claim'
  | 'guest_view_banner';
type CompletionReason =
  | 'demo_converted'
  | 'real_item_created'
  | 'demo_deleted_then_real_created'
  | 'demo_moved_to_user_wishlist'
  | 'try_import_completed'
  | 'catalog_selected'
  | 'manual_created';
interface DemoItemTemplate {
  title: string;
  url: string;
  price: number;
  currency: 'RUB' | 'USD';
  priority: 'MEDIUM';
  imageUrl: string;
  description: string;
}

// Shape of the Telegram initData user object — duplicated from index.ts to
// avoid coupling routes/* to a non-exported local type. Structurally
// equivalent.
type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal user shape — onboarding handlers only read .id.
type OnboardingUser = { id: string };

// Eligibility-check result shape, mirroring `checkOnboardingEligibility`'s
// return type at apps/api/src/index.ts:1179. Handlers below only read
// `eligible`, `reason`, `forcedRollout`, `draftsHaveUserContent`.
type EligibilityResult = {
  eligible: boolean;
  reason: string | null;
  forcedRollout: boolean;
  draftsHaveUserContent: boolean;
};

// Result shape returned by importUrlForUser (apps/api/src/index.ts:6382).
// Handlers below read `.item.id`, `.item.sourceDomain`, `.parseStatus`,
// `.wishlistId` — wider runtime shape is fine.
type ImportUrlResult = {
  item: { id: string; sourceDomain: string | null } & Record<string, unknown>;
  wishlistId: string;
  parseStatus: 'ok' | 'partial' | 'failed';
};

export type OnboardingRouterDeps = {
  // Universal closure helpers
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<OnboardingUser>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;

  // Onboarding completion — closes over trackEvent in index.ts; passed via
  // deps as a factory-produced function. All other onboarding helpers and
  // consts (resolveMarketSegment, variantKeyToSegment, assignOnboardingVariant,
  // getDemoTemplate, isDemoItemUntouched, checkOnboardingEligibility,
  // ONBOARDING_KEY, ONBOARDING_VERSION, FORCED_ROLLOUT_USERS, RU_VARIANTS,
  // GLOBAL_VARIANTS) are imported directly from ../services/onboarding in
  // P5s-3 (Strategy B).
  completeOnboarding: (userId: string, reason: CompletionReason) => Promise<void>;

  // Cross-domain helpers used by other routes
  runReferralProgressHook: (userId: string, milestone: 'first_wishlist' | 'first_item') => Promise<void>;
  importUrlForUser: (userId: string, url: string, headerHostname: string | undefined, importMethod: string) => Promise<ImportUrlResult>;
  getOrCreateDraftsWishlist: (userId: string) => Promise<{ id: string }>;
  /** E04 — used by POST /onboarding/create-wishlist to find an auto-created default wishlist (isDefault=true) so it can be renamed in place instead of duplicated. */
  getOrCreateDefaultWishlist: (
    userId: string,
    locale: Locale,
  ) => Promise<{ id: string; slug: string; title: string; isDefault: boolean; alreadyExisted: boolean }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapTgItem at index.ts:1286 takes a structurally-typed Item; runtime callers below pass partial selects.
  mapTgItem: (item: any) => any;
};

export function registerOnboardingRouter(deps: OnboardingRouterDeps): Router {
  const {
    getOrCreateTgUser,
    trackEvent,
    completeOnboarding,
    runReferralProgressHook,
    importUrlForUser,
    getOrCreateDraftsWishlist,
    getOrCreateDefaultWishlist,
    mapTgItem,
  } = deps;

  const onboardingRouter = Router();

  // ── onboardingImportLimiter — migrated with router (P5h) ────────────────
  // Was `const onboardingImportLimiter = rateLimit({...})` at
  // apps/api/src/index.ts:7282. Only used by POST /onboarding/try-import
  // below — safe to migrate without breaking other routes. Same migration
  // pattern as P5f's promoLimiter and P5b's referral-only helpers.
  const onboardingImportLimiter = rateLimit({
    windowMs: 60_000,
    limit: 3,
    keyGenerator: (req) => req.tgUser ? String(req.tgUser.id) : 'anon',
    validate: false,
  });

  // ─── Onboarding Endpoints ─────────────────────────────────────────────────────

  // GET /tg/onboarding/status — check eligibility for the current user
  onboardingRouter.get(
    '/onboarding/status',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const actorHash = user.id; // actorHash is the internal user id used for forced rollout matching
      const result = await checkOnboardingEligibility(user.id, actorHash);
      const state = await prisma.userOnboardingState.findUnique({
        where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
        select: { id: true, status: true, variantKey: true, entryPoint: true, demoItemId: true, completionReason: true, metaJson: true, startedAt: true, completedAt: true, dismissedAt: true },
      });
      const locale = getRequestLocale(req);
      const marketSegment = resolveMarketSegment(locale);
      const rawLang = req.tgUser?.language_code;
      const bucket = deriveMarketBucket(rawLang);
      return res.json({
        eligible: result.eligible,
        reason: result.reason,
        forcedRollout: result.forcedRollout,
        draftsHaveUserContent: result.draftsHaveUserContent,
        state: state ?? null,
        marketSegment,
        supportedImportRegion: isSupportedImportRegion(bucket),
      });
    }),
  );

  // POST /tg/onboarding/start — begin onboarding: assign variant, create demo item in SYSTEM_DRAFTS
  onboardingRouter.post(
    '/onboarding/start',
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({ onboardingKey: z.string(), entryPoint: z.string() })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);
      if (parsed.data.onboardingKey !== ONBOARDING_KEY) return res.status(400).json({ error: 'Unknown onboarding key' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const actorHash = user.id;
      const elig = await checkOnboardingEligibility(user.id, actorHash);
      if (!elig.eligible) return res.status(409).json({ error: 'Not eligible', reason: elig.reason });

      // Idempotent: if already IN_PROGRESS, resume
      const existing = await prisma.userOnboardingState.findUnique({
        where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
      });
      if (existing?.status === 'IN_PROGRESS') {
        const meta = getOnboardingMeta(existing.metaJson);
        if (meta.onboardingVariant === 'v2_try') {
          // v2 resume: no demo item expected
          return res.json({ state: existing, demoItem: null, onboardingVariant: 'v2_try' as OnboardingVariant });
        }
        if (existing.demoItemId) {
          // v1 resume: return existing demo item
          const demoItem = await prisma.item.findUnique({
            where: { id: existing.demoItemId },
            select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
          });
          return res.json({ state: existing, demoItem: demoItem ? mapTgItem(demoItem) : null, onboardingVariant: 'v1_demo' as OnboardingVariant });
        }
      }

      // ── A/B variant assignment ──
      // Priority: 1) already-saved variant  2) test override by telegramId  3) rollout config
      const telegramId = String(req.tgUser!.id);
      const existingVariant = existing ? getOnboardingMeta(existing.metaJson).onboardingVariant : undefined;
      const assignment = existingVariant
        ? { variant: existingVariant, source: 'rollout_config' as const }
        : assignOnboardingVariant(telegramId);
      const onboardingVariant = assignment.variant;
      const assignmentSource = assignment.source;

      // Override entryPoint for forced rollout
      const effectiveEntryPoint: EntryPoint = elig.forcedRollout
        ? 'forced_rollout_test'
        : (parsed.data.entryPoint as EntryPoint);

      const locale = getRequestLocale(req);
      const marketSegment = resolveMarketSegment(locale);
      const now = new Date();

      if (onboardingVariant === 'v2_try') {
        // ── v2: initialize state only, NO demo item ──
        const meta: OnboardingMeta = {
          onboardingVariant: 'v2_try',
          lastStep: 'onboarding-entry',
          tryAttemptsUsed: 0,
          trySuccessCount: 0,
        };

        const state = await prisma.userOnboardingState.upsert({
          where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
          create: {
            userId: user.id,
            onboardingKey: ONBOARDING_KEY,
            version: ONBOARDING_VERSION,
            status: 'IN_PROGRESS',
            entryPoint: effectiveEntryPoint,
            startedAt: now,
            metaJson: meta as any,
          },
          update: {
            status: 'IN_PROGRESS',
            entryPoint: effectiveEntryPoint,
            startedAt: now,
            metaJson: meta as any,
          },
        });

        trackEvent('onboarding_variant_assigned', user.id, {
          onboarding_key: ONBOARDING_KEY,
          version: ONBOARDING_VERSION,
          onboarding_variant: 'v2_try',
          onboarding_flow: 'main_v2',
          experiment_phase: 'post_rollout',
          assignment_source: assignmentSource,
          entry_point: effectiveEntryPoint,
          forced_rollout: elig.forcedRollout,
          market_segment: marketSegment,
          locale_used: locale,
        });

        trackEvent('onboarding_started', user.id, {
          onboarding_key: ONBOARDING_KEY,
          version: ONBOARDING_VERSION,
          variant_key: null,
          entry_point: effectiveEntryPoint,
          forced_rollout: elig.forcedRollout,
          market_segment: marketSegment,
          locale_used: locale,
          onboarding_variant: 'v2_try',
          onboarding_flow: 'main_v2',
          experiment_phase: 'post_rollout',
        });

        return res.json({ state, demoItem: null, onboardingVariant: 'v2_try' as OnboardingVariant });
      }

      // ── v1: original demo-based flow ──
      const variantPool = marketSegment === 'ru' ? RU_VARIANTS : GLOBAL_VARIANTS;
      const variantKey: VariantKey = variantPool[Math.floor(Math.random() * variantPool.length)]!;
      const template = getDemoTemplate(variantKey)!;

      // Get or create SYSTEM_DRAFTS wishlist for this user
      const draftsWl = await getOrCreateDraftsWishlist(user.id);

      const demoItem = await prisma.item.create({
        data: {
          wishlistId: draftsWl.id,
          title: template.title,
          url: template.url,
          priceText: String(template.price),
          currency: template.currency,
          priority: template.priority,
          imageUrl: template.imageUrl,
          description: template.description,
          isDemo: true,
          originType: 'DEMO',
          originVariantKey: variantKey,
        },
        select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
      });
      // Dual-write: placement for demo item.
      await ensureItemPlacement(prisma, { wishlistId: draftsWl.id, itemId: demoItem.id });

      // Upsert onboarding state
      const v1Meta: OnboardingMeta = { onboardingVariant: 'v1_demo' };
      const state = await prisma.userOnboardingState.upsert({
        where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
        create: {
          userId: user.id,
          onboardingKey: ONBOARDING_KEY,
          version: ONBOARDING_VERSION,
          status: 'IN_PROGRESS',
          variantKey,
          entryPoint: effectiveEntryPoint,
          demoItemId: demoItem.id,
          startedAt: now,
          metaJson: v1Meta as any,
        },
        update: {
          status: 'IN_PROGRESS',
          variantKey,
          entryPoint: effectiveEntryPoint,
          demoItemId: demoItem.id,
          startedAt: now,
          metaJson: v1Meta as any,
        },
      });

      trackEvent('onboarding_variant_assigned', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        onboarding_variant: 'v1_demo',
        onboarding_flow: 'v1_demo_recovery',
        experiment_phase: 'legacy_recovery',
        assignment_source: assignmentSource,
        variant_key: variantKey,
        entry_point: effectiveEntryPoint,
        forced_rollout: elig.forcedRollout,
        market_segment: marketSegment,
        locale_used: locale,
      });

      trackEvent('onboarding_started', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        variant_key: variantKey,
        entry_point: effectiveEntryPoint,
        forced_rollout: elig.forcedRollout,
        market_segment: marketSegment,
        locale_used: locale,
        onboarding_variant: 'v1_demo',
        onboarding_flow: 'v1_demo_recovery',
        experiment_phase: 'legacy_recovery',
      });
      trackEvent('demo_item_created', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        variant_key: variantKey,
        entry_point: effectiveEntryPoint,
        forced_rollout: elig.forcedRollout,
        market_segment: marketSegment,
        locale_used: locale,
        item_id: demoItem.id,
      });

      return res.json({ state, demoItem: mapTgItem(demoItem), onboardingVariant: 'v1_demo' as OnboardingVariant });
    }),
  );

  // POST /tg/onboarding/dismiss — dismiss onboarding; deletes untouched demo item if present
  onboardingRouter.post(
    '/onboarding/dismiss',
    asyncHandler(async (req, res) => {
      const parsed = z.object({ onboardingKey: z.string() }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);
      if (parsed.data.onboardingKey !== ONBOARDING_KEY) return res.status(400).json({ error: 'Unknown onboarding key' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const now = new Date();

      // Upsert to DISMISSED — handles case where POST /start was never called (demoItemId = null)
      // This ensures even a soft-CTA "Нет" is recorded and the onboarding won't re-appear.
      const state = await prisma.userOnboardingState.upsert({
        where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
        create: {
          userId: user.id,
          onboardingKey: ONBOARDING_KEY,
          version: ONBOARDING_VERSION,
          status: 'DISMISSED',
          dismissedAt: now,
        },
        update: { status: 'DISMISSED', dismissedAt: now },
      });

      // Clean up demo item only if it is untouched (no meaningful edits).
      // If the user edited the item, it belongs to them — do NOT delete.
      let demoItemDeleted = false;
      if (state.demoItemId) {
        const demoItem = await prisma.item.findUnique({
          where: { id: state.demoItemId },
          select: { id: true, title: true, url: true, priceText: true, becameRealAt: true, status: true },
        });
        if (
          demoItem &&
          demoItem.status !== 'DELETED' &&
          state.variantKey &&
          getDemoTemplate(state.variantKey) &&
          isDemoItemUntouched(demoItem, getDemoTemplate(state.variantKey)!)
        ) {
          await prisma.item.update({
            where: { id: state.demoItemId },
            data: { status: 'DELETED', archivedAt: now },
          });
          demoItemDeleted = true;
        }
      }

      // v2 cleanup: only delete fallback demo item, never touch imported/catalog items
      const meta = getOnboardingMeta(state.metaJson);
      if (meta.onboardingVariant === 'v2_try' && meta.fallbackDemoItemId) {
        const fallbackItem = await prisma.item.findUnique({
          where: { id: meta.fallbackDemoItemId },
          select: { id: true, status: true, isDemo: true },
        });
        if (fallbackItem && fallbackItem.isDemo && fallbackItem.status !== 'DELETED') {
          await prisma.item.update({
            where: { id: meta.fallbackDemoItemId },
            data: { status: 'DELETED', archivedAt: now },
          });
          demoItemDeleted = true;
        }
      }

      const dismissLocale = getRequestLocale(req);
      trackEvent('onboarding_dismissed', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        variant_key: state.variantKey ?? null,
        entry_point: state.entryPoint ?? null,
        forced_rollout: FORCED_ROLLOUT_USERS.has(user.id),
        market_segment: state.variantKey ? variantKeyToSegment(state.variantKey) : resolveMarketSegment(dismissLocale),
        locale_used: dismissLocale,
        demo_item_deleted: demoItemDeleted,
        onboarding_variant: meta.onboardingVariant ?? 'v1_demo',
        experiment_phase: (meta.onboardingVariant ?? 'v1_demo') === 'v1_demo' ? 'legacy_recovery' : 'post_rollout',
        onboarding_flow: (meta.onboardingVariant ?? 'v1_demo') === 'v1_demo' ? 'v1_demo_recovery' : 'main_v2',
      });

      return res.json({ ok: true, demoItemDeleted });
    }),
  );

  // POST /tg/onboarding/complete — explicitly mark onboarding complete (called by frontend after auto-completion)
  onboardingRouter.post(
    '/onboarding/complete',
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({ onboardingKey: z.string(), reason: z.enum(['demo_converted', 'real_item_created', 'demo_deleted_then_real_created', 'demo_moved_to_user_wishlist', 'try_import_completed', 'catalog_selected', 'manual_created']) })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);
      if (parsed.data.onboardingKey !== ONBOARDING_KEY) return res.status(400).json({ error: 'Unknown onboarding key' });

      const user = await getOrCreateTgUser(req.tgUser!);
      // completeOnboarding() fires 'onboarding_completed' analytics event internally (idempotent).
      await completeOnboarding(user.id, parsed.data.reason);

      return res.json({ ok: true });
    }),
  );

  // POST /tg/onboarding/try-import — import URL from onboarding v2 (NO PRO gate)
  onboardingRouter.post(
    '/onboarding/try-import',
    onboardingImportLimiter,
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({ url: z.string().min(1).max(2048), onboardingStateId: z.string() })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      try { validateUrl(parsed.data.url); } catch (err: any) {
        return res.status(400).json({ error: err.message || 'Invalid URL' });
      }

      const user = await getOrCreateTgUser(req.tgUser!);
      const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });

      if (!state || state.userId !== user.id || state.status !== 'IN_PROGRESS') {
        return res.status(409).json({ error: 'Invalid onboarding state' });
      }

      const meta = getOnboardingMeta(state.metaJson);
      if (meta.onboardingVariant !== 'v2_try') {
        return res.status(400).json({ error: 'Wrong variant for try-import' });
      }
      if ((meta.tryAttemptsUsed ?? 0) >= 30) {
        return res.status(429).json({ error: 'Max attempts reached' });
      }
      if ((meta.trySuccessCount ?? 0) >= 20) {
        return res.status(409).json({ error: 'Onboarding trial limit reached', limit: 20 });
      }

      // NO PRO gate — onboarding free pass
      const result = await importUrlForUser(user.id, parsed.data.url, undefined, 'onboarding_try');

      const newMeta: OnboardingMeta = {
        ...meta,
        tryAttemptsUsed: (meta.tryAttemptsUsed ?? 0) + 1,
      };

      if (result.parseStatus !== 'failed') {
        newMeta.trySuccessCount = (meta.trySuccessCount ?? 0) + 1;
        newMeta.tryImportedItemIds = [...(meta.tryImportedItemIds ?? []), result.item.id];
        newMeta.acquisitionPath = 'try_import';
        newMeta.lastStep = 'onboarding-success';
      } else {
        newMeta.lastStep = 'onboarding-recovery';
      }

      await prisma.userOnboardingState.update({
        where: { id: state.id },
        data: { metaJson: newMeta as any },
      });

      const eventName = result.parseStatus !== 'failed' ? 'onboarding_try_import_success' : 'onboarding_try_import_failed';
      trackEvent(eventName, user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        onboarding_variant: 'v2_try',
        parse_status: result.parseStatus,
        attempt_number: newMeta.tryAttemptsUsed,
        url_domain: result.item.sourceDomain ?? null,
        item_id: result.item.id,
      });

      return res.status(201).json({ item: result.item, parseStatus: result.parseStatus, wishlistId: result.wishlistId });
    }),
  );

  // POST /tg/onboarding/manual-add — add item manually during onboarding (v2)
  onboardingRouter.post(
    '/onboarding/manual-add',
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({
          title: z.string().min(1).max(200),
          priceText: z.string().max(100).optional(),
          onboardingStateId: z.string(),
        })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);
      const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });

      if (!state || state.userId !== user.id || state.status !== 'IN_PROGRESS') {
        return res.status(409).json({ error: 'Invalid onboarding state' });
      }
      const meta = getOnboardingMeta(state.metaJson);
      if (meta.onboardingVariant !== 'v2_try') {
        return res.status(400).json({ error: 'Wrong variant for manual-add' });
      }

      const draftsWl = await getOrCreateDraftsWishlist(user.id);
      const item = await prisma.item.create({
        data: {
          wishlistId: draftsWl.id,
          title: parsed.data.title.trim(),
          url: '',
          priceText: parsed.data.priceText?.trim() || null,
          importMethod: 'onboarding_manual',
        },
      });
      // Dual-write: placement for onboarding-manual item.
      await ensureItemPlacement(prisma, { wishlistId: draftsWl.id, itemId: item.id });

      const newMeta: OnboardingMeta = {
        ...meta,
        manualItemIds: [...(meta.manualItemIds ?? []), item.id],
        acquisitionPath: meta.acquisitionPath ?? 'manual',
        lastStep: 'onboarding-create-wishlist',
      };
      await prisma.userOnboardingState.update({
        where: { id: state.id },
        data: { metaJson: newMeta as any },
      });

      trackEvent('onboarding_manual_item_added', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        onboarding_variant: 'v2_try',
        item_id: item.id,
        has_price: !!parsed.data.priceText,
      });

      return res.status(201).json({ item, ok: true });
    }),
  );

  // POST /tg/onboarding/catalog-select — create items from catalog templates (v2)
  onboardingRouter.post(
    '/onboarding/catalog-select',
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({ catalogKeys: z.array(z.string()).min(1).max(6), onboardingStateId: z.string() })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);
      const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });

      if (!state || state.userId !== user.id || state.status !== 'IN_PROGRESS') {
        return res.status(409).json({ error: 'Invalid onboarding state' });
      }
      const meta = getOnboardingMeta(state.metaJson);
      if (meta.onboardingVariant !== 'v2_try') {
        return res.status(400).json({ error: 'Wrong variant' });
      }

      const locale = getRequestLocale(req);
      const segment = resolveMarketSegment(locale);
      const catalog = getCatalogForSegment(segment);
      const selected = parsed.data.catalogKeys
        .map((k: string) => catalog.find((c: CatalogTemplate) => c.key === k))
        .filter((c: CatalogTemplate | undefined): c is CatalogTemplate => !!c);

      if (selected.length === 0) return res.status(400).json({ error: 'No valid catalog items' });

      const draftsWl = await getOrCreateDraftsWishlist(user.id);
      const createdIds: string[] = [];
      for (const tmpl of selected) {
        const item = await prisma.item.create({
          data: {
            wishlistId: draftsWl.id,
            title: t(tmpl.titleKey, locale),
            url: '',
            priceText: String(tmpl.amount),
            currency: tmpl.currency,
            originVariantKey: `catalog_${tmpl.key}`,
            importMethod: 'onboarding_catalog',
            // NOT isDemo — catalog selections are real user intent
          },
        });
        // Dual-write: placement for each catalog-created item.
        await ensureItemPlacement(prisma, { wishlistId: draftsWl.id, itemId: item.id });
        createdIds.push(item.id);
      }

      const newMeta: OnboardingMeta = {
        ...meta,
        catalogItemIds: createdIds,
        acquisitionPath: meta.acquisitionPath ?? 'catalog',
        lastStep: 'onboarding-create-wishlist',
      };
      await prisma.userOnboardingState.update({
        where: { id: state.id },
        data: { metaJson: newMeta as any },
      });

      trackEvent('onboarding_catalog_submitted', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        onboarding_variant: 'v2_try',
        catalog_keys: parsed.data.catalogKeys,
        count: selected.length,
        market_segment: segment,
      });

      return res.status(201).json({ ok: true, catalogItemIds: createdIds });
    }),
  );

  // POST /tg/onboarding/update-step — persist lastStep + optional acquisitionPath for resume
  onboardingRouter.post(
    '/onboarding/update-step',
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({
          onboardingStateId: z.string(),
          step: z.string().max(50),
          acquisitionPath: z.enum(['try_import', 'manual', 'catalog', 'fallback_demo']).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);
      const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });
      if (!state || state.userId !== user.id) return res.status(404).json({ error: 'Not found' });

      const meta = getOnboardingMeta(state.metaJson);
      const updated: OnboardingMeta = { ...meta, lastStep: parsed.data.step };
      if (parsed.data.acquisitionPath) updated.acquisitionPath = parsed.data.acquisitionPath;

      await prisma.userOnboardingState.update({
        where: { id: state.id },
        data: { metaJson: updated as any },
      });

      return res.json({ ok: true });
    }),
  );

  // POST /tg/onboarding/create-wishlist — create first wishlist and auto-attach onboarding items
  onboardingRouter.post(
    '/onboarding/create-wishlist',
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({
          title: z.string().min(1).max(200),
          onboardingStateId: z.string(),
        })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);
      const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });
      if (!state || state.userId !== user.id || state.status !== 'IN_PROGRESS') {
        return res.status(409).json({ error: 'Invalid onboarding state' });
      }

      const meta = getOnboardingMeta(state.metaJson);
      if (meta.onboardingVariant !== 'v2_try') {
        return res.status(400).json({ error: 'Wrong variant' });
      }

      // Create / claim the wishlist.
      //
      // E04 — delegate the "is there a default to rename?" decision to the
      // service so this handler stays race-safe AT THE SAME TIME as it
      // reuses a single source of truth. Sequence (review iter-1 fix #5 +
      // #6):
      //
      //   1. `getOrCreateDefaultWishlist` — idempotent + race-safe via the
      //      partial unique index `(ownerId) WHERE isDefault=true` and
      //      P2002 catch. On return, the user is guaranteed to own at
      //      least one REGULAR wishlist — either the bootstrap-created
      //      default (isDefault=true), a prior manual create
      //      (isDefault=false), or the row we just created here.
      //   2. If `ensured.isDefault === true` → RENAME in place. The
      //      handler picks up the bootstrap row, applies the user's title,
      //      clears the flag, and propagates `position=0` +
      //      inheritedCommentPolicy. Items from SYSTEM_DRAFTS get moved
      //      into the same id below — single REGULAR wishlist, no
      //      orphan default.
      //   3. If `ensured.isDefault === false` → the user already owns a
      //      non-default REGULAR (returning user, manual create + delete-
      //      items combo that bypassed the eligibility "has_real_items"
      //      check). Defensively CREATE a new named wishlist alongside
      //      rather than renaming their existing one — that would silently
      //      stomp on a wishlist they intentionally named. This branch is
      //      rare; the eligibility gate should keep most users out of it.
      const position = 0; // top position for first wishlist
      const profile = await prisma.userProfile.findUnique({ where: { userId: user.id }, select: { commentsEnabled: true } });
      const inheritedCommentPolicy = profile?.commentsEnabled === false ? 'SUBSCRIBERS' : 'ALL';
      const locale = getRequestLocale(req);
      const ensured = await getOrCreateDefaultWishlist(user.id, locale);
      const wishlist = ensured.isDefault
        ? await prisma.wishlist.update({
            where: { id: ensured.id },
            data: {
              title: parsed.data.title.trim(),
              isDefault: false,
              position,
              commentPolicy: inheritedCommentPolicy,
            },
            select: { id: true, slug: true, title: true, description: true, deadline: true },
          })
        : await prisma.wishlist.create({
            data: {
              slug: `wl-${crypto.randomUUID().slice(0, 12)}`,
              ownerId: user.id,
              title: parsed.data.title.trim(),
              type: 'REGULAR',
              position,
              commentPolicy: inheritedCommentPolicy,
            },
            select: { id: true, slug: true, title: true, description: true, deadline: true },
          });

      // Collect all onboarding item IDs to move.
      // Bug history: manualItemIds was missing here, so items the user added
      // through the /onboarding/manual-add path stayed in SYSTEM_DRAFTS forever
      // (invisible in the new REGULAR wishlist) — also blocked referral
      // first_item crediting because move logic drove that hook.
      const itemIdsToMove: string[] = [
        ...(meta.tryImportedItemIds ?? []),
        ...(meta.catalogItemIds ?? []),
        ...(meta.manualItemIds ?? []),
      ];

      // Move items from SYSTEM_DRAFTS to the new wishlist.
      // Onboarding items have a single placement in drafts; we reuse relocateItemPrimary
      // so placements migrate alongside Item.wishlistId (otherwise placement-based reads
      // would still show the items in drafts and hide them from the new wishlist).
      let movedCount = 0;
      if (itemIdsToMove.length > 0) {
        const eligibleItems = await prisma.item.findMany({
          where: {
            id: { in: itemIdsToMove },
            wishlist: { ownerId: user.id, type: 'SYSTEM_DRAFTS' },
            status: { in: ['AVAILABLE', 'RESERVED'] },
          },
          select: { id: true, wishlistId: true },
        });
        for (const item of eligibleItems) {
          await relocateItemPrimary(item.id, item.wishlistId, wishlist.id);
        }
        movedCount = eligibleItems.length;
      }

      // Update onboarding state
      const newMeta: OnboardingMeta = {
        ...meta,
        lastStep: 'onboarding-share',
      };
      await prisma.userOnboardingState.update({
        where: { id: state.id },
        data: { metaJson: newMeta as any },
      });

      // `locale` is already in scope from the rename/create block above —
      // no need to re-resolve from the request.
      trackEvent('onboarding_create_wishlist_success', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        onboarding_variant: 'v2_try',
        acquisition_path: meta.acquisitionPath ?? null,
        wishlist_id: wishlist.id,
        items_moved: movedCount,
        market_segment: resolveMarketSegment(locale),
      });

      trackEvent('onboarding_items_attached_to_wishlist', user.id, {
        onboarding_key: ONBOARDING_KEY,
        onboarding_variant: 'v2_try',
        wishlist_id: wishlist.id,
        item_ids: itemIdsToMove,
        moved_count: movedCount,
      });

      // Referral: onboarding's create-wishlist goes through a separate code path
      // from POST /tg/wishlists, so the referral hook wouldn't fire otherwise.
      // Both markers are applicable here: the wishlist is REGULAR, and if any
      // onboarding items got attached (template/try-import/catalog), those count
      // as the user's "first items" — by the time this endpoint returns, both
      // qualification criteria are met.
      void runReferralProgressHook(user.id, 'first_wishlist');
      if (movedCount > 0) {
        void runReferralProgressHook(user.id, 'first_item');
      }

      return res.status(201).json({
        wishlist: { ...wishlist, itemCount: movedCount, reservedCount: 0 },
        movedCount,
      });
    }),
  );

  // ─── end Onboarding Endpoints ─────────────────────────────────────────────────

  return onboardingRouter;
}
