// Telegram-auth router for /tg/support/* endpoints (2 handlers).
// Mounted via `tgRouter.use(supportRouter)` in apps/api/src/index.ts
// immediately after `tgRouter.use(refRouter)` — no TDZ constraint, the
// only closure dep (getOrCreateTgUser) is declared earlier in index.ts.
//
// Same factory pattern as P4/P5a/P5b/P5c. Handler bodies byte-identical
// to their previous in-place definitions (only `tgRouter.` ->
// `supportRouter.` + indent +2). Direct Telegram fetch() calls in the
// POST handler (best-effort with try/catch) are preserved verbatim —
// refactoring them through telegram/botApi.ts (sendTgBotMessage) is
// deliberately out of scope for this PR; the message_id capture flow
// that downstream bot reply-routing depends on stays intact.
//
// Cross-service contract: the `prisma.supportMessage.create()` blocks
// inside the two fetch() try-blocks save `telegramSupportMsgId` /
// `telegramUserMsgId` rows that apps/bot/src/index.ts uses to route
// staff replies back to the user. We do not touch bot code; this move
// is invisible to it.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@wishlist/db';

import logger from '../logger';
import { asyncHandler } from '../lib/asyncHandler';
import { getOrCreateProfile } from '../profile.js';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that /support handlers read.
type SupportUser = {
  id: string;
  godMode: boolean;
  telegramId: string | null;
  telegramChatId: string | null;
};

export type SupportRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<SupportUser>;
};

export function registerSupportRouter(deps: SupportRouterDeps): Router {
  const { getOrCreateTgUser } = deps;

  const supportRouter = Router();

  // Also support god-mode lookup via TG auth (for Mini App investigation UI)
  supportRouter.get(
    '/support/lookup/:ticketCode',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
      if (!user.telegramId || !godModeAllowedIds.includes(user.telegramId) || !user.godMode) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { ticketCode } = req.params;
      const ticket = await prisma.supportTicket.findUnique({
        where: { ticketCode: ticketCode!.toUpperCase() },
        include: {
          messages: { orderBy: { createdAt: 'asc' }, take: 50, select: {
            id: true, authorRole: true, kind: true, text: true, caption: true, createdAt: true,
          }},
          user: { select: {
            id: true, telegramId: true, firstName: true,
            profile: { select: { displayName: true, username: true } },
          }},
        },
      });
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  
      const userId = ticket.user.id;
      const [wishlistsCount, subscription] = await Promise.all([
        prisma.wishlist.count({ where: { ownerId: userId, type: 'REGULAR' } }),
        // B1 fix: pick the actually-active subscription. Prior `not: 'CANCELLED'`
        // also matched EXPIRED legacy rows (e.g. GIFT_CALENDAR), which then beat
        // a real ACTIVE PRO row by createdAt DESC and surfaced the wrong plan
        // label in the support header. Status='ACTIVE' + currentPeriodEnd>now
        // matches "still entitled right now"; orderBy currentPeriodEnd DESC
        // picks the longest-running active sub if there are multiple.
        prisma.subscription.findFirst({
          where: { userId, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
          orderBy: { currentPeriodEnd: 'desc' },
          select: { planCode: true },
        }),
      ]);
  
      return res.json({
        ticketCode: ticket.ticketCode, status: ticket.status,
        createdAt: ticket.createdAt, closedAt: ticket.closedAt,
        user: { telegramId: ticket.user.telegramId, name: ticket.user.profile?.displayName || ticket.user.firstName || 'Unknown', username: ticket.user.profile?.username },
        plan: subscription?.planCode ?? 'FREE',
        wishlists: wishlistsCount,
        messagesCount: ticket.messages.length,
        lastMessages: ticket.messages.slice(-5),
      });
    }),
  );
  
  // ── Support: create ticket from Mini App ──────────────────────────────────────
  
  supportRouter.post(
    '/support/tickets',
    asyncHandler(async (req, res) => {
      const SUPPORT_CHAT_ID = (process.env.SUPPORT_CHAT_ID ?? '').trim();
      const BOT_TOKEN = (process.env.BOT_TOKEN ?? '').trim();
  
      const user = await getOrCreateTgUser(req.tgUser!);
      const profile = await getOrCreateProfile(user.id);
  
      // Check for existing open ticket — don't create duplicates
      const existingOpen = await prisma.supportTicket.findFirst({
        where: { userId: user.id, status: { not: 'CLOSED' } },
        select: { ticketCode: true, status: true },
      });
      if (existingOpen) {
        return res.status(409).json({
          error: 'active_ticket_exists',
          ticketCode: existingOpen.ticketCode,
          supportId: profile.supportId ?? null,
        });
      }
  
      // Parse optional client context
      const parsed = z.object({
        source: z.string().max(50).optional(),
        screen: z.string().max(50).optional(),
        locale: z.string().max(10).optional(),
        platform: z.string().max(50).optional(),
      }).safeParse(req.body);
      const ctx = parsed.success ? parsed.data : {};
  
      // Generate ticket code (same logic as bot)
      const last = await prisma.supportTicket.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { ticketCode: true },
      });
      let nextNum = 1;
      if (last) {
        const m = last.ticketCode.match(/SUP-(\d+)/);
        if (m) nextNum = parseInt(m[1]!, 10) + 1;
      }
      const ticketCode = `SUP-${String(nextNum).padStart(4, '0')}`;
  
      // Snapshot plan — B1 fix: see /support/lookup handler above for rationale.
      // Pick the actually-active sub (status=ACTIVE + currentPeriodEnd in future),
      // not just "anything except cancelled" (that filter let EXPIRED rows win).
      const sub = await prisma.subscription.findFirst({
        where: { userId: user.id, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
        orderBy: { currentPeriodEnd: 'desc' },
        select: { planCode: true },
      });
      const plan = sub?.planCode ?? 'FREE';
  
      // Create ticket
      const ticket = await prisma.supportTicket.create({
        data: {
          ticketCode,
          userId: user.id,
          status: 'WAITING_USER',
          openedVia: 'miniapp',
          supportChatId: SUPPORT_CHAT_ID || null,
        },
      });
  
      // ── Send to support chat ────────────────────────────────────────────────
      if (SUPPORT_CHAT_ID && BOT_TOKEN) {
        const tgU = req.tgUser!;
        const userTag = tgU.username ? `@${tgU.username}` : `tg:${tgU.id}`;
        // B2 fix: when source === screen the header repeated the same value on
        // two lines (e.g. "Source: settings / Screen: settings"). Show Screen
        // only when it actually adds information.
        const sourceVal = ctx.source || 'settings';
        const screenVal = ctx.screen;
        const header = [
          `🆕 <b>[${ticketCode}] Новое обращение (Mini App)</b>`,
          ``,
          `👤 ${tgU.first_name || 'User'} ${userTag}`,
          `🆔 Support ID: <code>${profile.supportId || '—'}</code>`,
          `📊 Plan: ${plan}`,
          `📍 Source: ${sourceVal}`,
          ...(screenVal && screenVal !== sourceVal ? [`🖥 Screen: ${screenVal}`] : []),
          `🌐 Locale: ${ctx.locale || '—'}`,
          `📱 Platform: ${ctx.platform || '—'}`,
          ``,
          `⏳ Ожидаем описание проблемы от пользователя...`,
        ].join('\n');
  
        try {
          const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: SUPPORT_CHAT_ID, text: header, parse_mode: 'HTML' }),
          });
          const data = await resp.json() as { ok: boolean; result?: { message_id: number } };
          if (data.ok && data.result?.message_id) {
            // Save as SupportMessage so bot can route staff replies via telegramSupportMsgId
            await prisma.supportMessage.create({
              data: {
                ticketId: ticket.id,
                authorRole: 'SYSTEM',
                kind: 'TEXT',
                text: header,
                telegramSupportChatId: SUPPORT_CHAT_ID,
                telegramSupportMsgId: data.result.message_id,
              },
            }).catch(() => {});
          }
        } catch (err) {
          logger.error({ err }, 'support: failed to send to support chat');
        }
      }
  
      // ── Send DM to user (bot chat) ──────────────────────────────────────────
      if (user.telegramChatId && BOT_TOKEN) {
        const isRu = (ctx.locale || 'ru').startsWith('ru');
        const dmText = isRu
          ? [
              `✅ <b>Обращение создано: ${ticketCode}</b>`,
              ``,
              `Опиши, пожалуйста, что пошло не так.`,
              `Можно прислать текст, скриншоты и видео.`,
              ``,
              `Если можешь, напиши:`,
              `• что именно ты делал`,
              `• что ожидал увидеть`,
              `• что произошло фактически`,
              `• как это воспроизводится`,
            ].join('\n')
          : [
              `✅ <b>Ticket created: ${ticketCode}</b>`,
              ``,
              `Please describe what went wrong.`,
              `You can send text, screenshots, and video.`,
              ``,
              `If possible, include:`,
              `• what you were doing`,
              `• what you expected`,
              `• what actually happened`,
              `• how to reproduce it`,
            ].join('\n');
  
        try {
          const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: user.telegramChatId,
              text: dmText,
              parse_mode: 'HTML',
              reply_markup: { force_reply: true, selective: true },
            }),
          });
          const data = await resp.json() as { ok: boolean; result?: { message_id: number } };
          if (data.ok && data.result?.message_id) {
            // Save as SupportMessage so bot can route user reply via telegramUserMsgId
            await prisma.supportMessage.create({
              data: {
                ticketId: ticket.id,
                authorRole: 'SYSTEM',
                kind: 'TEXT',
                text: dmText,
                telegramUserChatId: user.telegramChatId,
                telegramUserMsgId: data.result.message_id,
              },
            }).catch(() => {});
          }
        } catch (err) {
          logger.error({ err }, 'support: failed to send DM to user');
        }
      }
  
      return res.json({
        ok: true,
        ticketCode,
        supportId: profile.supportId ?? null,
      });
    }),
  );

  return supportRouter;
}
