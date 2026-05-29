// Bootstrap order matters and is enforced by file naming:
//   1. dns      — sets ipv6first BEFORE any module opens a socket
//   2. env      — populates process.env from .env BEFORE any module reads it
//   3. sentry   — opt-in error tracking init, depends on env
// Side-effect-only imports; do not reorder.
import './bootstrap/dns';
import './bootstrap/env';
import './bootstrap/sentry';

import express from 'express';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  prisma,
  Prisma,
  sweepExpiredPendingAttributions,
} from '@wishlist/db';
import logger from './logger';
import {
  createRateLimiter,
  combineLimiters,
  createIdempotencyMiddleware,
  ipThrottleGate,
  recordIpEvent,
  startIdempotencyCleanupJob,
  IDEMPOTENCY_BILLING_TTL_MINUTES,
  CRITICAL_IDEMPOTENCY_ROUTES,
} from './security';
import { parseUrl } from './url-parser.js';
import { getOrCreateProfile } from './profile.js';
import { t, resolveEffectiveLocale, pluralize, type Locale, type LanguageMode, type LanguageSettings, getOnboardingMeta, type OnboardingVariant } from '@wishlist/shared';
import { resolveBucketFromRequest, prewarmGeoip } from './services/locale-detection';
import { persistResolvedBucket } from '@wishlist/db';

// Sentry namespace stays imported here so the error handler and the
// uncaughtException / unhandledRejection handlers further down can call
// Sentry.captureException. Init itself happens in ./bootstrap/sentry.
import * as Sentry from '@sentry/node';

import { corsMiddleware } from './middleware/cors';
import { requestLogger } from './middleware/requestLogger';
import { registerHealthRoutes } from './health/health.routes';
import { upload } from './uploads/upload.config';
import { deleteUploadFile } from './uploads/uploadCleanup';
import { registerUploads } from './uploads/registerUploads';

import { secureCompare } from './lib/crypto';
import { getRequestLocale } from './lib/locale';
import { sendTgNotification, sendTgBotMessage } from './telegram/botApi';
import { sendAdminAlert } from './notifications/adminAlerts';

import { ensureItemPlacement } from './placements/ensureItemPlacement';

import { registerInternalRouter } from './routes/internal.routes';
import { registerAdminRouter } from './routes/admin.routes';
import { registerPublicRouter } from './routes/public.routes';
import { registerMeRouter } from './routes/me.routes';
import { registerRefRouter } from './routes/referral.routes';
import { registerSupportRouter } from './routes/support.routes';
import { registerGiftNotesRouter } from './routes/gift-notes.routes';
import { registerProfilesRouter } from './routes/profiles.routes';
import { registerTelemetryRouter } from './routes/telemetry.routes';
import { registerAnalyticsRouter } from './routes/analytics.routes';
import { registerMaintenanceRouter } from './routes/maintenance.routes';
import { registerImportRouter } from './routes/import.routes';
import { registerBirthdayRemindersRouter } from './routes/birthday-reminders.routes';
import { registerPromoRouter } from './routes/promo.routes';
import { registerOnboardingRouter } from './routes/onboarding.routes';
import { registerSelectionsArchiveRouter } from './routes/selections-archive.routes';
import { registerReservationsRouter } from './routes/reservations.routes';
import { registerCommentsRouter } from './routes/comments.routes';
import { registerHintsRouter } from './routes/hints.routes';
import { registerGroupGiftsRouter } from './routes/group-gifts.routes';
import { registerBillingRouter } from './routes/billing.routes';
import { registerItemsRouter } from './routes/items.routes';
import { registerWishlistsRouter } from './routes/wishlists.routes';
import { registerSantaRouter } from './routes/santa.routes';
import { registerSearchRouter } from './routes/search.routes';
import { registerResearchSurveyRouter } from './routes/research-survey.routes';
import { registerExperimentsRouter } from './routes/experiments.routes';
import { startCleanupSchedulers } from './schedulers/cleanup';
import { startBillingSchedulers } from './schedulers/billing';
import { startReferralSchedulers } from './schedulers/referral';
import { startReferralRetentionSchedulers } from './schedulers/referral-retention';
import { startSantaSchedulers, runSantaStartupJobs } from './schedulers/santa';
import {
  startReservationReminderScheduler,
  startSmartReservationSchedulers,
} from './schedulers/reservations';
import { startEventSchedulers } from './schedulers/events';
import { startLifecycleScheduler } from './schedulers/lifecycle';
import { startProRenewalReminderScheduler } from './schedulers/pro-renewal';
import { startBirthdayRemindersScheduler } from './schedulers/birthday-reminders';
import { startResearchSurveySendScheduler } from './schedulers/research-survey-send';
import { startDailyActivityRollupScheduler } from './schedulers/daily-activity-rollup';
import { createSendLifecycleDM } from './services/lifecycle';
import { daysUntilNextBirthday, pickBirthdayDisplayName } from './services/birthday-reminders';
import {
  TelegramUser,
  INIT_DATA_MAX_AGE_SECONDS,
  INIT_DATA_CLOCK_SKEW_SECONDS,
  validateTelegramInitData,
  tgActorHash,
  SYSTEM_ACTOR_HASH,
  requireTelegramAuth,
  getOrCreateTgUser,
  resolveTgUserId,
} from './services/telegram-auth';
import {
  PLANS,
  PRO_PRICE_XTR,
  PRO_YEARLY_PRICE_XTR,
  PRO_LIFETIME_PRICE_XTR,
  PRO_SUBSCRIPTION_PERIOD,
  PRO_YEARLY_EXTEND_SECONDS,
  PRO_PLAN_CODE,
  GIFT_NOTES_PRICE_XTR,
  GIFT_NOTES_SKU,
  GROUP_GIFT_SKU,
  SECRET_RESERVATION_PRICE_XTR,
  SECRET_RESERVATION_SKU,
  ONE_TIME_SKUS,
  ADDON_CAPS,
  hasReservationPro,
  getSmartResLeadHours,
  hasSmartReservations,
  getUserEntitlement,
  getEffectiveEntitlements,
  isWishlistWritable,
  requireGiftNotes,
} from './services/entitlement';
import { trackEvent, trackAnalyticsEvent } from './services/analytics';
import { runReferralProgressHook, notifyReferralInviterRewarded } from './services/referral-hooks';
import {
  getSeasonStartYear,
  getSeasonCalendar,
  getSantaSeasonInfo,
  generateSantaAliases,
  sendSeasonalBroadcast,
  maybeRunSeasonalEvents,
} from './services/santa-season';
import {
  DRAFTS_ITEM_LIMIT,
  reassignPrimaryBeforeWishlistDelete,
  createGetOrCreateDraftsWishlist,
  createGetOrCreateDefaultWishlist,
} from './services/wishlists';
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
  isMeaningfulEdit,
  checkOnboardingEligibility,
  createCompleteOnboarding,
} from './services/onboarding';
import {
  ACTIVE_STATUSES,
  cancelItemHints,
  notifySubscribersOfChange,
  countItemPlacements,
  extractNumericPrice,
  priorityToNum,
  numToPriority,
  mapTgItem,
  getItemRole,
} from './services/items';
import { createImportUrlForUser } from './services/url-import';

const PORT = Number(process.env.PORT ?? 3001);

const app = express();

// Trust the first proxy (nginx) so X-Forwarded-For is used for req.ip.
// Without this, express-rate-limit sees 127.0.0.1 for all requests behind nginx
// and rate-limits incorrectly. Also silences ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// Disable automatic ETag generation. Mini App loaders check `if (!res.ok)`,
// which evaluates `false` for 304 (status is outside 200-299) — and on WebKit
// (iOS Telegram, Telegram desktop on macOS) `fetch()` sometimes passes the 304
// through to JS with empty body instead of transparently substituting the
// cached body. The result: every conditional GET that revalidates as 304
// surfaces as a "Ошибка загрузки" toast in the Mini App. State endpoints save
// negligible bandwidth from 304s (responses are 200-500 bytes). Note: this
// app-level flag does NOT affect `express.static` — the /uploads handler
// generates its own ETags via `serve-static`, but `immutable` + 30d max-age
// means clients never revalidate, so 304 doesn't happen in practice there.
// Companion defense lives in the Mini App's `tgFetch` (cache: 'no-store') —
// see docs/BUGFIX_LESSONS.md (2026-05-18) for the full chain.
app.set('etag', false);

// Middleware order MUST stay: helmet → cors → express.json → requestLogger →
// /uploads → /health → maintenance gate → routers → error handler. See
// docs/BACKEND_MAP.md § "Middleware Chain". The infrastructure pieces have
// moved into modules under ./middleware, ./uploads, ./health — the order
// here is unchanged except for helmet which was added 2026-05-28.
//
// Helmet config: CSP disabled because this process serves JSON + /uploads
// (static images), no HTML — there's no document context for inline-script
// rules to apply to. The Mini App lives in apps/web behind Cloudflare and
// has its own headers there. We keep all other Helmet defaults: HSTS
// (Cloudflare also sets it; duplicate-header is harmless and origin-only
// hardening matters when CF is bypassed), X-Content-Type-Options: nosniff
// (prevents browsers from MIME-sniffing `/api/uploads/<uuid>.jpg` as HTML
// if an attacker ever lands a polyglot past the magic-bytes guard),
// Referrer-Policy: no-referrer, and X-DNS-Prefetch-Control: off.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(corsMiddleware);
app.use(express.json());
app.use(requestLogger);

// /uploads static handler (30-day immutable cache).
registerUploads(app);

// /health (liveness) and /health/deep (DB + bot heartbeat readiness).
// Both intentionally bypass auth and the /tg+/public maintenance gate.
registerHealthRoutes(app);

const tgRouter = express.Router();
// --- Shared helpers
const ItemStatusSchema = z.enum(['AVAILABLE', 'RESERVED', 'PURCHASED', 'COMPLETED', 'DELETED', 'ARCHIVED']);
const PrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
// ACTIVE_STATUSES extracted to ./services/items.ts in P5s-6 (Strategy A).
// Imported below alongside the rest of the items helpers.

// Normalize bare domain URLs like "audi.com" → "https://audi.com"
const normalizeUrl = (val: string) => {
  const v = val.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
};
const zUrl = () => z.string().transform(normalizeUrl).pipe(z.string().url());

// Sort logic lives in sort.ts (no external deps → easy to unit-test)
import { ITEM_ORDER_BY, sortItemsJs, type SortableItem } from './sort.js';
export { ITEM_ORDER_BY, sortItemsJs, type SortableItem };

const actorBodySchema = z.object({
  actorHash: z.string().uuid(),
});

// resolveUserFirstName extracted to ./services/locale.ts in P5s-10.
// Strategy B: imported directly by routes/reservations.routes.ts.

// cancelItemHints + notifySubscribersOfChange extracted to
// ./services/items.ts in P5s-6 (Strategy A). Imported below.

// generateUniqueSupportId + getOrCreateProfile live in ./profile so they can
// be unit-tested in isolation (race-condition repro for P2002 on userId).

// ─── Shared-wish placements ──────────────────────────────────────────────────
// Every Item has a row in WishlistItemPlacement for each wishlist it lives in.
// During the dual-read migration window, Item.wishlistId / Item.position /
// Item.categoryId continue to exist on the canonical Item row for legacy
// reads — placement writes mirror those values for the item's origin wishlist.
// When an item is placed in additional wishlists, only a placement row is added.

/**
 * Ensure a placement row exists for (wishlistId, itemId). Upsert-style — safe
 * to call when unsure whether the placement already exists (e.g. during
 * legacy create paths that also write Item.wishlistId). Returns the placement.
 *
 * @param tx  Prisma transaction/client
 * @param opts.wishlistId  Target wishlist
 * @param opts.itemId      Item being placed
 * @param opts.position    Position within the wishlist (defaults to appended at end)
 * @param opts.categoryId  Category in target wishlist (null → default category resolved here)
 */
// countItemPlacements extracted to ./services/items.ts in P5s-6.

// reassignPrimaryBeforeWishlistDelete extracted to ./services/wishlists.ts in
// P5s-7 (Strategy A). Imported at the top of this file and continues passing
// through router factory deps unchanged.



// ═══════════════════════════════════════════════════════
// TELEGRAM MINI APP ENDPOINTS
// ═══════════════════════════════════════════════════════

// TelegramUser type, INIT_DATA_* constants, validateTelegramInitData,
// tgActorHash, SYSTEM_ACTOR_HASH, and requireTelegramAuth extracted to
// ./services/telegram-auth.ts in P5s-2 (Strategy A). They are imported
// at the top of this file. The Express.Request.tgUser? global type
// augmentation below stays here so it is loaded with the app entry
// point and visible to every module that reads `req.tgUser` at compile
// time (routes/* declare their own structural narrows for the
// `getOrCreateTgUser` dep contract; the augmentation is what makes
// `req.tgUser!` usable in those structural types).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { tgUser?: TelegramUser; }
  }
}

// ─── Plan & Entitlement System ──────────────────────────────────────────────
// All identifiers (PLANS, PRO_*, GIFT_NOTES_*, GROUP_GIFT_*, SECRET_RESERVATION_*,
// ONE_TIME_SKUS, ADDON_CAPS, types, hasReservationPro,
// getSmartResLeadHours, hasSmartReservations, getUserEntitlement,
// getEffectiveEntitlements, isWishlistWritable) extracted to
// ./services/entitlement.ts in P5s-1 (Strategy A). They are imported at
// the top of this file and continue to flow through router/scheduler
// factory deps unchanged. `requireGiftNotes` stays here below because
// it depends on `trackEvent`, which is also still in this file.

// requireGiftNotes moved to ./services/entitlement.ts in P5s-5 (deferred
// from P5s-1 because it closed over trackEvent; now both live in services/).

// Wire the wishlists service factory once trackEvent is defined. Used by
// registerOnboardingRouter (line ~1463) and the url-import service factory
// just below.
const getOrCreateDraftsWishlist = createGetOrCreateDraftsWishlist({ trackEvent });

// E04 — auto-created default REGULAR wishlist for new users. Wired here so
// the same singleton instance is passed to registerMeRouter (bootstrap call
// in GET /tg/me/profile) AND registerOnboardingRouter (rename-on-create
// path in POST /tg/onboarding/create-wishlist). Closes over the local
// `trackEvent` for dual analytics emit (legacy `wishlist_created` + new
// `wishlist.default_created`) — same factory shape as the drafts helper
// above so the wiring contract stays uniform.
const getOrCreateDefaultWishlist = createGetOrCreateDefaultWishlist({ trackEvent });

// Wire the url-import service factory once both trackEvent and the drafts
// helper are ready. Used by /tg/import-url, /tg/internal/import-url, and
// /tg/onboarding/try-import — all 3 receive the resulting function via
// register*Router deps.
const importUrlForUser = createImportUrlForUser({ trackEvent, getOrCreateDraftsWishlist });

// Calendar pure helpers (getNextOccurrenceDate / computeReminderSchedule /
// buildReminderEpisodeKey) extracted to ./services/calendar.ts in P5s-8.
// Strategy B: imported directly by routes/gift-notes.routes.ts and
// schedulers/events.ts; no longer threaded through their deps factories.

// trackEvent + trackAnalyticsEvent extracted to ./services/analytics.ts in
// P5s-5 (Strategy A — source moves; routes/schedulers/services continue
// receiving the imported references via existing factory deps unchanged).
// ANALYTICS_EVENTS_SET migrates with them as a private module-internal set.

// resolveProactiveUserLocale + notifyReferralInviterRewarded +
// runReferralProgressHook extracted to ./services/referral-hooks.ts in
// P5s-5 (Strategy A — source moves; routes continue receiving the
// imported references via existing factory deps unchanged).
// resolveProactiveUserLocale stays module-private inside the service
// (only consumer is notifyReferralInviterRewarded).

// ─── Onboarding Engine ────────────────────────────────────────────────────────
// Extracted to ./services/onboarding.ts in P5s-3. Strategy hybrid:
//   - 12 identifiers (consts, types, pure helpers, async Prisma readers)
//     imported directly by routes/onboarding.routes.ts and routes/items.routes.ts.
//   - completeOnboarding wired here as a factory because it closes over
//     trackEvent (analytics out of P5s scope), then passed via deps to
//     onboarding + items routers.
const completeOnboarding = createCompleteOnboarding({ trackEvent });

// ─── end Onboarding Engine helpers (extracted to ./services/onboarding.ts) ──

// extractNumericPrice / priorityToNum / numToPriority / mapTgItem extracted
// to ./services/items.ts in P5s-6.

// getOrCreateTgUser extracted to ./services/telegram-auth.ts in P5s-2.
// Imported at the top of this file and continues passing through router
// factory deps unchanged.

// getOrCreateProfile lives in ./profile (see comment above generateUniqueSupportId).

// ItemRole type + getItemRole extracted to ./services/items.ts in P5s-6.

// IP-throttle gate: short-circuits with 429 if this IP has tripped the
// `auth_rejected` threshold (10 failures / 60 s → 5 min cool-off). Runs
// BEFORE requireTelegramAuth so we don't burn HMAC validation on a known-bad
// IP. The trigger itself is fed from inside requireTelegramAuth's 401 branch.
tgRouter.use(ipThrottleGate(['auth_rejected']));

tgRouter.use(requireTelegramAuth);

// Persist raw Telegram language_code + derived segmentation fields on every authenticated request.
// Fields updated: language (raw), normalizedLocale, marketBucket, supportedImportRegion.
// Fire-and-forget: does not block the request path. Uses IS DISTINCT FROM to skip redundant writes.
//
// Multi-signal resolver: when Telegram language_code is missing/empty/unknown,
// falls back through X-Browser-Language → X-Browser-Timezone → IP-geo country →
// first_name script analysis. NEVER downgrades a known bucket to 'unknown' —
// missing signals on one request don't erase a previously-resolved bucket.
//
// Kill switch: set LOCALE_DETECTION_ENABLED=false in /opt/wishlist/.env to
// disable the entire write path (e.g. during a prod incident).
tgRouter.use((req, _res, next) => {
  if (process.env.LOCALE_DETECTION_ENABLED === 'false') return next();
  if (!req.tgUser) return next();

  const telegramId = String(req.tgUser.id);
  const rawLang = req.tgUser.language_code ?? null;
  const firstName = req.tgUser.first_name ?? null;
  const { bucket } = resolveBucketFromRequest(req, { firstName });

  // Skip write entirely when neither a raw language nor a resolved bucket is
  // available — saves a round-trip on the noisy "no signal" case.
  if (bucket === 'unknown' && rawLang == null) return next();

  // Atomic INSERT…ON CONFLICT DO UPDATE in shared services/locale-persistence;
  // never downgrades a known bucket to 'unknown'. Fire-and-forget so the auth
  // path is never blocked by a slow segmentation write.
  persistResolvedBucket({
    target: { telegramId },
    rawLanguage: rawLang,
    bucket,
  }).catch(() => {});
  next();
});

// Error-tracking middleware — records 4xx/5xx responses to AnalyticsEvent.
// Fires on res.on('finish') so it never blocks the request path.
// Includes 401 for auth failure visibility. Event format:
//   error:{METHOD}:{STATUS}:{route}   e.g. error:POST:402:/tg/items
// Route uses req.route.path (Express pattern) so IDs are grouped (:id, :campaignId, …).
tgRouter.use((req, res, next) => {
  res.on('finish', () => {
    const status = res.statusCode;
    if (status >= 400) {
      // Skip internal watchdog health probes — they intentionally trigger a 401
      // (no init data) to verify the route is reachable, and would otherwise
      // dominate error:* metrics (~200/day on /tg/bootstrap).
      if (req.headers['x-watchdog'] === '1') return;

      const route = req.route?.path ? (req.baseUrl + req.route.path) : req.path;

      // Skip known-noise legitimate rejections so error:* events stay
      // signal-only and any future "error rate spike" alarm doesn't false-fire:
      //   • 429 on /telemetry — rate limiter doing its job (5 batches/min
      //     × 20 events = 100 events/min, exceeded only on rapid back-button
      //     mashing or spam clicks). Not a code bug.
      //   • 403 on item comments for guest viewers — third_party role doesn't
      //     have access by design (comments are private to owner+reserver).
      //     Frontend swallows the 403 and renders an empty comment list.
      if (status === 429 && route === '/tg/telemetry') return;
      if (status === 403 && route === '/tg/items/:id/comments') return;

      const method = req.method;
      // Canonical contract: AnalyticsEvent.userId is internal User.id (cuid).
      // We have the Telegram id here from req.tgUser; resolve to the internal
      // id with a fast read-only lookup. If the User row doesn't exist
      // (auth failed pre-upsert) — write NULL, never the Telegram id.
      const tgId = req.tgUser?.id;
      void resolveTgUserId(tgId).then((userId) => {
        prisma.analyticsEvent.create({
          data: { event: `error:${method}:${status}:${route}`, userId },
        }).catch(() => {});
      });
    }
  });
  next();
});

// ─── Wave 1 P0 security protections ──────────────────────────────────────────
// Order on /tg/* state-changing routes:
//   ipThrottleGate(['auth_rejected'])  ← runs BEFORE auth (registered earlier)
//   requireTelegramAuth                ← already wired
//   localeTracking + errorTracking     ← already wired (unchanged)
//   global.auth limiter                ← THIS BLOCK
//   state.changing limiter             ← THIS BLOCK
//   per-endpoint category limiter      ← protectTgRoute(...) entries
//   idempotency middleware             ← protectTgRoute(...) entries
//   route handler                      ← unchanged
//
// Why it's all here, far above the route declarations: tgRouter middleware
// runs in registration order. We need every protective layer registered
// BEFORE the first `tgRouter.post(...)` (which lives ~line 5500+). The
// monolith file is already 20 k lines — slotting these in here keeps the
// per-route handlers below untouched.

// Global auth limiter: 300 req / 5 min per actorHash. Catches accidental
// loops in the Mini App without throttling normal usage (300 req / 5 min ≈
// 1 req/sec sustained — way above what a human can drive).
tgRouter.use(createRateLimiter('global.auth'));

// State-changing limiter: 60 POST/PATCH/DELETE / 5 min per actorHash.
// Read-only paths bypass for free.
const stateChangingLimiter = createRateLimiter('state.changing');
tgRouter.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return stateChangingLimiter(req, res, next);
});

// protectTgRoute — register a method-and-path-scoped middleware stack on
// tgRouter using `.all()` (Express runs all matching handlers in registration
// order). The wrapper short-circuits non-matching methods so a single path
// pattern can carry protection for one method while leaving others alone.
type TgMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';
function protectTgRoute(method: TgMethod, path: string, ...mws: import('express').RequestHandler[]) {
  tgRouter.all(path, (req, res, next) => {
    if (req.method !== method) return next();
    let i = 0;
    const runNext = (err?: unknown) => {
      if (err) return next(err as Error);
      if (i >= mws.length) return next();
      const mw = mws[i++]!;
      try { mw(req, res, runNext); } catch (e) { runNext(e); }
    };
    runNext();
  });
}

// Convenience builders. `idem(endpointKey, opts?)` defaults the category to
// the endpointKey (which is unique anyway) so call sites stay short.
const idem = (endpointKey: string, opts?: { category?: string; noResponseReplay?: boolean; ttlMinutes?: number; critical?: boolean }) =>
  createIdempotencyMiddleware({
    endpointKey,
    category: opts?.category ?? endpointKey,
    noResponseReplay: opts?.noResponseReplay,
    ttlMinutes: opts?.ttlMinutes,
    critical: opts?.critical,
  });

// Billing/Stars: 7-day TTL + critical=true (logs missing header for monitoring
// without blocking — soft-require during rollout).
const billingIdem = (endpointKey: string) =>
  createIdempotencyMiddleware({
    endpointKey,
    category: 'payment',
    ttlMinutes: IDEMPOTENCY_BILLING_TTL_MINUTES,
    critical: true,
  });

// ── Research surveys ─────────────────────────────────────────────────────────
// Per-endpoint rate-limit + idempotency. The GET (loading the survey) also
// transitions invite SENT→OPENED + emits survey.opened, so it's behind the
// gentler 'research.read' limiter rather than the bare 'global.auth'.
protectTgRoute('POST',   '/research/surveys/:surveyId/answer',   createRateLimiter('research.write'), idem('POST /tg/research/surveys/:surveyId/answer',   { category: 'research.write' }));
protectTgRoute('POST',   '/research/surveys/:surveyId/complete', createRateLimiter('research.write'), idem('POST /tg/research/surveys/:surveyId/complete', { category: 'research.write', critical: true }));
protectTgRoute('POST',   '/research/surveys/:surveyId/dismiss',  createRateLimiter('research.write'), idem('POST /tg/research/surveys/:surveyId/dismiss',  { category: 'research.write' }));

// ── Wishlists ────────────────────────────────────────────────────────────────
// POST /tg/wishlists: idempotency options live in `security/idempotencyRoutes.ts`
// so the integration test in `test/integration/idempotency-critical-routes.test.ts`
// shares one source of truth with the production wiring — wiring drift becomes
// a TypeScript error, not a silent test pass.
protectTgRoute('POST',   '/wishlists',                       createRateLimiter('wishlist.create'), createIdempotencyMiddleware(CRITICAL_IDEMPOTENCY_ROUTES.wishlistCreate));
protectTgRoute('PATCH',  '/wishlists/:id',                   idem('PATCH /tg/wishlists/:id', { category: 'wishlist.update' }));
protectTgRoute('DELETE', '/wishlists/:id',                   idem('DELETE /tg/wishlists/:id', { category: 'wishlist.delete' }));
protectTgRoute('POST',   '/wishlists/:id/archive',           idem('POST /tg/wishlists/:id/archive', { category: 'wishlist.state' }));
protectTgRoute('POST',   '/wishlists/:id/unarchive',         idem('POST /tg/wishlists/:id/unarchive', { category: 'wishlist.state' }));
protectTgRoute('POST',   '/wishlists/:id/transfer-items',    idem('POST /tg/wishlists/:id/transfer-items', { category: 'wishlist.update' }));
protectTgRoute('POST',   '/wishlists/reorder',               idem('POST /tg/wishlists/reorder', { category: 'wishlist.update' }));

// ── Wishlist categories (Pro feature) — Wave-2 P2 ────────────────────────────
// Categories CRUD live under /wishlists/:id/categories[/:catId]. Wishlist-
// rooted, but the handlers ship from wishlistsRouter (routes/wishlists.routes
// .ts) — the protectTgRoute(...) tgRouter.all() registration here fires
// before sub-router dispatch, same shape as the rest of the wishlists block.
// Plain `state.changing` rate-limiter (already on tgRouter) is enough — no
// burst/consensus risk; idem prevents double-tap replay during reorder.
protectTgRoute('POST',   '/wishlists/:id/categories',                  idem('POST /tg/wishlists/:id/categories', { category: 'wishlist.category' }));
protectTgRoute('POST',   '/wishlists/:id/categories/reorder',          idem('POST /tg/wishlists/:id/categories/reorder', { category: 'wishlist.category' }));
protectTgRoute('PATCH',  '/wishlists/:wlId/categories/:catId',         idem('PATCH /tg/wishlists/:wlId/categories/:catId', { category: 'wishlist.category' }));
protectTgRoute('DELETE', '/wishlists/:wlId/categories/:catId',         idem('DELETE /tg/wishlists/:wlId/categories/:catId', { category: 'wishlist.category' }));
// Items reorder within a wishlist (Wave-2 P3) — large-payload state-changing
// reorder of items inside one wishlist. Same `wishlist.update` idem category
// as PATCH /wishlists/:id and POST /wishlists/:id/transfer-items.
protectTgRoute('POST',   '/wishlists/:id/items/reorder',               idem('POST /tg/wishlists/:id/items/reorder', { category: 'wishlist.update' }));
// Per-wishlist 'Don't Gift' settings (Wave-2 P4) — Pro-gated PUT, same
// `wishlist.update` idem category as PATCH /wishlists/:id.
protectTgRoute('PUT',    '/wishlists/:id/dont-gift',                   idem('PUT /tg/wishlists/:id/dont-gift', { category: 'wishlist.update' }));

// ── Items (single) ───────────────────────────────────────────────────────────
// POST /tg/wishlists/:id/items: shares CRITICAL_IDEMPOTENCY_ROUTES with the
// integration test — see comment on POST /tg/wishlists above.
protectTgRoute('POST',   '/wishlists/:id/items',             createRateLimiter('item.create'), createIdempotencyMiddleware(CRITICAL_IDEMPOTENCY_ROUTES.itemCreate));
protectTgRoute('PATCH',  '/items/:id',                       idem('PATCH /tg/items/:id', { category: 'item.update' }));
protectTgRoute('DELETE', '/items/:id',                       idem('DELETE /tg/items/:id', { category: 'item.delete' }));
protectTgRoute('POST',   '/items/:id/complete',              idem('POST /tg/items/:id/complete', { category: 'item.state' }));
protectTgRoute('POST',   '/items/:id/restore',               idem('POST /tg/items/:id/restore', { category: 'item.state' }));
protectTgRoute('POST',   '/items/:id/photo',                 idem('POST /tg/items/:id/photo', { category: 'item.photo', noResponseReplay: true }));
protectTgRoute('DELETE', '/items/:id/photo',                 idem('DELETE /tg/items/:id/photo', { category: 'item.photo' }));
protectTgRoute('POST',   '/items/:id/placements',            idem('POST /tg/items/:id/placements', { category: 'item.update' }));
protectTgRoute('DELETE', '/items/:id/placements/:wishlistId', idem('DELETE /tg/items/:id/placements/:wishlistId', { category: 'item.update' }));
// Items extras (Pro features) — Wave-2 P3 closure of the three single-item
// endpoints flagged in routes/items.routes.ts header docblock. All share
// `item.update` idem category; rely on global state.changing rate limit.
protectTgRoute('POST',   '/items/:id/copy',                  idem('POST /tg/items/:id/copy', { category: 'item.update' }));
protectTgRoute('POST',   '/items/:id/move',                  idem('POST /tg/items/:id/move', { category: 'item.update' }));
protectTgRoute('POST',   '/items/:id/move-category',         idem('POST /tg/items/:id/move-category', { category: 'item.update' }));

// ── Items (bulk) ─────────────────────────────────────────────────────────────
// All bulk endpoints share the item.bulk limiter (10 / 10 min) so a single
// burst can't run several batches in succession.
protectTgRoute('POST',   '/items/bulk-move',                 createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-move', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-delete',               createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-delete', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-archive',              createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-archive', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-restore',              createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-restore', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-copy',                 createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-copy', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-hard-delete',          createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-hard-delete', { category: 'item.bulk' }));
// Bulk move-category (Pro feature) — Wave-2 P3 closure; same item.bulk
// limiter + idem category as the other bulk-* operations above.
protectTgRoute('POST',   '/items/bulk-move-category',        createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-move-category', { category: 'item.bulk' }));

// ── Reservations ─────────────────────────────────────────────────────────────
// Reserve gets BOTH limiters (short burst + daily cap). Other reservation
// actions just get the short-window limiter.
protectTgRoute('POST',   '/items/:id/reserve',               ...combineLimiters('reservation.short', 'reservation.day'), idem('POST /tg/items/:id/reserve', { category: 'reservation' }));
protectTgRoute('POST',   '/items/:id/unreserve',             createRateLimiter('reservation.short'), idem('POST /tg/items/:id/unreserve', { category: 'reservation' }));
protectTgRoute('POST',   '/items/:id/secret-reserve',        createRateLimiter('reservation.short'), idem('POST /tg/items/:id/secret-reserve', { category: 'reservation' }));
protectTgRoute('POST',   '/items/:id/extend-reservation',    createRateLimiter('reservation.short'), idem('POST /tg/items/:id/extend-reservation', { category: 'reservation' }));
protectTgRoute('POST',   '/secret-reservations/:id/cancel',      idem('POST /tg/secret-reservations/:id/cancel', { category: 'reservation' }));
protectTgRoute('POST',   '/secret-reservations/:id/acknowledge', idem('POST /tg/secret-reservations/:id/acknowledge', { category: 'reservation' }));
protectTgRoute('POST',   '/secret-reservations/:id/promote',     idem('POST /tg/secret-reservations/:id/promote', { category: 'reservation' }));
protectTgRoute('PATCH',  '/reservations/:itemId/meta',           idem('PATCH /tg/reservations/:itemId/meta', { category: 'reservation' }));
protectTgRoute('POST',   '/reservations/:itemId/reminder',       idem('POST /tg/reservations/:itemId/reminder', { category: 'reservation' }));
protectTgRoute('DELETE', '/reservations/:itemId/reminder',       idem('DELETE /tg/reservations/:itemId/reminder', { category: 'reservation' }));

// ── Comments ─────────────────────────────────────────────────────────────────
// `comment.minute` + `comment.hour` together cap both bursts and totals.
protectTgRoute('POST',   '/items/:id/comments',                  ...combineLimiters('comment.minute', 'comment.hour'), idem('POST /tg/items/:id/comments', { category: 'comment' }));
protectTgRoute('DELETE', '/items/:id/comments/:commentId',       idem('DELETE /tg/items/:id/comments/:commentId', { category: 'comment' }));

// ── Share / Selections / Subscriptions ───────────────────────────────────────
protectTgRoute('POST',   '/wishlists/:id/share-token',           createRateLimiter('share.hour'), idem('POST /tg/wishlists/:id/share-token', { category: 'share' }));
protectTgRoute('DELETE', '/wishlists/:id/share-token',           idem('DELETE /tg/wishlists/:id/share-token', { category: 'share' }));
protectTgRoute('POST',   '/wishlists/:id/selections',            createRateLimiter('share.hour'), idem('POST /tg/wishlists/:id/selections', { category: 'share' }));
protectTgRoute('DELETE', '/selections/:id',                      idem('DELETE /tg/selections/:id', { category: 'share' }));
protectTgRoute('POST',   '/selections/:id/subscribe',            idem('POST /tg/selections/:id/subscribe', { category: 'subscribe' }));
protectTgRoute('DELETE', '/selections/:id/subscribe',            idem('DELETE /tg/selections/:id/subscribe', { category: 'subscribe' }));
protectTgRoute('POST',   '/wishlists/:id/subscribe',             idem('POST /tg/wishlists/:id/subscribe', { category: 'subscribe' }));
protectTgRoute('DELETE', '/wishlists/:id/subscribe',             idem('DELETE /tg/wishlists/:id/subscribe', { category: 'subscribe' }));
// Profile subscribe (Wave-2 P2). Frontend already passes
// `idempotency: { action: 'profile.(un)subscribe:<username>' }` for both
// directions — adding the middleware closes the loop on the server side.
protectTgRoute('POST',   '/profiles/:username/subscribe',        idem('POST /tg/profiles/:username/subscribe', { category: 'subscribe' }));
protectTgRoute('DELETE', '/profiles/:username/subscribe',        idem('DELETE /tg/profiles/:username/subscribe', { category: 'subscribe' }));

// ── Billing / Stars (7-day TTL, critical=true logs missing key) ──────────────
// Recovery rule: the rate limiter sits ONLY on /checkout endpoints. /sync
// stays unlimited so a user who paid but didn't see PRO activate can keep
// refreshing without hitting 429. Idempotency on /sync replays the same
// answer for the same key, so retries are cheap and safe.
protectTgRoute('POST',   '/billing/pro/checkout',                createRateLimiter('payment'), createIdempotencyMiddleware(CRITICAL_IDEMPOTENCY_ROUTES.billingProCheckout));
protectTgRoute('POST',   '/billing/pro/sync',                    billingIdem('POST /tg/billing/pro/sync'));
protectTgRoute('POST',   '/billing/subscription/cancel',         billingIdem('POST /tg/billing/subscription/cancel'));
protectTgRoute('POST',   '/billing/subscription/reactivate',     billingIdem('POST /tg/billing/subscription/reactivate'));
protectTgRoute('POST',   '/billing/addon/checkout',              createRateLimiter('payment'), createIdempotencyMiddleware(CRITICAL_IDEMPOTENCY_ROUTES.billingAddonCheckout));
protectTgRoute('POST',   '/billing/addon/sync',                  billingIdem('POST /tg/billing/addon/sync'));
protectTgRoute('POST',   '/billing/gift-notes/checkout',         createRateLimiter('payment'), billingIdem('POST /tg/billing/gift-notes/checkout'));
protectTgRoute('POST',   '/billing/gift-notes/sync',             billingIdem('POST /tg/billing/gift-notes/sync'));

// ── Onboarding (intentionally NO narrow rate limit) ──────────────────────────
// Telegram Mini App may re-fire /onboarding/start on bootstrap or reopen.
// global.auth + state.changing already cover the upper bound — adding a
// tighter category here would cause spurious 429s on legitimate first-opens.
// Idempotency alone prevents duplicate demo-item creation, which is the
// real risk on these endpoints.
protectTgRoute('POST',   '/onboarding/start',                    idem('POST /tg/onboarding/start', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/dismiss',                  idem('POST /tg/onboarding/dismiss', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/complete',                 idem('POST /tg/onboarding/complete', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/manual-add',               idem('POST /tg/onboarding/manual-add', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/catalog-select',           idem('POST /tg/onboarding/catalog-select', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/update-step',              idem('POST /tg/onboarding/update-step', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/create-wishlist',          idem('POST /tg/onboarding/create-wishlist', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/try-import',               idem('POST /tg/onboarding/try-import', { category: 'onboarding' }));

// ── Group gifts ──────────────────────────────────────────────────────────────
protectTgRoute('POST',   '/items/:id/group-gift',                idem('POST /tg/items/:id/group-gift', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/join',                idem('POST /tg/group-gifts/:id/join', { category: 'groupgift' }));
protectTgRoute('PATCH',  '/group-gifts/:id/amount',              idem('PATCH /tg/group-gifts/:id/amount', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/leave',               idem('POST /tg/group-gifts/:id/leave', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/complete',            idem('POST /tg/group-gifts/:id/complete', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/cancel',              idem('POST /tg/group-gifts/:id/cancel', { category: 'groupgift' }));
protectTgRoute('PATCH',  '/group-gifts/:id/pinned',              idem('PATCH /tg/group-gifts/:id/pinned', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/messages',            idem('POST /tg/group-gifts/:id/messages', { category: 'groupgift' }));

// ── Profile / Settings / Showcase / Avatar / Cover ──────────────────────────
// Avatar/cover use multipart — noResponseReplay=true: we lock the key but
// don't try to cache the response body. A retry with the same key returns
// 409 IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE; the client should verify state.
protectTgRoute('PATCH',  '/me/profile',                          idem('PATCH /tg/me/profile', { category: 'profile.update' }));
protectTgRoute('POST',   '/me/profile/avatar',                   idem('POST /tg/me/profile/avatar', { category: 'profile.upload', noResponseReplay: true }));
protectTgRoute('DELETE', '/me/profile/avatar',                   idem('DELETE /tg/me/profile/avatar', { category: 'profile.update' }));
protectTgRoute('PATCH',  '/me/showcase',                         idem('PATCH /tg/me/showcase', { category: 'profile.update' }));
protectTgRoute('POST',   '/me/showcase/cover',                   idem('POST /tg/me/showcase/cover', { category: 'profile.upload', noResponseReplay: true }));
protectTgRoute('DELETE', '/me/showcase/cover',                   idem('DELETE /tg/me/showcase/cover', { category: 'profile.update' }));
protectTgRoute('PATCH',  '/me/settings',                         idem('PATCH /tg/me/settings', { category: 'profile.update' }));

// God-mode toggle + 'Don't Gift' settings (Wave-2 P4) — Pro/dev-gated user
// settings, same `profile.update` idem category as the rest of the block. The
// god-mode toggle (POST /me/god-mode) was restored 2026-05-29: it flips the
// operator's own `godModeActive` preference, which is ANDed with the
// GOD_MODE_TELEGRAM_IDS allowlist (see services/telegram-auth.ts isGodModeActive)
// — env stays the sole grant gate; the toggle can only suppress for an operator.
protectTgRoute('POST',   '/me/god-mode',                         idem('POST /tg/me/god-mode', { category: 'profile.update' }));
protectTgRoute('PUT',    '/me/dont-gift',                        idem('PUT /tg/me/dont-gift', { category: 'profile.update' }));

// ── Birthday Reminders (state-changing routes) ───────────────────────────────
protectTgRoute('PATCH',  '/me/birthday-settings',                 idem('PATCH /tg/me/birthday-settings', { category: 'profile.update' }));
protectTgRoute('POST',   '/birthday-reminders/mute',              idem('POST /tg/birthday-reminders/mute', { category: 'profile.update' }));
protectTgRoute('DELETE', '/birthday-reminders/mute/:userId',      idem('DELETE /tg/birthday-reminders/mute', { category: 'profile.update' }));

// ── Wave-2 P4 misc state-changing endpoints ─────────────────────────────────
// Final closure of Wave-2 — 4 cross-domain one-offs that didn't fit any
// existing block. New idem categories `promo`, `archive`, `support`, `import`
// follow the domain-named convention from `gift-notes.*` / `groupgift` /
// `santa.*` / `hints`. No new rate-limit categories — `state.changing`
// (already on tgRouter) covers all four; promo and import already have
// per-route limiters (`promoLimiter`, `importUrlLimiter`) inside their
// handlers, which fire AFTER the protectTgRoute middleware.
protectTgRoute('POST',   '/promo/apply',                         idem('POST /tg/promo/apply', { category: 'promo' }));
protectTgRoute('POST',   '/archive/purge',                       createIdempotencyMiddleware({ endpointKey: 'POST /tg/archive/purge', category: 'archive', critical: true }));
protectTgRoute('POST',   '/support/tickets',                     idem('POST /tg/support/tickets', { category: 'support' }));
protectTgRoute('POST',   '/import-url',                          idem('POST /tg/import-url', { category: 'import' }));

// ── Account delete (critical=true; logs missing key for monitoring) ──────────
protectTgRoute('DELETE', '/me/account',                          createIdempotencyMiddleware({ endpointKey: 'DELETE /tg/me/account', category: 'account.delete', critical: true }));
// ─── /Wave 1 P0 protections ──────────────────────────────────────────────────

// ─── /tg/me/* sub-router (P5a split) ────────────────────────────────────────
// Mounted AFTER the protectTgRoute() chain above so that path-scoped
// idempotency / rate-limit middleware (registered as tgRouter.all(...)) fire
// BEFORE any /me handler. Mount form follows admin.routes pattern: paths
// stay byte-identical with /me prefix on every handler, so this is a plain
// `tgRouter.use(meRouter)` without lifting the prefix.
const meRouter = registerMeRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getUserEntitlement,
  hasReservationPro,
  trackEvent,
  getOrCreateDefaultWishlist,
  ACTIVE_STATUSES,
  PRO_PRICE_XTR,
  PRO_YEARLY_PRICE_XTR,
  PRO_LIFETIME_PRICE_XTR,
  ONE_TIME_SKUS,
});
tgRouter.use(meRouter);

// ─── /tg/search + /tg/access/wishlist-opened sub-router ─────────────────────
// Read-only GET + a fire-and-forget POST. Both use the parent tgRouter auth
// chain. Per-endpoint rate-limit lives in the router itself
// (categories `search` + `access.record`).
const searchRouter = registerSearchRouter({
  getOrCreateTgUser,
  trackAnalyticsEvent,
});
tgRouter.use(searchRouter);

// ─── /tg/research/surveys/* sub-router ──────────────────────────────────────
// 4 endpoints (GET by-invite + POST answer/complete/dismiss). Per-endpoint
// rate-limit categories (research.read / research.write) and idempotency are
// wired via protectTgRoute(...) further below.
const researchSurveyRouter = registerResearchSurveyRouter({
  getOrCreateTgUser,
});
tgRouter.use(researchSurveyRouter);

// ─── /tg/experiments/* sub-router (A/B experiment infrastructure) ───────────
// Single GET /experiments/:key — server-side sticky bucket assignment for the
// Mini App `useExperiment` hook. Per-endpoint `research.read` rate-limit lives
// in the router itself; no idempotency middleware — the assignment write is an
// idempotent first-exposure insert, GET-only.
const experimentsRouter = registerExperimentsRouter({
  getOrCreateTgUser,
});
tgRouter.use(experimentsRouter);

// ─── /tg/referral/* sub-router (P5b split) ──────────────────────────────────
// All 4 endpoints are GET-only (read), no path-scoped idempotency middleware
// is registered for /referral, so placement here vs after protectTgRoute() is
// behaviourally equivalent. Kept right after meRouter for visual proximity
// to the other extracted /tg sub-routers.
const refRouter = registerRefRouter({
  getOrCreateTgUser,
  trackAnalyticsEvent,
  PRO_PLAN_CODE,
});
tgRouter.use(refRouter);

// ─── /tg/support/* sub-router (P5d split) ───────────────────────────────────
// 2 handlers: GET /support/lookup/:ticketCode (god-mode gated, in-handler) +
// POST /support/tickets (creates ticket, fires 2 best-effort fetch() calls
// to Telegram for support-chat header + user DM). Direct fetch()es are
// preserved byte-identical inside support.routes.ts — refactoring through
// telegram/botApi.ts would change the message_id capture flow that bot
// reply-routing depends on; deferred to a separate PR.
const supportRouter = registerSupportRouter({
  getOrCreateTgUser,
});
tgRouter.use(supportRouter);

// ─── /tg/{calendar,gift-occasions,gift-occasion-ideas}/* sub-router (P5g
//     split — Gift Notes / Events Calendar v2.1 feature) ─────────────────
// 26 handlers across 3 path groups, all sharing the same Pro-gate
// (requireGiftNotes) and the same Prisma table family (GiftOccasion etc).
// All 8 closure deps are hoisted function declarations or early-defined
// consts (lines 128, 593, 669, 689, 727, 1397, 7990, 7999), so wiring
// alongside meRouter / refRouter / supportRouter here is TDZ-safe — no
// relocation downward needed (unlike P5c, P5e, P5f which reference late
// `const` declarations and had to wire post-mount).
//
// Helpers requireGiftNotes / getNextOccurrenceDate / computeReminderSchedule
// / buildReminderEpisodeKey stay in index.ts; they are shared with the
// gift-occasion reminder scheduler/cron at line ~12060+ (uses all three
// reminder helpers when re-scheduling fired reminders for the next
// occurrence). zUrl likewise stays — also used by item/wishlist handlers
// and adminRouter deps.
// ─── Gift-notes (Wave 2 P1) — 17 state-changing endpoints ────────────────────
// 26 handlers total in routes/gift-notes.routes.ts; 7 GET (read-only,
// no protection needed), 19 state-changing. Two read-marker endpoints
// are intentionally NOT protected:
//   - POST /calendar/inbox/:id/read
//   - POST /calendar/inbox/read-all
// Both are fire-and-forget UPSERTs on CalendarInboxEntry.readAt,
// duplicate-safe by design. Same precedent as
// /me/subscriptions/:id/read (docs/API_SECURITY.md § 4 "Out of Wave-2
// scope (by design)"). Mini App `markInboxRead` / `markInboxAllRead`
// helpers in screens/calendar/api.ts intentionally do not pass
// idempotency option.
//
// Registration order: these protectTgRoute entries land BEFORE the
// `tgRouter.use(giftNotesRouter)` mount below so the gate registration
// on tgRouter fires before the sub-router's handler dispatch.
//
// 0 critical-flag endpoints — no billing flows (those are already
// covered by Wave-1 /billing/gift-notes/checkout|sync), no mass-DM
// fan-outs, no distributed-consensus state. All operations are
// user-CRUD with graceful retry semantics.
//
// 0 new rate-limit categories — `state.changing` (60/5min) suffices
// given the typical user flow (~5-30 ops/session, never bursting).
//
// 1 noResponseReplay flag for the multipart photo upload (matches the
// /items/:id/photo precedent — multipart bodies cannot be cleanly
// replayed; second call with same key returns
// IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE).

// Occasions CRUD + state (5)
protectTgRoute('POST',   '/gift-occasions',                            idem('POST /tg/gift-occasions', { category: 'gift-notes.occasion' }));
protectTgRoute('PATCH',  '/gift-occasions/:id',                        idem('PATCH /tg/gift-occasions/:id', { category: 'gift-notes.occasion' }));
protectTgRoute('DELETE', '/gift-occasions/:id',                        idem('DELETE /tg/gift-occasions/:id', { category: 'gift-notes.occasion' }));
protectTgRoute('POST',   '/gift-occasions/:id/archive',                idem('POST /tg/gift-occasions/:id/archive', { category: 'gift-notes.occasion' }));
protectTgRoute('POST',   '/gift-occasions/:id/complete',               idem('POST /tg/gift-occasions/:id/complete', { category: 'gift-notes.occasion' }));

// Ideas CRUD (6)
protectTgRoute('POST',   '/gift-occasions/:id/ideas',                  idem('POST /tg/gift-occasions/:id/ideas', { category: 'gift-notes.idea' }));
protectTgRoute('PATCH',  '/gift-occasion-ideas/:ideaId',               idem('PATCH /tg/gift-occasion-ideas/:ideaId', { category: 'gift-notes.idea' }));
protectTgRoute('POST',   '/gift-occasion-ideas/:ideaId/photo',         idem('POST /tg/gift-occasion-ideas/:ideaId/photo', { category: 'gift-notes.idea-photo', noResponseReplay: true }));
protectTgRoute('DELETE', '/gift-occasion-ideas/:ideaId/photo',         idem('DELETE /tg/gift-occasion-ideas/:ideaId/photo', { category: 'gift-notes.idea-photo' }));
protectTgRoute('DELETE', '/gift-occasion-ideas/:ideaId',               idem('DELETE /tg/gift-occasion-ideas/:ideaId', { category: 'gift-notes.idea' }));
protectTgRoute('POST',   '/gift-occasion-ideas/:ideaId/complete',      idem('POST /tg/gift-occasion-ideas/:ideaId/complete', { category: 'gift-notes.idea' }));

// Reminders CRUD (3)
protectTgRoute('POST',   '/gift-occasions/:id/reminders',              idem('POST /tg/gift-occasions/:id/reminders', { category: 'gift-notes.reminder' }));
protectTgRoute('PATCH',  '/gift-occasions/:id/reminders/:rid',         idem('PATCH /tg/gift-occasions/:id/reminders/:rid', { category: 'gift-notes.reminder' }));
protectTgRoute('DELETE', '/gift-occasions/:id/reminders/:rid',         idem('DELETE /tg/gift-occasions/:id/reminders/:rid', { category: 'gift-notes.reminder' }));

// Calendar bulk imports (2)
protectTgRoute('POST',   '/calendar/import-holidays',                  idem('POST /tg/calendar/import-holidays', { category: 'gift-notes.import' }));
protectTgRoute('POST',   '/calendar/import-friends-bdays',             idem('POST /tg/calendar/import-friends-bdays', { category: 'gift-notes.import' }));

// Calendar onboarding flag (1) — single-shot UPSERT, server returns
// existing seenAt if already set; idempotency adds replay safety on
// retry. Note: /calendar/inbox/:id/read and /calendar/inbox/read-all
// are NOT protected (read markers, see header comment above).
protectTgRoute('POST',   '/calendar/onboarding-seen',                  idem('POST /tg/calendar/onboarding-seen', { category: 'calendar.onboarding' }));

const giftNotesRouter = registerGiftNotesRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  trackEvent,
  requireGiftNotes,
  zUrl,
});
tgRouter.use(giftNotesRouter);

// ─── /tg/onboarding/* sub-router (P5h split — 9 handlers) ───────────────────
// Cross-domain coupling reminder: demo-item lifecycle helpers
// (getDemoTemplate, completeOnboarding, ONBOARDING_KEY, ONBOARDING_VERSION,
// FORCED_ROLLOUT_USERS, variantKeyToSegment, getOnboardingMeta) are also
// invoked by POST /tg/items (~4520), PATCH /tg/items/:id (~5004),
// DELETE /tg/items/:id (~5104), POST /tg/items/:id/copy (~6541) to fire
// `onboarding_completed` analytics + the `demo_*` completion reasons when
// the demo item is touched. They MUST stay in this file and arrive through
// deps — migrating any of them with the router would break those four
// items handlers.
//
// TDZ-safe at this position: all 13 function deps are hoisted, and the
// 5 const deps (ONBOARDING_KEY/VERSION lines 1006–1007, RU_VARIANTS/
// GLOBAL_VARIANTS lines 1008–1009, FORCED_ROLLOUT_USERS line 1023) are
// declared well before this mount point. No relocation needed (unlike
// P5c/P5e/P5f which had to mount post-`app.use('/tg', tgRouter)` because
// of late-defined `const` deps).
//
// onboardingImportLimiter (formerly at apps/api/src/index.ts:7282) is
// migrated WITH the router — only POST /onboarding/try-import uses it.
const onboardingRouter = registerOnboardingRouter({
  getOrCreateTgUser,
  trackEvent,
  completeOnboarding,
  runReferralProgressHook,
  importUrlForUser,
  getOrCreateDraftsWishlist,
  getOrCreateDefaultWishlist,
  mapTgItem,
});
tgRouter.use(onboardingRouter);

// ─── /tg/selections/* + /tg/archive/* sub-router (P5i split — 8 handlers) ───
// 6 selections + 2 archive endpoints, all sharing CuratedSelection /
// CuratedSelectionSubscription / Item tables. The 3 path-scoped idem
// registrations for selections (DELETE /selections/:id, POST/DELETE
// /selections/:id/subscribe) stay in index.ts at lines 1655–1657 — they
// are `tgRouter.all(...)` middleware that fires BEFORE sub-router dispatch.
//
// All 3 deps (getOrCreateTgUser, trackEvent, mapTgItem) are hoisted
// function declarations defined long before this mount point (lines 731,
// 1287, 1402), so wiring here is TDZ-safe.
//
// Out of scope (stay in index.ts under "core wishlist/items routes"):
//   - POST/GET /tg/wishlists/:id/selections — uses generateUniqueCuratedToken
//     (also in index.ts) and gates on getEffectiveEntitlements.
//   - POST /tg/wishlists/:id/{archive,unarchive}, GET /tg/wishlists/:id/archive
//   - POST /tg/items/bulk-archive
const selectionsArchiveRouter = registerSelectionsArchiveRouter({
  getOrCreateTgUser,
  trackEvent,
  mapTgItem,
});
tgRouter.use(selectionsArchiveRouter);

// ─── /tg/reservations/* + /tg/secret-reservations/* + /tg/items/:id/{reserve,
//     unreserve,extend-reservation,secret-reserve} sub-router (P5j split —
//     16 handlers) ────────────────────────────────────────────────────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1636–1645 so that
// path-scoped idem + rate-limit middleware fires BEFORE these handlers.
//
// 4 reservation-domain helpers migrated WITH the router (sole consumers):
// requireSecretReservations, buildSecretReservationSnapshot,
// deriveSecretReservationState, smartResDerive. The rest (mapTgItem,
// resolveUserFirstName, cancelItemHints, tgActorHash, hasReservationPro,
// hasSmartReservations, getSmartResLeadHours, etc.) stay
// in index.ts because they are also consumed by items/wishlists/admin/
// scheduler code outside this scope.
//
// All deps are hoisted function declarations defined long before this
// mount point, so wiring here is TDZ-safe.
const reservationsRouter = registerReservationsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  mapTgItem,
  trackEvent,
  trackAnalyticsEvent,
  tgActorHash,
  hasReservationPro,
  hasSmartReservations,
  cancelItemHints,
  getSmartResLeadHours,
});
tgRouter.use(reservationsRouter);

// ─── /tg/items/:id/comments* sub-router (P5k split — 4 handlers) ──────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1547–1548 (POST
// /items/:id/comments + DELETE /items/:id/comments/:commentId). Those
// `tgRouter.all(...)` middleware fire BEFORE sub-router dispatch, so the
// rate-limit + idem gates remain in effect.
//
// `getItemRole` (index.ts:1313) stays in index.ts because GET /tg/items/:id
// (out-of-scope core items route) also calls it; it's threaded here via
// deps, same pattern P5j used for `cancelItemHints`.
const commentsRouter = registerCommentsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getItemRole,
  trackEvent,
  tgActorHash,
});
tgRouter.use(commentsRouter);

// ─── /tg/items/:id/hint + /tg/hints/:hintId sub-router (P5k split — 2
//     handlers) ──────────────────────────────────────────────────────────
// `sendHintPickerKeyboard` was migrated WITH this router (sole consumer is
// POST /items/:id/hint). `cancelItemHints` is NOT consumed by these
// handlers — it stays in index.ts for the items/reservations consumers.
//
// Wave-2 P2: POST /items/:id/hint now has protectTgRoute coverage with
// idempotency middleware (category: 'hints'). The handler still has its
// own domain-level anti-spam (3/item/30d + 5/sender/day) plus a 30-min
// idempotent fast-path; this layer adds Idempotency-Key replay safety
// for rapid double-tap. Frontend at MiniApp.tsx L7306 already passes
// `idempotency: { action: 'hint:${item.id}' }`.
protectTgRoute('POST',   '/items/:id/hint',                     idem('POST /tg/items/:id/hint', { category: 'hints' }));
const hintsRouter = registerHintsRouter({
  getOrCreateTgUser,
  getUserEntitlement,
  trackEvent,
});
tgRouter.use(hintsRouter);

// ─── /tg/group-gifts/* + /tg/items/:id/group-gift sub-router (P5l — 13
//     handlers) ──────────────────────────────────────────────────────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1592–1599 (the
// seven groupgift-category state-changing endpoints). Those
// `tgRouter.all(...)` middleware fire BEFORE sub-router dispatch, so the
// rate-limit + idem gates remain in effect.
//
// `mapGroupGift` and `groupGiftInclude` were migrated WITH this router —
// they have zero callers outside the group-gift handler block.
// The unlock price is no longer threaded as a dep: it is bucket-aware (E24
// `group-gift-price` experiment) and resolved per-user inside the router via
// services/group-gift-pricing.ts.
const groupGiftsRouter = registerGroupGiftsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  tgActorHash,
  trackEvent,
});
tgRouter.use(groupGiftsRouter);

// ─── /tg/billing/* sub-router (P5m — 9 handlers) ──────────────────────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1568–1575 (the eight
// billing-category state-changing endpoints). Those `tgRouter.all(...)`
// middleware fire BEFORE sub-router dispatch, so idem (`category: 'payment'`,
// 7d TTL, critical=true) and the `payment` rate-limit on the 3 checkout
// endpoints remain in effect.
//
// All billing constants (PRO_PRICE_XTR, PRO_YEARLY_PRICE_XTR,
// PRO_SUBSCRIPTION_PERIOD, PRO_PLAN_CODE, GIFT_NOTES_PRICE_XTR,
// GIFT_NOTES_SKU, ONE_TIME_SKUS, ADDON_CAPS) STAY in index.ts — they are
// shared with the entitlement function, the SKU table itself, the renewal-
// reminder scheduler, and meRouter. The router uses them via deps so all
// consumers reference the same authoritative values.
//
// Bot side (apps/bot/src/index.ts:1103+) — `pre_checkout_query` and
// `successful_payment` handlers — owns Subscription activation and
// UserAddOn creation. Invoice payload formats are byte-identical
// (pro_monthly|pro_yearly|pro_lifetime|addon:<sku>|addon:gift_notes_unlock).
const billingRouter = registerBillingRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getUserEntitlement,
  trackEvent,
  trackAnalyticsEvent,
  hasReservationPro,
  PRO_PRICE_XTR,
  PRO_YEARLY_PRICE_XTR,
  PRO_LIFETIME_PRICE_XTR,
  PRO_SUBSCRIPTION_PERIOD,
  PRO_PLAN_CODE,
  GIFT_NOTES_PRICE_XTR,
  GIFT_NOTES_SKU,
  ONE_TIME_SKUS,
  ADDON_CAPS,
});
tgRouter.use(billingRouter);

// ─── /tg/items/* sub-router (P5n — 21 handlers, root-namespace items
//     routes only; wishlist-rooted item routes stay in index.ts) ─────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1516–1533 (PATCH/
// DELETE /items/:id, /items/:id/{complete,restore,photo,placements,
// placements/:wishlistId}, 6× /items/bulk-*). Those `tgRouter.all(...)`
// middleware fire BEFORE sub-router dispatch, so idem (`category: 'item.*'`)
// and bulk rate-limits remain in effect.
//
// All shared helpers — mapTgItem, countItemPlacements, cancelItemHints,
// isWishlistWritable, getItemRole, ACTIVE_STATUSES — STAY in index.ts and
// are passed via deps. They are also consumed by wishlist handlers and
// other already-extracted routers (reservations, comments).
//
// Pre-existing security gaps (NOT addressed here — flag-only):
//   - POST /tg/items/:id/move-category, /tg/items/bulk-move-category,
//     /tg/items/:id/move, /tg/items/:id/copy — no idempotency middleware.
const itemsRouter = registerItemsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getUserEntitlement,
  getItemRole,
  tgActorHash,
  trackEvent,
  trackAnalyticsEvent,
  mapTgItem,
  isWishlistWritable,
  countItemPlacements,
  cancelItemHints,
  notifySubscribersOfChange,
  ACTIVE_STATUSES,
  zUrl,
  numToPriority,
  completeOnboarding,
});
tgRouter.use(itemsRouter);

// ─── /tg/wishlists/* sub-router (P5o — 26 handlers, all wishlists routes
//     including categories sub-tree, wishlist-rooted item routes, and
//     dont-gift settings) ──────────────────────────────────────────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1506–1515 (POST
// /wishlists, PATCH/DELETE /wishlists/:id, archive/unarchive, transfer-
// items, reorder, POST /wishlists/:id/items) and 1556–1563 (share-token,
// selections, subscribe). Those `tgRouter.all(...)` middleware fire
// BEFORE sub-router dispatch, so idem (wishlist.create, wishlist.update,
// wishlist.delete, wishlist.state, item.create, share, subscribe) and
// rate-limits (wishlist.create + share.hour + item.create) remain in
// effect.
//
// `attributeLifecycleReturn` migrated WITH this router (sole consumer).
// `reassignPrimaryBeforeWishlistDelete` STAYS in index.ts — also passed
// to adminRouter (line 6733). All other helpers passed via deps.
//
// Pre-existing security gaps (NOT addressed here — flag-only):
//   - POST /wishlists/:id/items/reorder, POST /wishlists/:id/categories,
//     PATCH/DELETE /wishlists/:wlId/categories/:catId, POST /wishlists/
//     :id/categories/reorder, PUT /wishlists/:id/dont-gift — no idem.
const wishlistsRouter = registerWishlistsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getUserEntitlement,
  trackEvent,
  trackAnalyticsEvent,
  mapTgItem,
  isWishlistWritable,
  reassignPrimaryBeforeWishlistDelete,
  getOrCreateDefaultWishlist,
  runReferralProgressHook,
  notifySubscribersOfChange,
  hasSmartReservations,
  ACTIVE_STATUSES,
  ONE_TIME_SKUS,
  numToPriority,
  completeOnboarding,
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
  FORCED_ROLLOUT_USERS,
  variantKeyToSegment,
  zUrl,
});
tgRouter.use(wishlistsRouter);

// ─── Santa (Wave 2) — 38 state-changing endpoints ────────────────────────
// 58 santa handlers total in routes/santa.routes.ts; 19 are GET (read-only,
// no protection needed) and 39 are state-changing. One state-changing
// endpoint — POST /santa/campaigns/:id/chat/read — is intentionally NOT
// protected because it is a fire-and-forget read-cursor upsert,
// duplicate-safe by design. Same precedent as /me/subscriptions/:id/read
// (see docs/API_SECURITY.md § 4 "Out of Wave-2 scope (by design)").
//
// Registration order: these protectTgRoute entries land BEFORE
// `tgRouter.use(santaRouter)` below so the gate registration on tgRouter
// fires before the sub-router's handler dispatch. protectTgRoute uses
// tgRouter.all() with method-narrowing inside.
//
// Critical-flag endpoints (11): irreversible state transitions, mass-DM
// fan-outs, role/admin actions, terminal decisions. Soft-require —
// missing Idempotency-Key logs `api.idem_missing_on_critical_endpoint`
// but never blocks (Mini App will start sending santa-action keys in a
// follow-up PR; this Wave-2 rollout is back-end-only).
//
// 7-day TTL endpoints (2): /santa/admin/season-broadcasts (huge blast
// radius — DM fan-out to every user with telegramChatId) and
// /santa/campaigns/:id/draw (irreversible, expensive, retry-resilient).
// Same shape as billing — long replay window for safety.
//
// New rate-limit categories (2): santa.draw (3/10min — multi-tap guard
// on the most expensive op), santa.admin (10/1min — admin gating).
// Other santa endpoints accept idempotency-only or reuse comment.minute
// + comment.hour for the chat-write endpoint.

// Admin / Season / Global Config (3)
protectTgRoute('POST',  '/santa/season/test-mode',         createRateLimiter('santa.admin'), idem('POST /tg/santa/season/test-mode', { category: 'santa.admin' }));
protectTgRoute('PATCH', '/santa/admin/global-config',      createRateLimiter('santa.admin'), idem('PATCH /tg/santa/admin/global-config', { category: 'santa.admin' }));
protectTgRoute('POST',  '/santa/admin/season-broadcasts',  createRateLimiter('santa.admin'), idem('POST /tg/santa/admin/season-broadcasts', { category: 'santa.admin', critical: true, ttlMinutes: 60 * 24 * 7 }));

// Campaign CRUD + state (5)
protectTgRoute('POST',  '/santa/campaigns',                idem('POST /tg/santa/campaigns', { category: 'santa.campaign' }));
protectTgRoute('PATCH', '/santa/campaigns/:id',            idem('PATCH /tg/santa/campaigns/:id', { category: 'santa.campaign' }));
protectTgRoute('POST',  '/santa/campaigns/:id/open',       idem('POST /tg/santa/campaigns/:id/open', { category: 'santa.campaign' }));
protectTgRoute('POST',  '/santa/campaigns/:id/lock',       idem('POST /tg/santa/campaigns/:id/lock', { category: 'santa.campaign' }));
protectTgRoute('POST',  '/santa/campaigns/:id/cancel',     idem('POST /tg/santa/campaigns/:id/cancel', { category: 'santa.campaign', critical: true }));

// Draw (1) — irreversible, 7d TTL, dedicated rate limit
protectTgRoute('POST',  '/santa/campaigns/:id/draw',
  createRateLimiter('santa.draw'),
  idem('POST /tg/santa/campaigns/:id/draw', { category: 'santa.draw', critical: true, ttlMinutes: 60 * 24 * 7 }));

// Participants (5)
protectTgRoute('POST',   '/santa/campaigns/:id/join',                       idem('POST /tg/santa/campaigns/:id/join', { category: 'santa.participant' }));
protectTgRoute('POST',   '/santa/campaigns/:id/leave',                      idem('POST /tg/santa/campaigns/:id/leave', { category: 'santa.participant' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/participants/:userId',       idem('DELETE /tg/santa/campaigns/:id/participants/:userId', { category: 'santa.participant', critical: true }));
protectTgRoute('PATCH',  '/santa/campaigns/:id/wishlist',                   idem('PATCH /tg/santa/campaigns/:id/wishlist', { category: 'santa.participant' }));
protectTgRoute('PATCH',  '/santa/campaigns/:id/participants/:userId/role',  idem('PATCH /tg/santa/campaigns/:id/participants/:userId/role', { category: 'santa.participant', critical: true }));

// Exclusions (7)
protectTgRoute('POST',   '/santa/campaigns/:id/exclusions',                                idem('POST /tg/santa/campaigns/:id/exclusions', { category: 'santa.exclusion' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/exclusions/:exclusionId',                   idem('DELETE /tg/santa/campaigns/:id/exclusions/:exclusionId', { category: 'santa.exclusion' }));
protectTgRoute('POST',   '/santa/campaigns/:id/exclusions/groups',                         idem('POST /tg/santa/campaigns/:id/exclusions/groups', { category: 'santa.exclusion' }));
protectTgRoute('PATCH',  '/santa/campaigns/:id/exclusions/groups/:gid',                    idem('PATCH /tg/santa/campaigns/:id/exclusions/groups/:gid', { category: 'santa.exclusion' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/exclusions/groups/:gid',                    idem('DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid', { category: 'santa.exclusion' }));
protectTgRoute('POST',   '/santa/campaigns/:id/exclusions/groups/:gid/members',            idem('POST /tg/santa/campaigns/:id/exclusions/groups/:gid/members', { category: 'santa.exclusion' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/exclusions/groups/:gid/members/:uid',       idem('DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid/members/:uid', { category: 'santa.exclusion' }));

// Rounds / Complete / Status / Confirm (4)
protectTgRoute('POST',  '/santa/campaigns/:id/rounds',            idem('POST /tg/santa/campaigns/:id/rounds', { category: 'santa.round', critical: true }));
protectTgRoute('POST',  '/santa/campaigns/:id/complete',          idem('POST /tg/santa/campaigns/:id/complete', { category: 'santa.round', critical: true }));
protectTgRoute('PATCH', '/santa/campaigns/:id/gift-status',       idem('PATCH /tg/santa/campaigns/:id/gift-status', { category: 'santa.round' }));
protectTgRoute('POST',  '/santa/campaigns/:id/confirm-received',  idem('POST /tg/santa/campaigns/:id/confirm-received', { category: 'santa.round', critical: true }));

// Inbound Reserve (2) — Santa-specific item claim, distinct from /reservations
protectTgRoute('POST',   '/santa/campaigns/:id/inbound/reserve',                idem('POST /tg/santa/campaigns/:id/inbound/reserve', { category: 'santa.inbound' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/inbound/reserve/:itemId',        idem('DELETE /tg/santa/campaigns/:id/inbound/reserve/:itemId', { category: 'santa.inbound' }));

// Hints (2) — anonymous giver→receiver request flow with 48h TTL
protectTgRoute('POST',  '/santa/campaigns/:id/hints',                idem('POST /tg/santa/campaigns/:id/hints', { category: 'santa.hint' }));
protectTgRoute('POST',  '/santa/campaigns/:id/inbound/hint/fulfill', idem('POST /tg/santa/campaigns/:id/inbound/hint/fulfill', { category: 'santa.hint' }));

// Chat / Mute (3) — chat-write reuses comment.minute+hour for write rate.
// NOTE: POST /santa/campaigns/:id/chat/read is intentionally excluded —
// fire-and-forget read marker, duplicate-safe by design (UPSERT). Same
// precedent as /me/subscriptions/:id/read.
protectTgRoute('POST',   '/santa/campaigns/:id/chat',
  ...combineLimiters('comment.minute', 'comment.hour'),
  idem('POST /tg/santa/campaigns/:id/chat', { category: 'santa.chat' }));
protectTgRoute('POST',   '/santa/campaigns/:id/mute',                idem('POST /tg/santa/campaigns/:id/mute', { category: 'santa.chat' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/mute',                idem('DELETE /tg/santa/campaigns/:id/mute', { category: 'santa.chat' }));

// Polls (3)
protectTgRoute('POST',  '/santa/campaigns/:id/polls',                  idem('POST /tg/santa/campaigns/:id/polls', { category: 'santa.poll' }));
protectTgRoute('POST',  '/santa/campaigns/:id/polls/:pollId/vote',     idem('POST /tg/santa/campaigns/:id/polls/:pollId/vote', { category: 'santa.poll' }));
protectTgRoute('POST',  '/santa/campaigns/:id/polls/:pollId/close',    idem('POST /tg/santa/campaigns/:id/polls/:pollId/close', { category: 'santa.poll', critical: true }));

// Exit Requests (3)
protectTgRoute('POST',  '/santa/campaigns/:id/exit-request',                                idem('POST /tg/santa/campaigns/:id/exit-request', { category: 'santa.exit-request' }));
protectTgRoute('POST',  '/santa/campaigns/:id/exit-requests/:requestId/approve',            idem('POST /tg/santa/campaigns/:id/exit-requests/:requestId/approve', { category: 'santa.exit-request', critical: true }));
protectTgRoute('POST',  '/santa/campaigns/:id/exit-requests/:requestId/deny',               idem('POST /tg/santa/campaigns/:id/exit-requests/:requestId/deny', { category: 'santa.exit-request', critical: true }));

// ─── /tg/santa/* sub-router (P5p — final domain extraction; 58 handlers,
//     all remaining inline tg routes) ─────────────────────────────────────
// With this mount, `apps/api/src/index.ts` becomes a true composition root
// per docs/REFACTOR_API_INDEX_HANDOFF.md — bootstrap, middleware, router
// registration, schedulers, app.listen, process handlers.
//
// Wave-2 security wiring above (38 protectTgRoute entries + 2 new
// rate-limit categories) closes the pre-existing gap. See
// docs/API_SECURITY.md § 4.
//
// Section 2.A helpers STAY in index.ts (scheduler + startup-hook coupling):
//   - getSeasonStartYear / getSeasonCalendar / getSantaSeasonInfo /
//     sendSeasonalBroadcast (used by maybeRunSeasonalEvents scheduler at
//     line ~6485 + 2 handlers)
//   - generateSantaAliases (used by app.listen alias-backfill hook + 1
//     handler)
// Section 2.B helpers (~26 entries) migrated WITH router as module-scope
// helpers in santa.routes.ts.
const santaRouter = registerSantaRouter({
  getOrCreateTgUser,
  getUserEntitlement,
  trackEvent,
  mapTgItem,
  sendAdminAlert,
  tgActorHash,
  getSeasonStartYear,
  getSeasonCalendar,
  getSantaSeasonInfo,
  sendSeasonalBroadcast,
  generateSantaAliases,
});
tgRouter.use(santaRouter);

// P5c lightweight batch (profiles / telemetry / analytics / maintenance /
// import) is wired further below alongside the P4 internal/admin/public
// routers — placed there because two of its deps (recordMaintenanceExposure,
// importUrlForUser, DRAFTS_ITEM_LIMIT) are `const`/`async function` declared
// later in this file and TDZ would error if we mounted the routers up here.
// Mount order is preserved: meRouter -> refRouter -> P5c batch -> P4 routers,
// matching the user's "after refRouter" intent.


// ─────────────────────────────────────────────────────────────────────────────





// ── Curated Selections ────────────────────────────────────────────────────



















// ═══════════════════════════════════════════════════════
// WISHLIST CATEGORIES
// ═══════════════════════════════════════════════════════























// ─── Import URL: helpers ─────────────────────────────────────────────────────

// DRAFTS_ITEM_LIMIT + getOrCreateDraftsWishlist factory extracted to
// ./services/wishlists.ts in P5s-7. The factory wiring lives near the top
// of this file (right after `trackEvent`) so it is TDZ-safe for all
// downstream consumers (registerOnboardingRouter, importUrlForUser, etc.).

// importUrlForUser extracted to ./services/url-import.ts in P5s-9
// (Strategy A — factory closes over trackEvent + getOrCreateDraftsWishlist;
// the resulting function continues to flow via existing register*Router
// deps unchanged for /tg/import-url, /tg/internal/import-url, and
// /tg/onboarding/try-import). Wiring sits next to the wishlists factory
// so both factory deps are TDZ-safe before any router that consumes them.


// ─── Move item between wishlists ─────────────────────────────────────────────


// ─── Copy single item to another wishlist ────────────────────────────────────


// ─── Item placements (shared wishes) ─────────────────────────────────────────
// A Wish (Item row) can be placed in multiple wishlists via WishlistItemPlacement.
// Title/description/url/price/image/status/reservation/comments are shared across
// all placements; categoryId and position are per-placement. Capacity is counted
// in placements (so a shared wish counts against every wishlist it lives in).




// ─── Billing & Plan endpoints ────────────────────────────────────────────────




// ═══════════════════════════════════════════════════════════════════════════
// Birthday Reminders — settings, mute, deep-link resolve, God Mode
//
// Pro gating policy:
//   Pro-only fields are REJECTED with 402 PRO_REQUIRED if a Free user attempts
//   to set them. They're never silently saved as inactive — that creates ghost
//   settings (user thinks it works, paywall never surfaces).
//
//   Pro-only fields:
//     - audience: 'EXTENDED'
//     - primaryWishlistId (any non-null value)
//     - customMessage (any non-empty value)
//     - advancedWindowsEnabled: true
//
//   Existing Pro values are preserved on downgrade: scheduler treats them as
//   inactive (skipReason: pro_required), but DB rows stay so re-upgrade is
//   seamless. The frontend shows a "Pro required to use" hint.
// ═══════════════════════════════════════════════════════════════════════════



// ─── PRO Showcase endpoints ─────────────────────────────────────────────────









// ─── Gift Notes: Occasions CRUD ──────────────────────────────────────────────


// ════════════════════════════════════════════════════════════════════════════
// Events Calendar v2.1 — reminders, holidays, friends-bdays, inbox, recap
// ════════════════════════════════════════════════════════════════════════════

// computeReminderSchedule + buildReminderEpisodeKey moved to
// ./services/calendar.ts in P5s-8. See comment near getNextOccurrenceDate.



// Secret Santa endpoints
// ─────────────────────────────────────────────────────────────────────────────
//
// Santa season helpers (getSeasonStartYear / getSeasonCalendar /
// getSantaSeasonInfo / SANTA_* dictionaries / santaSeededRng /
// santaHashStr / santaShuffle / generateSantaAliases / sendSeasonalBroadcast
// / maybeRunSeasonalEvents) extracted to ./services/santa-season.ts in
// P5s-4. Strategy A — routes/santa.routes.ts and schedulers/santa.ts
// continue receiving them via existing factory deps, signatures
// unchanged. Index.ts imports + threads through the same call-sites.







// ─── Santa Anonymous Alias System ────────────────────────────────────────────
// (All identifiers extracted to ./services/santa-season.ts in P5s-4.)












// ─── Santa draw algorithm helpers ─────────────────────────────────────────────

/**
 * Build exclusion set as "smallerUserId:largerUserId" strings for O(1) lookup.
 */










// ─── Santa — role-aware assignment serializer ─────────────────────────────────




// ─── Inbound signal helpers (Batch 3) ─────────────────────────────────────────




// ─── Santa draw endpoints ──────────────────────────────────────────────────────











// ─── Batch 5.1: Group exclusion endpoints ─────────────────────────────────────










// ─── Santa — inbound (receiver-centric, post-draw) ────────────────────────────







// ─── Santa Hints (Batch 2.5) ──────────────────────────────────────────────────












// ─── Maintenance: record exposure (must be before maintenance middleware!) ────
// Find-or-create the current active incident, then upsert an exposure row.
async function recordMaintenanceExposure(userId: string, surface: string, locale: string, telegramChatId: string | null) {
  // Find or create the active incident
  let incident = await prisma.maintenanceIncident.findFirst({
    where: { status: { in: ['active', 'recovering'] } },
    orderBy: { startedAt: 'desc' },
  });
  if (!incident) {
    incident = await prisma.maintenanceIncident.create({
      data: { status: 'active', lastMaintenanceSignalAt: new Date() },
    });
  } else {
    // Bump lastMaintenanceSignalAt
    await prisma.maintenanceIncident.update({
      where: { id: incident.id },
      data: { lastMaintenanceSignalAt: new Date(), status: 'active' },
    }).catch(() => {});
  }

  // Upsert exposure: don't duplicate, just update lastSeenAt
  await prisma.maintenanceExposure.upsert({
    where: {
      incidentId_userId_surface: { incidentId: incident.id, userId, surface },
    },
    update: { lastSeenAt: new Date(), locale, ...(telegramChatId ? { telegramChatId } : {}) },
    create: {
      incidentId: incident.id,
      userId,
      surface,
      locale,
      telegramChatId,
    },
  });

  // Increment exposure count (approximate — counts each new surface/user combo)
  await prisma.maintenanceIncident.update({
    where: { id: incident.id },
    data: { exposureCount: { increment: 1 } },
  }).catch(() => {});

  trackEvent('maintenance_seen', userId, { incidentId: incident.id, surface });
  return incident.id;
}


// ─── Maintenance mode middleware ──────────────────────────────────────────────
// When MAINTENANCE_MODE=true, block /tg/* and /public/* with 503 + code=MAINTENANCE.
// /health, /health/deep, /uploads, /internal remain accessible.
// Exception: POST /tg/maintenance-exposure must pass through so we can record who saw the outage.
app.use(['/tg', '/public'], (req: Request, res: Response, next: NextFunction) => {
  if ((process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true') {
    if (req.method === 'POST' && req.path === '/maintenance-exposure') return next();
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'MAINTENANCE' });
  }
  return next();
});

// ─── Mount routers ───────────────────────────────────────────────────────────

// Routers extracted to ./routes/* live as factories so they can close over
// helpers / schemas still defined in this file. Mount prefixes and
// middleware order are unchanged.
//
// ─── P5c lightweight batch — 5 small isolated /tg/* sub-routers ─────────────
// Wired here (rather than next to meRouter/refRouter near the top) because
// two of these routers depend on `const`/`async function` declarations
// (DRAFTS_ITEM_LIMIT, importUrlForUser, recordMaintenanceExposure) defined
// later in this file. Mount order is preserved at runtime: tgRouter receives
// .use() calls in this exact source order so meRouter (line ~1716) and
// refRouter (~1741) handle requests first, then this P5c batch.
const profilesRouter = registerProfilesRouter({
  getOrCreateTgUser,
});
tgRouter.use(profilesRouter);

const telemetryRouter = registerTelemetryRouter();
tgRouter.use(telemetryRouter);

const analyticsRouter = registerAnalyticsRouter({
  getOrCreateTgUser,
});
tgRouter.use(analyticsRouter);

const maintenanceRouter = registerMaintenanceRouter({
  getOrCreateTgUser,
  trackEvent,
  recordMaintenanceExposure,
});
tgRouter.use(maintenanceRouter);

const importRouter = registerImportRouter({
  getOrCreateTgUser,
  getUserEntitlement,
  trackEvent,
  trackAnalyticsEvent,
  importUrlForUser,
  DRAFTS_ITEM_LIMIT,
});
tgRouter.use(importRouter);

const internalRouter = registerInternalRouter({
  getUserEntitlement,
  importUrlForUser,
  DRAFTS_ITEM_LIMIT,
  recordMaintenanceExposure,
  trackEvent,
});

const privateRouter = registerAdminRouter({
  ItemStatusSchema,
  PrioritySchema,
  zUrl,
  reassignPrimaryBeforeWishlistDelete,
  trackAnalyticsEvent,
  notifyReferralInviterRewarded,
});

const publicRouter = registerPublicRouter({
  ACTIVE_STATUSES,
  actorBodySchema,
  getUserEntitlement,
  trackEvent,
  trackAnalyticsEvent,
});

app.use('/public', publicRouter);
app.use('/tg', tgRouter);
app.use('/internal', internalRouter);
app.use(privateRouter);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Multer errors (file too large, wrong type, etc.)
  if (err && typeof err === 'object' && 'code' in err) {
    const multerErr = err as { code: string; message: string };
    if (multerErr.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: t('item_photo_too_large', getRequestLocale(_req)) });
    }
    if (multerErr.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected field name. Use "photo".' });
    }
  }
  if (err instanceof Error && err.message.startsWith('Unsupported file type')) {
    return res.status(415).json({ error: err.message });
  }

  logger.error({ err }, 'unhandled express error');
  if (process.env.GLITCHTIP_DSN) Sentry.captureException(err);
  return res.status(500).json({ error: 'Internal server error' });
});

// Cleanup schedulers (P5r-1): comments TTL, curated selection subscription
// cleanup, archive purge — extracted to ./schedulers/cleanup.ts. Cadence
// (60 * 60 * 1000) and log messages preserved byte-identical.
startCleanupSchedulers({ prisma, logger, deleteUploadFile });

// Billing schedulers (P5r-2): subscription expiry, promo expiry,
// degradation grace + degradation purge — extracted to ./schedulers/
// billing.ts. Cadence (60 * 60 * 1000) and log messages preserved
// byte-identical.
startBillingSchedulers({ prisma, logger, getUserEntitlement, PLANS });

// Referral schedulers (P5r-3): 15-min expired-attribution sweep —
// extracted to ./schedulers/referral.ts. Cadence and log labels
// preserved byte-identical.
startReferralSchedulers({ prisma, logger, trackAnalyticsEvent, sweepExpiredPendingAttributions });

// Referral retention scheduler (daily): emits invitee_retained_d7/d30 for
// LTV/ROI tracking. See apps/api/src/schedulers/referral-retention.ts +
// docs/research/referral-decision.md § 7.3.
startReferralRetentionSchedulers({ prisma, logger, trackAnalyticsEvent });

// ─── Lifecycle / Win-back scheduler (hourly) ─────────────────────────────────
// Scans users, classifies into segments S1–S4, creates LifecycleTouch records,
// and sends Telegram DM messages via bot API. WISHPRO offered only on eligible touches.

const BOT_TOKEN_FOR_DM = process.env.BOT_TOKEN ?? '';
const MINI_APP_URL_FOR_DM = process.env.MINI_APP_URL ?? 'https://wishlistik.ru/miniapp';
const LIFECYCLE_PROMO_CODE = 'WISHPRO';

// ─── /tg/promo/* sub-router (P5f split) ──────────────────────────────────────
// Wired here (rather than alongside meRouter/refRouter/supportRouter near the
// top, or alongside the P5c batch / P4 routers around line ~11600) because
// the factory call closes over LIFECYCLE_PROMO_CODE — declared on the line
// just above. Earlier wiring would TDZ-error on this `const`. Same TDZ-
// relocation precedent as P5c (DRAFTS_ITEM_LIMIT etc.) and P5e
// (BIRTHDAY_REMINDERS_ENABLED). Mount order at runtime is preserved:
//   protectTgRoute() chain (no /promo entries)
//     -> meRouter -> refRouter -> supportRouter -> P5c batch -> P4 routers
//     -> app.use('/tg', tgRouter)            ← already mounted at line ~11678
//     -> tgRouter.use(promoRouter)            ← this block (post-mount,
//                                                valid: Router stack remains
//                                                mutable until app.listen())
//     -> tgRouter.use(birthdayRemindersRouter) (~13238, P5e)
//     -> app.listen(PORT)
// LIFECYCLE_PROMO_CODE stays in index.ts; the lifecycle scheduler below
// continues to use it directly.
const promoRouter = registerPromoRouter({
  getOrCreateTgUser,
  getUserEntitlement,
  trackEvent,
  LIFECYCLE_PROMO_CODE,
});
tgRouter.use(promoRouter);

// Lifecycle DM service (P5r-5) — `sendLifecycleDM` extracted to
// services/lifecycle.ts because the PRO-renewal scheduler also uses it.
// The factory closes over BOT_TOKEN_FOR_DM + logger so neither needs to
// be threaded through every call site downstream.
const sendLifecycleDM = createSendLifecycleDM({ botToken: BOT_TOKEN_FOR_DM, logger });

// Lifecycle / Win-back scheduler (P5r-5) — hourly cron extracted to
// schedulers/lifecycle.ts. All LIFECYCLE_* internal cooldown constants,
// LIFECYCLE_MESSAGES / SEGMENT_CADENCE / MAX_WAVES tables, classifier
// helpers (classifyLifecycleSegment, checkLifecycleCaps,
// shouldStopLifecycle), and the dead-air counter live in the scheduler
// module. Cadence (60 * 60 * 1000) and log labels preserved
// byte-identical.
startLifecycleScheduler({
  prisma, logger, sendLifecycleDM,
  getUserEntitlement, trackEvent,
  MINI_APP_URL_FOR_DM, LIFECYCLE_PROMO_CODE, BOT_TOKEN_FOR_DM,
});

// PRO renewal reminder scheduler (P5r-5) — hourly cron extracted to
// schedulers/pro-renewal.ts. Registered AFTER startLifecycleScheduler so
// the original setInterval ordering (lifecycle first, pro-renewal
// second) is preserved. Uses sendLifecycleDM from services/lifecycle.ts.
startProRenewalReminderScheduler({
  prisma, logger, sendLifecycleDM, trackEvent,
  PRO_PLAN_CODE, MINI_APP_URL_FOR_DM,
});

// Santa schedulers (P5r-3): hint expiry + deadline missed + deadline
// warning + seasonal events wrapper — extracted to ./schedulers/
// santa.ts. Section 2.A helpers (getSeasonStartYear / getSeasonCalendar
// / getSantaSeasonInfo / sendSeasonalBroadcast / maybeRunSeasonalEvents
// / generateSantaAliases / SANTA_*) STAY in index.ts. Cadence and log
// labels preserved byte-identical.
startSantaSchedulers({ prisma, logger, maybeRunSeasonalEvents });

// Reservation-reminder scheduler (P5r-4, position 1 of original order)
// — extracted to ./schedulers/reservations.ts. 15-min cadence; log
// labels + behavior preserved byte-identical. Smart-res schedulers
// register AFTER startEventSchedulers below to keep original sequencing.
startReservationReminderScheduler({ prisma, logger, sendTgBotMessage });

// Events Calendar scheduler (P5r-4): gift-occasion reminders (5-min
// cadence) — extracted to ./schedulers/events.ts. Helpers
// `getNextOccurrenceDate` / `computeReminderSchedule` /
// `buildReminderEpisodeKey` STAY in index.ts (also consumed by
// gift-notes.routes.ts via deps) and are passed through here.
startEventSchedulers({
  prisma, logger,
  sendTgBotMessage,
  BOT_TOKEN_FOR_DM,
});

// ─── Santa seasonal broadcasts ───────────────────────────────────────────────
// sendSeasonalBroadcast + maybeRunSeasonalEvents extracted to
// ./services/santa-season.ts in P5s-4. (Santa seasonal events scheduler
// moved to ./schedulers/santa.ts in P5r-3.)

// Smart-res schedulers (P5r-4, positions 3+4 of original order):
// auto-release (5-min) + reminder (15-min) — extracted to ./schedulers/
// reservations.ts. Registered AFTER startEventSchedulers above so the
// pre-extraction ordering (reservation-reminder → events-calendar →
// smart-res-auto-release → smart-res-reminder) is preserved exactly.
startSmartReservationSchedulers({
  prisma, logger,
  sendTgNotification,
  sendTgBotMessage,
  getSmartResLeadHours,
  SYSTEM_ACTOR_HASH,
});

// Birthday reminders kill-switch (P5r-6) — env-derived const STAYS in
// index.ts because both birthdayRemindersRouter (registered just below
// via the P5e factory) and the scheduler factory
// (`startBirthdayRemindersScheduler`, called near the bottom of this
// file) consume it via deps. All BIRTHDAY_* operational constants,
// kind/reason types, and the BIRTHDAY_TZ_OFFSET_HOURS constant moved
// to ./schedulers/birthday-reminders.ts (operational) and
// ./services/birthday-reminders.ts (timezone offset + 6 pure helpers).
const BIRTHDAY_REMINDERS_ENABLED = process.env.BIRTHDAY_REMINDERS_ENABLED !== 'false';

// ─── /tg/birthday-reminders/* + /tg/admin/birthday-reminders/metrics
//     sub-router (P5e split) ───────────────────────────────────────────────
// Wired here (rather than at the top alongside meRouter/refRouter/supportRouter)
// because the factory call closes over BIRTHDAY_REMINDERS_ENABLED — a `const`
// declared a few lines above this block. Earlier wiring would TDZ-error.
// Function helpers (daysUntilNextBirthday, pickBirthdayDisplayName) are
// hoisted, but the const is not, so we keep all five deps resolved here for
// a single, easy-to-read block. Mount order at runtime:
//   protectTgRoute() chain (incl. /birthday-reminders/mute idempotency)
//     -> meRouter -> refRouter -> supportRouter -> P5c batch
//     -> app.use('/tg', tgRouter)            ← already mounted at line ~12200
//     -> tgRouter.use(birthdayRemindersRouter)   ← this block (post-mount,
//                                                  valid: Router stack
//                                                  remains mutable until
//                                                  app.listen())
//     -> app.listen(PORT)
// Helpers stay in index.ts; the scheduler/job code below uses them directly.
const birthdayRemindersRouter = registerBirthdayRemindersRouter({
  getOrCreateTgUser,
  trackEvent,
  BIRTHDAY_REMINDERS_ENABLED,
  daysUntilNextBirthday,
  pickBirthdayDisplayName,
});
tgRouter.use(birthdayRemindersRouter);

// Birthday reminders scheduler (P5r-6) — hourly cron + 30s startup
// kick extracted to ./schedulers/birthday-reminders.ts. All BIRTHDAY_*
// operational constants, kind/reason/candidate types, classifier
// helpers (pickBirthdayPrimaryWishlist, findCommenterRecipients,
// findBirthdayFriendRecipients, recipientHitDailyCap), message
// rendering (birthdayDayWord, buildBirthdayBotMessage), DM helper
// (sendBirthdayBotPost), and delivery orchestration
// (processBirthdayReminders, maybeCreateOwnerDelivery,
// maybeCreateFriendDeliveries, sendBirthdayDelivery, persistOwnerSkip,
// markDeliverySkipped) live in the scheduler module. Pure helpers
// (timezone math, occurrence key, display name) live in
// ./services/birthday-reminders.ts and are also imported by
// birthdayRemindersRouter (P5e contract preserved). Cadence
// (60 * 60 * 1000), startup +30s, MSK send-window (9–22), occurrence
// key dedupe, audience tiers, daily cap, ServiceHeartbeat metadata,
// AnalyticsEvent names, and Telegram message templates preserved
// byte-identical.
startBirthdayRemindersScheduler({
  prisma, logger,
  getEffectiveEntitlements, tgActorHash, trackEvent,
  BIRTHDAY_REMINDERS_ENABLED,
});

// Research survey send scheduler.
// Disabled by default. Gated by RESEARCH_SURVEY_SEND_ENABLED + the
// presence of RESEARCH_SURVEY_ACTIVE_SLUG; both are evaluated on every
// tick so ops can toggle without restart. See
// apps/api/src/schedulers/research-survey-send.ts.
startResearchSurveySendScheduler({ logger });

// Daily product-loop rollup. Hourly tick re-aggregates AnalyticsEvent
// for yesterday + today (UTC) into UserDailyActivity. Idempotent upsert
// on (userId, date); see services/daily-activity.service.ts and
// docs/research/core-loop-dashboard.md. Survives the 90-day
// AnalyticsEvent TTL so D60/D90 cohorts stay queryable.
startDailyActivityRollupScheduler({ prisma, logger });

// ─── Batch 4.1: Santa Campaign Chat ──────────────────────────────────────────








// ─── Batch 4.2: Santa Campaign Polls ─────────────────────────────────────────







// ─── Batch 5.3: Roles + Organizer Controls + Exit Request Flow ────────────────







app.listen(PORT, () => {
  logger.info({ port: PORT }, 'API server listening');
  // Send startup alert to admins (best-effort)
  void sendAdminAlert(`🟢 <b>API started</b>\nPort: ${PORT}\nEnv: ${process.env.NODE_ENV ?? 'development'}`);

  // Pre-load geoip-lite (~100 MB binary DB → ~100 ms event-loop block) at
  // boot so the first authenticated request doesn't pay the cold-start
  // cost. Skipped when the kill switch is off — no point loading the DB
  // we won't query. Logs whether the load succeeded (false = corrupt /
  // missing data file → request path silently degrades to no-IP-geo).
  if (process.env.LOCALE_DETECTION_ENABLED !== 'false') {
    const ok = prewarmGeoip();
    logger.info({ geoipLoaded: ok }, 'geoip-lite prewarm');
  }

  // Hourly cleanup of expired IdempotencyKey rows. No-op in tests (unless
  // CLEANUP_JOB_IN_TEST=true) and skipped when SECURITY_CLEANUP_JOB_ENABLED=false.
  startIdempotencyCleanupJob();

  // Santa startup jobs (P5r-3): SantaGlobalConfig singleton upsert +
  // alias backfill loop — extracted to ./schedulers/santa.ts. Both are
  // fire-and-forget; behavior preserved byte-identical.
  runSantaStartupJobs({ prisma, logger, generateSantaAliases });
});

// ─── Uncaught exception / rejection alerts ────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  logger.fatal({ err }, 'api uncaughtException');
  if (process.env.GLITCHTIP_DSN) Sentry.captureException(err);
  void sendAdminAlert(`🔴 <b>API uncaughtException</b>\n${String(err)}`).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
  logger.error({ reason }, 'api unhandledRejection');
  if (process.env.GLITCHTIP_DSN && reason instanceof Error) Sentry.captureException(reason);
  void sendAdminAlert(`🔴 <b>API unhandledRejection</b>\n${String(reason)}`);
});
