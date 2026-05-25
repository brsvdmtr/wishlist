// Telegram-auth router for /tg/items/:id/hint (POST) and /tg/hints/:hintId
// (GET) — 2 handlers covering the FREE-quota "hint friends" flow.
//
// Mounted via `tgRouter.use(hintsRouter)` in apps/api/src/index.ts alongside
// the other early P5 sub-routers. Both endpoints lack a protectTgRoute(...)
// registration in the chain at lines 1547+ — POST /items/:id/hint relies on
// its internal anti-spam (3 hints / item / 30 days + 5 hints / sender / day,
// plus the 30-min idempotent fast-path) instead. Pre-existing — see
// docstring §10 of the audit.
//
// Same factory pattern as P5a–P5j. Handler bodies are byte-identical to
// their previous in-place definitions in index.ts (lines 4686–4860,
// 4916–4947) — only `tgRouter.` -> `hintsRouter.` and indent +2.
//
// Helper migrated WITH the router (sole consumer = POST /items/:id/hint):
//   - sendHintPickerKeyboard (formerly index.ts:4877). Body byte-identical;
//     uses `sendTgBotMessage`, `t`, `logger` — all module-level imports
//     here, no factory closure required.
//
// Helpers that STAY in index.ts (passed via deps):
//   - getOrCreateTgUser     — universal.
//   - getUserEntitlement    — also at me.routes.ts and 7+ other handlers.
//   - trackEvent            — universal.
//
// `cancelItemHints` is intentionally NOT consumed by these handlers — it
// stays in index.ts for use by core items routes (DELETE /items/:id, POST
// /items/:id/complete) and by reservations.routes.ts (POST /items/:id/
// reserve, where it is passed via deps). Touching its location would force
// re-threading two domains, so it stays put.

import { Router } from 'express';
import { prisma } from '@wishlist/db';
import { t, type Locale, HINT_LOOKUP_WINDOW_MS } from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { getRequestLocale } from '../lib/locale';
import { sendTgBotMessage } from '../telegram/botApi';
import logger from '../logger';
import { getHintAllowance } from '../services/hint-credits';
import { trackProductEvent } from '../services/analytics';
import { makeAddonRequired, sendPaywall } from '../services/paywall';

// Shape of the Telegram initData user object — duplicated from index.ts to
// avoid coupling routes/* to a non-exported local type. Structurally
// equivalent to `TelegramUser` at index.ts:333.
type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that handlers in this file read.
type HintsUser = {
  id: string;
  godMode: boolean;
  telegramChatId: string | null;
};

// Structural shape of getUserEntitlement return that POST /items/:id/hint
// reads (`.isPro` for the quota gate, `.plan.code` for the upsell envelope).
type HintsEntitlement = {
  plan: { code: string };
  isPro: boolean;
};

export type HintsRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<HintsUser>;
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<HintsEntitlement>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
};

/**
 * Best-effort fire-and-forget delivery of the contact-picker keyboard to
 * the sender's bot chat. Used by both the create-hint and idempotent
 * re-attempt paths.
 *
 *   - Single attempt (no internal retry) so the bounded race is honest:
 *     either we hear back from TG in ~3 s or we let the request live on
 *     in the background. Mini App is unblocked at the race timeout.
 *   - Underlying fetch has a long fallback timeout (12 s) so a slow but
 *     responsive TG still delivers — Mini App has already navigated to
 *     bot chat by then, and the user sees the keyboard appear.
 *   - Outcome is logged via .then / .catch attached to the original
 *     promise so the eventual ok/fail lands in bot.log even after the
 *     race resolves.
 */
function sendHintPickerKeyboard(
  senderChatId: string,
  itemTitle: string,
  hintId: string,
  locale: Locale,
): void {
  logger.info({ senderChatId, hintId }, 'hint_prompt_send_started');
  const sendPromise = sendTgBotMessage(
    senderChatId,
    t('api_hint_picker_msg', locale, { title: itemTitle }),
    {
      keyboard: [[{
        text: t('bot_select_recipients', locale),
        request_users: { request_id: Number(hintId.slice(-6).replace(/\D/g, '') || '1'), user_is_bot: false, max_quantity: 10 },
      }]],
      resize_keyboard: true,
      one_time_keyboard: true,
      is_persistent: true,
    },
    { timeoutMs: 12000, maxAttempts: 1 },
  );
  // Attach handlers BEFORE racing so the outcome is captured even after
  // the race timer wins. .catch on the original promise keeps the pending
  // task alive until completion (Node won't GC it).
  sendPromise.then((sent) => {
    if (sent) {
      logger.info({ senderChatId, hintId }, 'hint_prompt_send_succeeded');
    } else {
      logger.warn({ senderChatId, hintId }, 'hint_prompt_send_failed');
    }
  }).catch((err) => {
    logger.error({ err, senderChatId, hintId }, 'hint_prompt_send_threw');
  });
  // (No await — caller returns 200 immediately, race happens in caller
  // if needed. For now, intentionally fire-and-forget: the previous
  // synchronous-await flow is exactly what made first-click hang 12 s.)
}

export function registerHintsRouter(deps: HintsRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getUserEntitlement,
    trackEvent,
  } = deps;

  const hintsRouter = Router();

  // POST /tg/items/:id/hint — create a hint wave (FREE-quota gated, owner-only)
  //
  // Design (rewritten 2026-05-02 after user-reported "first click hangs 10 s,
  // second click works"):
  //
  //   1. The endpoint must respond fast (<3 s) regardless of Telegram health.
  //      The previous implementation awaited sendTgBotMessage's full 6 s × 2
  //      retry budget on the synchronous request path, then returned 502 +
  //      rolled back the hint to CANCELLED on TG unreachable. From the user's
  //      seat that meant a 12 s spinner with no visible feedback before they
  //      could retry.
  //
  //   2. The endpoint must be idempotent on rapid re-tap. If the user clicks
  //      "hint friends" again before the first attempt has run all the way
  //      through (delivered keyboard → user picked friends → bot processed),
  //      we must return the existing active SENT hint instead of minting a
  //      new one — otherwise we burn a slot in the per-item / per-day anti-
  //      spam counter for what is logically the same operation.
  //
  //   3. Keyboard delivery is best-effort. We fire sendTgBotMessage and race
  //      it against a 3 s budget; whichever resolves first decides the API
  //      response. The fetch keeps running in the background past 3 s — TG
  //      may still deliver after the API has already returned 200, in which
  //      case the user sees the keyboard appear in their bot chat shortly
  //      after navigating there. Outcome is logged via .then/.catch so the
  //      narrative survives in bot.log.
  //
  //   4. We DO NOT roll back the hint to CANCELLED on send failure. If the
  //      first send didn't land, the user can re-tap from the Mini App; the
  //      idempotent path returns the same hint and re-triggers a delivery
  //      attempt. Eventually one attempt succeeds and the user sees the
  //      picker.
  hintsRouter.post(
    '/items/:id/hint',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const locale = getRequestLocale(req);

      // 1. Load item + verify ownership
      const item = await prisma.item.findUnique({
        where: { id },
        select: { id: true, title: true, status: true, wishlist: { select: { ownerId: true, slug: true } } },
      });
      if (!item) return res.status(404).json({ error: 'Item not found' });
      if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

      // 1b. Check owner's hintsEnabled setting
      const ownerProfile = await prisma.userProfile.findUnique({
        where: { userId: user.id },
        select: { hintsEnabled: true },
      });
      if (ownerProfile?.hintsEnabled === false) {
        return res.status(403).json({ error: 'hints_disabled' });
      }

      // 2. Item must be AVAILABLE (not reserved/completed/deleted)
      if (item.status !== 'AVAILABLE') {
        return res.status(400).json({ error: 'item_not_available', message: t('api_hint_item_not_available', locale) });
      }

      // 3. Quota gate — runs LAST of the gates, so the monetization upsell only
      //    fires for a user who would otherwise succeed (owns an available
      //    item, hints enabled). PRO is unlimited; FREE gets
      //    FREE_HINT_QUOTA_PER_MONTH delivered hints/month + paid hints_pack_*
      //    credits. The allowance is only *checked* here — the actual charge
      //    happens on delivery, when the bot reports the hint DELIVERED via
      //    POST /internal/hints/credit (see services/hint-credits.ts). A hint
      //    wave that is never delivered (keyboard lost, picker abandoned, hint
      //    expired) costs nothing.
      const ent = await getUserEntitlement(user.id, user.godMode);
      const allowance = await getHintAllowance(user.id, ent.isPro);
      if (!allowance.allowed) {
        // Two events fire on the quota wall, by design: the legacy
        // feature_gate_hit_hints feeds the existing god-mode dashboard (kept
        // for parity with import.routes.ts's identical 402 path), and the
        // typed hint.pack_suggested feeds the new PRODUCT_EVENTS taxonomy.
        trackEvent('feature_gate_hit_hints', user.id);
        trackProductEvent({
          event: 'hint.pack_suggested',
          userId: user.id,
          props: { freeLimit: allowance.freeLimit, paidCredits: allowance.paidCredits },
        });
        return sendPaywall(res, 402, makeAddonRequired('hints', {
          skuCode: 'hints_pack_5',
          planCode: ent.plan.code,
          freeLimit: allowance.freeLimit,
          freeUsed: allowance.freeUsed,
          paidCredits: allowance.paidCredits,
          packs: ['hints_pack_5', 'hints_pack_10'],
        }));
      }

      const senderChatId = user.telegramChatId;

      // ─── Stale-SENT cleanup + idempotent fast-path ───────────────────────
      // The bot's `users_shared` handler looks for the sender's most-recent
      // SENT hint within a 30-min window (apps/bot/src/index.ts) — anything
      // older shows "Активный намёк не найден". Without aligning the API
      // window, an abandoned hint from hours ago becomes the idempotent
      // match and the bot rejects friend-selection from the freshly-issued
      // keyboard. Concrete repro: 2026-05-02 07:36 hint created and abandoned
      // → 2026-05-02 17:36 user re-taps → API returns the 10-hour-old hint
      // → bot replies "Активный намёк не найден" because it's outside the
      // 30-min window.
      //
      // Fix: any SENT hint older than the bot's window is dead (the keyboard
      // for it has long since been replaced). Mark them CANCELLED so they
      // also stop counting against the per-item / per-day anti-spam quotas.
      // Then the idempotent match runs over only the fresh window, and a
      // re-tap after 30 min creates a brand-new hint that the bot can find.
      const now = new Date();
      const lookupWindowStart = new Date(now.getTime() - HINT_LOOKUP_WINDOW_MS);

      const stale = await prisma.hint.updateMany({
        where: {
          senderUserId: user.id,
          itemId: id,
          status: 'SENT',
          createdAt: { lt: lookupWindowStart },
        },
        data: { status: 'CANCELLED' },
      });
      if (stale.count > 0) {
        logger.info(
          { userId: user.id, itemId: id, cancelledCount: stale.count },
          'hint_create_cancelled_stale_sent',
        );
      }

      const existing = await prisma.hint.findFirst({
        where: {
          senderUserId: user.id,
          itemId: id,
          status: 'SENT',
          createdAt: { gte: lookupWindowStart },
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
      });
      if (existing) {
        logger.info(
          { userId: user.id, itemId: id, hintId: existing.id, ageMs: now.getTime() - existing.createdAt.getTime() },
          'hint_create_idempotent_hit',
        );
        // Re-attempt keyboard delivery (best-effort). User probably tapped
        // again because the first send didn't reach their bot chat. The
        // bounded-race pattern below means we still return ≤ 3 s.
        if (senderChatId) {
          sendHintPickerKeyboard(senderChatId, item.title, existing.id, locale);
        }
        return res.json({ hintId: existing.id, status: 'pending_selection', existing: true });
      }

      // 4. Anti-spam: max 3 hint waves per item per 30 days
      if (!user.godMode) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const itemHintCount = await prisma.hint.count({
          where: { itemId: id, senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: thirtyDaysAgo } },
        });
        if (itemHintCount >= 3) {
          const oldestItemHint = await prisma.hint.findFirst({
            where: { itemId: id, senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: thirtyDaysAgo } },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          });
          const retryAfterSeconds = oldestItemHint
            ? Math.max(0, Math.ceil((oldestItemHint.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000 - Date.now()) / 1000))
            : 0;
          return res.status(429).json({
            error: 'item_hint_limit',
            message: t('api_hint_item_limit', locale),
            retryAfterSeconds,
          });
        }

        // 5. Anti-spam: max 5 hints per sender per day
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const dailyHintCount = await prisma.hint.count({
          where: { senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: oneDayAgo } },
        });
        if (dailyHintCount >= 5) {
          const oldestDailyHint = await prisma.hint.findFirst({
            where: { senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: oneDayAgo } },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          });
          const retryAfterSeconds = oldestDailyHint
            ? Math.max(0, Math.ceil((oldestDailyHint.createdAt.getTime() + 24 * 60 * 60 * 1000 - Date.now()) / 1000))
            : 0;
          return res.status(429).json({
            error: 'daily_hint_limit',
            message: t('api_hint_daily_limit', locale),
            retryAfterSeconds,
          });
        }
      }

      // 6. Create hint record
      const hint = await prisma.hint.create({
        data: {
          itemId: id,
          senderUserId: user.id,
          status: 'SENT',
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      logger.info({ userId: user.id, itemId: id, hintId: hint.id }, 'hint_create_completed');
      trackEvent('hint_created', user.id, { itemId: id, hintId: hint.id });

      // 7. Send contact picker (best-effort, bounded race). Keyboard arrives
      //    in the user's bot chat from the API process. We don't wait for the
      //    full TG round-trip — return within 3 s regardless. If TG is slow
      //    but eventually responds, the keyboard still arrives by the time
      //    the user has navigated to bot chat.
      if (senderChatId) {
        sendHintPickerKeyboard(senderChatId, item.title, hint.id, locale);
      } else {
        // No telegramChatId on user means they have not /start-ed the bot
        // even once. There is no chat to send a picker into. Tell the
        // client; the Mini App can show a "open the bot first" toast.
        logger.warn({ userId: user.id, hintId: hint.id }, 'hint_prompt_send_skipped_no_chat_id');
        return res.json({ hintId: hint.id, status: 'pending_selection', noBotChat: true });
      }

      return res.json({ hintId: hint.id, status: 'pending_selection' });
    }),
  );

  // GET /tg/hints/:hintId — poll hint delivery status (for mini app)
  hintsRouter.get(
    '/hints/:hintId',
    asyncHandler(async (req, res) => {
      const hintId = req.params.hintId ?? '';
      if (!hintId) return res.status(400).json({ error: 'Missing hint id' });

      const user = await getOrCreateTgUser(req.tgUser!);

      const hint = await prisma.hint.findFirst({
        where: { id: hintId, senderUserId: user.id },
        select: {
          id: true,
          status: true,
          sentCount: true,
          pendingCount: true,
          deliveredAt: true,
          item: { select: { id: true, title: true, status: true } },
        },
      });

      if (!hint) return res.status(404).json({ error: 'Hint not found' });

      return res.json({
        hintId: hint.id,
        status: hint.status,
        sentCount: hint.sentCount,
        pendingCount: hint.pendingCount,
        deliveredAt: hint.deliveredAt,
        itemTitle: hint.item.title,
      });
    }),
  );

  return hintsRouter;
}
