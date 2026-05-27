// NOTE: bot uses default DNS order (verbatim). Production runs from Vultr
// Amsterdam where both IPv4 and IPv6 paths to api.telegram.org are healthy
// (~30 ms RTT either family), so there's no need for an explicit family
// preference here. The historical workaround for the Timeweb VPS — where
// IPv4 was RKN-throttled and the only global IPv6 was deprecated upstream —
// is preserved in git history (commits 5ac98e8 → 1e9f65d) for reference if
// the prod target ever moves back inside RU.

import dotenv from 'dotenv';
import { Telegraf, Markup, TelegramError } from 'telegraf';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { prisma, resolveReferralCode, tryCreateAttribution, markFirstBotStart, loadReferralConfig, persistResolvedBucket } from '@wishlist/db';
import { t, pluralize, detectLocale, resolveEffectiveLocale, resolveLocaleWithSource, profileToLanguageSettings, resolveMarketBucket, localeToBCP47, HINT_LOOKUP_WINDOW_MS, type Locale } from '@wishlist/shared';
import logger from './logger';
import { emitPaymentAnalytics } from './analytics';
import { writeReferralAcquisitionSource } from './referral-attribution';
import { chargeDeliveredHint } from './hint-charge';
import {
  applyProMonthlyPayment,
  applyProYearlyPayment,
  applyProLifetimePayment,
  applyAddonPayment,
  KNOWN_ADDON_SKUS,
  type TelegramSuccessfulPayment,
} from './payments';

// Prefer app-local .env when running from repo root (pnpm dev),
// but also support running from within apps/bot (pnpm -C apps/bot start).
const envCandidates = [
  path.resolve(process.cwd(), 'apps/bot/.env'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

// Sentry/GlitchTip error tracking (opt-in)
import * as Sentry from '@sentry/node';
if (process.env.GLITCHTIP_DSN) {
  Sentry.init({
    dsn: process.env.GLITCHTIP_DSN,
    environment: process.env.GLITCHTIP_ENVIRONMENT || process.env.NODE_ENV || 'production',
    release: process.env.APP_RELEASE || 'unknown',
  });
}

const token = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL ?? 'https://example.com/miniapp';

// (#1) Bot startup — first line we expect in logs after every container
// boot. If this is missing, the process never reached this point (Node
// crashed during imports / dotenv) OR the logger transport is broken.
// Either case is actionable from this single line.
logger.info(
  {
    nodeVersion: process.version,
    pid: process.pid,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    release: process.env.APP_RELEASE ?? 'unknown',
    tokenPresent: !!token,
    logFilePath: process.env.LOG_FILE_PATH ?? null,
    httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy || null,
    miniAppUrl: MINI_APP_URL,
  },
  'bot process startup',
);

/** Send alert to all ADMIN_ALERT_CHAT_IDS. Best-effort, never throws. */
async function sendAdminAlert(text: string): Promise<void> {
  if (!token) return;
  const chatIds = (process.env.ADMIN_ALERT_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (chatIds.length === 0) return;
  await Promise.allSettled(
    chatIds.map((chatId) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(10_000),
      }),
    ),
  );
}

/** Update bot heartbeat in DB (best-effort). */
async function updateHeartbeat(): Promise<void> {
  try {
    await prisma.serviceHeartbeat.upsert({
      where: { serviceName: 'bot' },
      update: { updatedAt: new Date() },
      create: { serviceName: 'bot', updatedAt: new Date() },
    });
  } catch {
    // best-effort
  }
}

if (!token) {
  logger.warn('BOT_TOKEN is missing. Bot is disabled (see apps/bot/.env.example).');
  // Keep process alive so `pnpm dev` can still run web+api without a bot token.
  setInterval(() => {}, 60_000);
} else {
  // Telegram client with explicit keep-alive HTTPS agent.
  //   • keepAlive: reuse TCP/TLS sockets across calls — cuts ~200ms per request
  //   • keepAliveMsecs 30s: keep connections warm during quiet periods
  //   • timeout 60s: socket-level idle timeout (NOT connect timeout — that
  //     stays at OS default ~75s and dominates ETIMEDOUT during IPv6 flaps).
  // The connect-timeout class of failure is handled via watchdog's in-process
  // retry budget (12 attempts × ~75s = ~16 min) plus the Dockerfile pre-warm.
  const tgAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, timeout: 60_000 });
  const bot = new Telegraf(token, { telegram: { agent: tgAgent } });

  // Catch all unhandled middleware errors — structured pino logging instead of
  // Telegraf's default plain-text "Unhandled error while processing update".
  bot.catch((err: unknown, ctx) => {
    logger.error(
      { err, updateType: ctx.updateType, chatId: ctx.chat?.id, fromId: ctx.from?.id },
      'bot middleware error',
    );
    if (process.env.GLITCHTIP_DSN && err instanceof Error) Sentry.captureException(err);
  });

  const getLocale = (ctx: any): Locale => detectLocale(ctx.from?.language_code);
  const getHintContactWord = (n: number, locale: Locale): string => {
    switch (locale) {
      case 'ru':
        return pluralize(n, 'контакту', 'контактам', 'контактам', locale);
      case 'en':
        return pluralize(n, 'contact', 'contacts', 'contacts', locale);
      case 'zh-CN':
        return '位联系人';
      case 'hi':
        return pluralize(n, 'संपर्क', 'संपर्कों', 'संपर्कों', locale);
      case 'es':
        return pluralize(n, 'contacto', 'contactos', 'contactos', locale);
      case 'ar':
        return pluralize(n, 'جهة اتصال', 'جهات اتصال', 'جهات اتصال', locale);
    }
  };
  const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';


  // ─── Maintenance mode middleware ──────────────────────────────────────────
  // When MAINTENANCE_MODE=true, reply with maintenance message and record exposure.
  bot.use(async (ctx, next) => {
    if ((process.env.MAINTENANCE_MODE ?? '').toLowerCase() !== 'true') return next();
    // Only respond to messages and callback queries from users (not channel posts, edits, etc.)
    if (!ctx.from || !ctx.chat) return;
    // Don't intercept admin alert chats
    const adminChatIds = (process.env.ADMIN_ALERT_CHAT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (adminChatIds.includes(String(ctx.chat.id))) return next();
    // Don't intercept support chat
    const supportChatId = (process.env.SUPPORT_CHAT_ID ?? '').trim();
    if (supportChatId && String(ctx.chat.id) === supportChatId) return next();

    const locale = getLocale(ctx);
    const chatId = String(ctx.chat.id);
    const telegramId = String(ctx.from.id);

    // Record exposure via internal API (best-effort)
    fetch(`${API_BASE_URL}/internal/maintenance/exposure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-INTERNAL-KEY': token! },
      body: JSON.stringify({ telegramId, surface: 'bot', locale, telegramChatId: chatId }),
    }).catch(() => {});

    await ctx.reply(t('bot_maintenance', locale)).catch(() => {});
  });

  // ─── Support chat configuration ───────────────────────────────────────────
  const SUPPORT_CHAT_ID = (process.env.SUPPORT_CHAT_ID ?? '').trim();

  // ─── Support helper: generate next ticket code ────────────────────────────
  async function generateTicketCode(): Promise<string> {
    const last = await prisma.supportTicket.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { ticketCode: true },
    });
    if (!last) return 'SUP-0001';
    const match = last.ticketCode.match(/SUP-(\d+)/);
    if (!match) return 'SUP-0001';
    return `SUP-${String(parseInt(match[1]!, 10) + 1).padStart(4, '0')}`;
  }

  // ─── Support helper: extract content from any message ────────────────────
  type MsgContent = { kind: 'TEXT' | 'PHOTO' | 'VIDEO' | 'DOCUMENT' | 'OTHER'; text?: string; caption?: string; fileId?: string };

  function extractMessageContent(msg: any): MsgContent {
    if ('text' in msg && msg.text && !String(msg.text).startsWith('/')) {
      return { kind: 'TEXT', text: String(msg.text) };
    }
    if ('photo' in msg && Array.isArray(msg.photo) && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1] as { file_id: string };
      return { kind: 'PHOTO', caption: msg.caption as string | undefined, fileId: largest.file_id };
    }
    if ('document' in msg && msg.document) {
      return { kind: 'DOCUMENT', caption: msg.caption as string | undefined, fileId: (msg.document as any).file_id };
    }
    if ('video' in msg && msg.video) {
      return { kind: 'VIDEO', caption: msg.caption as string | undefined, fileId: (msg.video as any).file_id };
    }
    return { kind: 'OTHER', text: '[Unsupported message type]' };
  }

  // ─── Support helper: send message to support chat ─────────────────────────
  async function sendToSupportChat(
    fromId: number,
    fromFirstName: string,
    fromUsername: string | undefined,
    content: MsgContent,
    headerLines: string[],
  ): Promise<{ message_id: number } | null> {
    if (!SUPPORT_CHAT_ID) return null;
    const userTag = fromUsername ? `@${fromUsername}` : `ID: ${fromId}`;
    const header = [...headerLines, `👤 ${fromFirstName} ${userTag}`, `ID: ${fromId}`].join('\n');

    try {
      let sent: { message_id: number };
      if (content.kind === 'PHOTO' && content.fileId) {
        const cap = [header, content.caption].filter(Boolean).join('\n');
        sent = await bot.telegram.sendPhoto(SUPPORT_CHAT_ID, content.fileId, { caption: cap.slice(0, 1024) });
      } else if (content.kind === 'DOCUMENT' && content.fileId) {
        const cap = [header, content.caption].filter(Boolean).join('\n');
        sent = await bot.telegram.sendDocument(SUPPORT_CHAT_ID, content.fileId, { caption: cap.slice(0, 1024) });
      } else if (content.kind === 'VIDEO' && content.fileId) {
        const cap = [header, content.caption].filter(Boolean).join('\n');
        sent = await bot.telegram.sendVideo(SUPPORT_CHAT_ID, content.fileId, { caption: cap.slice(0, 1024) });
      } else {
        const body = content.text || `[${content.kind}]`;
        sent = await bot.telegram.sendMessage(SUPPORT_CHAT_ID, `${header}\n\n${body}`.slice(0, 4096));
      }
      return sent;
    } catch (err) {
      logger.error({ err }, 'failed to send to support chat');
      return null;
    }
  }

  // ─── Support: send ForceReply prompt to user ─────────────────────────────
  async function sendSupportPrompt(ctx: any): Promise<void> {
    const locale = getLocale(ctx);
    const chatId = String(ctx.chat.id);
    const sent = await ctx.reply(t('support_prompt', locale), {
      reply_markup: { force_reply: true, selective: true },
    }) as { message_id: number };
    await prisma.supportSession.create({
      data: {
        telegramChatId: chatId,
        promptMessageId: sent.message_id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    }).catch((err: unknown) => logger.error({ err }, 'failed to save support session'));
  }

  // ─── Support: create a new ticket ────────────────────────────────────────
  async function handleCreateTicket(ctx: any): Promise<void> {
    const locale = getLocale(ctx);
    const msg = ctx.message as any;
    const fromId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);

    // Upsert user
    const user = await prisma.user.upsert({
      where: { telegramId: fromId },
      update: { telegramChatId: chatId },
      create: { telegramId: fromId, telegramChatId: chatId },
    });

    // Rate limit: max 1 non-closed ticket per user
    const existingOpen = await prisma.supportTicket.findFirst({
      where: { userId: user.id, status: { not: 'CLOSED' } },
      select: { ticketCode: true },
    });
    if (existingOpen) {
      await ctx.reply(t('support_already_open', locale, { code: existingOpen.ticketCode }));
      return;
    }

    const content = extractMessageContent(msg);
    const ticketCode = await generateTicketCode();

    // Create ticket + first message in DB
    const ticket = await prisma.supportTicket.create({
      data: {
        ticketCode,
        userId: user.id,
        status: 'WAITING_SUPPORT',
        openedVia: 'support_flow',
        supportChatId: SUPPORT_CHAT_ID || null,
        messages: {
          create: {
            authorRole: 'USER',
            kind: content.kind,
            text: content.text,
            caption: content.caption,
            telegramUserChatId: chatId,
            telegramUserMsgId: msg.message_id as number,
            telegramFileId: content.fileId,
          },
        },
      },
      include: { messages: true },
    });

    // Confirm to user
    await ctx.reply(t('support_confirm', locale, { code: ticketCode }));

    // Forward to support chat
    const headerLines = [`[${ticketCode}] Новое обращение`];
    const sent = await sendToSupportChat(ctx.from.id, ctx.from.first_name || 'User', ctx.from.username, content, headerLines);
    if (sent) {
      await prisma.supportMessage.update({
        where: { id: ticket.messages[0]!.id },
        data: {
          telegramSupportChatId: SUPPORT_CHAT_ID,
          telegramSupportMsgId: sent.message_id,
        },
      }).catch(() => {});
    }

    logger.info({ ticketCode, userId: user.id }, 'support ticket created');
  }

  // ─── Support: handle user follow-up ──────────────────────────────────────
  async function handleUserFollowUp(ctx: any, ticket: { id: string; ticketCode: string; status: string }): Promise<void> {
    const locale = getLocale(ctx);
    const msg = ctx.message as any;
    const chatId = String(ctx.chat.id);
    const content = extractMessageContent(msg);

    // Save follow-up message
    const savedMsg = await prisma.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorRole: 'USER',
        kind: content.kind,
        text: content.text,
        caption: content.caption,
        telegramUserChatId: chatId,
        telegramUserMsgId: msg.message_id as number,
        telegramFileId: content.fileId,
      },
    });

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'WAITING_SUPPORT', updatedAt: new Date() },
    });

    // Forward to support chat as follow-up
    const headerLines = [`[${ticket.ticketCode}] Follow-up от пользователя`];
    const sent = await sendToSupportChat(ctx.from.id, ctx.from.first_name || 'User', ctx.from.username, content, headerLines);
    if (sent) {
      await prisma.supportMessage.update({
        where: { id: savedMsg.id },
        data: {
          telegramSupportChatId: SUPPORT_CHAT_ID,
          telegramSupportMsgId: sent.message_id,
        },
      }).catch(() => {});
    }

    await ctx.reply(t('support_followup_sent', locale, { code: ticket.ticketCode }));
  }

  // ─── Support: handle staff reply from support chat ────────────────────────
  async function handleSupportReply(ctx: any, replyToMsgId: number, content: MsgContent): Promise<void> {
    // Find which ticket message was replied to
    const originalMsg = await prisma.supportMessage.findFirst({
      where: { telegramSupportMsgId: replyToMsgId },
      include: { ticket: { include: { user: { select: { telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } } } } } } },
    });

    if (!originalMsg) {
      await ctx.reply('⚠️ Не удалось найти тикет для этого сообщения. Убедись, что это reply на сообщение тикета.').catch(() => {});
      return;
    }

    const ticket = originalMsg.ticket;

    if (ticket.status === 'CLOSED') {
      await ctx.reply(`ℹ️ Тикет ${ticket.ticketCode} уже закрыт.`).catch(() => {});
      return;
    }

    // Save support message
    const supportReplyRecord = await prisma.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorRole: 'SUPPORT',
        kind: content.kind,
        text: content.text,
        caption: content.caption,
        telegramSupportChatId: String(ctx.chat.id),
        telegramSupportMsgId: (ctx.message as any).message_id as number,
        telegramFileId: content.fileId,
      },
    });

    // Update ticket status
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'WAITING_USER', updatedAt: new Date() },
    });

    // Deliver to user
    const userChatId = ticket.user.telegramChatId;
    if (!userChatId) {
      await ctx.reply(`⚠️ [${ticket.ticketCode}] Не удалось доставить ответ: у пользователя нет Chat ID.`).catch(() => {});
      return;
    }

    const userLocale = resolveEffectiveLocale(profileToLanguageSettings(ticket.user.profile));
    const label = `[${ticket.ticketCode}] ${t('support_reply_label', userLocale)}`;

    try {
      let sent: { message_id: number };
      const forceReply = { force_reply: true as const, selective: true };

      if (content.kind === 'PHOTO' && content.fileId) {
        const cap = [label, content.caption].filter(Boolean).join(':\n');
        sent = await bot.telegram.sendPhoto(userChatId, content.fileId, {
          caption: cap.slice(0, 1024), reply_markup: forceReply,
        });
      } else if (content.kind === 'VIDEO' && content.fileId) {
        const cap = [label, content.caption].filter(Boolean).join(':\n');
        sent = await bot.telegram.sendVideo(userChatId, content.fileId, {
          caption: cap.slice(0, 1024), reply_markup: forceReply,
        });
      } else if (content.kind === 'DOCUMENT' && content.fileId) {
        const cap = [label, content.caption].filter(Boolean).join(':\n');
        sent = await bot.telegram.sendDocument(userChatId, content.fileId, {
          caption: cap.slice(0, 1024), reply_markup: forceReply,
        });
      } else {
        sent = await bot.telegram.sendMessage(userChatId, `${label}:\n${content.text || ''}`, {
          reply_markup: forceReply,
        });
      }

      // Store delivery message ID so user can reply to continue the thread
      await prisma.supportMessage.update({
        where: { id: supportReplyRecord.id },
        data: { telegramUserChatId: userChatId, telegramUserMsgId: sent.message_id },
      }).catch(() => {});
      await ctx.reply(`✅ Ответ доставлен (${ticket.ticketCode})`).catch(() => {});
    } catch (err) {
      logger.error({ err, ticketCode: ticket.ticketCode }, 'failed to deliver support reply to user');
      await ctx.reply(`⚠️ [${ticket.ticketCode}] Не удалось доставить ответ пользователю: ${String(err)}`).catch(() => {});
    }
  }

  // ─── Support: close ticket ────────────────────────────────────────────────
  async function handleCloseTicket(ctx: any, replyToMsgId: number): Promise<void> {
    const supportMsg = await prisma.supportMessage.findFirst({
      where: { telegramSupportMsgId: replyToMsgId },
      include: { ticket: { include: { user: { select: { telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } } } } } } },
    });

    if (!supportMsg) {
      await ctx.reply('⚠️ Не удалось найти тикет. Убедись, что /close — это reply на сообщение тикета.').catch(() => {});
      return;
    }

    const ticket = supportMsg.ticket;

    if (ticket.status === 'CLOSED') {
      await ctx.reply(`ℹ️ Тикет ${ticket.ticketCode} уже закрыт.`).catch(() => {});
      return;
    }

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });

    // Notify user (best-effort)
    const userChatId = ticket.user.telegramChatId;
    if (userChatId) {
      const userLocale = resolveEffectiveLocale(profileToLanguageSettings(ticket.user.profile));
      const closedText = t('support_closed', userLocale, { code: ticket.ticketCode });
      await bot.telegram.sendMessage(userChatId, closedText).catch(() => {});
    }

    await ctx.reply(`✅ Тикет ${ticket.ticketCode} закрыт.`).catch(() => {});
    logger.info({ ticketCode: ticket.ticketCode }, 'support ticket closed');
  }

  // ─── Support: close ticket by code (standalone /close SUP-XXXX) ──────────
  async function handleCloseTicketByCode(ctx: any, code: string): Promise<void> {
    const ticket = await prisma.supportTicket.findFirst({
      where: { ticketCode: code.toUpperCase() },
      include: { user: { select: { telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } } } } },
    });

    if (!ticket) {
      await ctx.reply(`⚠️ Тикет ${code} не найден.`).catch(() => {});
      return;
    }
    if (ticket.status === 'CLOSED') {
      await ctx.reply(`ℹ️ Тикет ${ticket.ticketCode} уже закрыт.`).catch(() => {});
      return;
    }

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });

    const userChatId = ticket.user.telegramChatId;
    if (userChatId) {
      const userLocale = resolveEffectiveLocale(profileToLanguageSettings(ticket.user.profile));
      await bot.telegram.sendMessage(userChatId, t('support_closed', userLocale, { code: ticket.ticketCode })).catch(() => {});
    }

    await ctx.reply(`✅ Тикет ${ticket.ticketCode} закрыт.`).catch(() => {});
    logger.info({ ticketCode: ticket.ticketCode }, 'support ticket closed by code');
  }

  // ─── Support: list open tickets ──────────────────────────────────────────
  async function handleListTickets(ctx: any): Promise<void> {
    const tickets = await prisma.supportTicket.findMany({
      where: { status: { notIn: ['CLOSED'] } },
      include: { user: { select: { firstName: true, telegramId: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (tickets.length === 0) {
      await ctx.reply('📋 Нет открытых тикетов.').catch(() => {});
      return;
    }

    const lines = tickets.map((tk: any) => {
      const status = tk.status === 'WAITING_SUPPORT' ? '🔴' : '🟡';
      const name = tk.firstName || 'User';
      const date = tk.createdAt.toISOString().slice(0, 10);
      return `${status} <b>${tk.ticketCode}</b> — ${name} (ID: ${tk.user.telegramId})\n   ${tk.openedVia} · ${date} · ${tk.status}`;
    });

    const msg = `📋 <b>Открытые тикеты (${tickets.length}):</b>\n\n${lines.join('\n\n')}\n\nЗакрыть: <code>/close SUP-XXXX</code>`;
    await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
  }

  // ─── Support: handle all messages from support chat ───────────────────────
  async function handleSupportChatMessage(ctx: any): Promise<void> {
    const msg = ctx.message as any;
    if (!msg) return;

    const text: string | undefined = 'text' in msg ? msg.text : undefined;

    // /tickets — list open tickets (no reply needed)
    if (text?.startsWith('/tickets')) {
      await handleListTickets(ctx);
      return;
    }

    // /close — by reply or by ticket code
    if (text?.startsWith('/close')) {
      if (msg.reply_to_message) {
        await handleCloseTicket(ctx, (msg.reply_to_message as { message_id: number }).message_id);
      } else {
        const match = text.match(/\/close\s+(SUP-\d+)/i);
        if (match) {
          await handleCloseTicketByCode(ctx, match[1]!);
        } else {
          await ctx.reply('Используй: <code>/close SUP-XXXX</code> или reply на сообщение тикета с /close', { parse_mode: 'HTML' }).catch(() => {});
        }
      }
      return;
    }

    // Must be a reply for staff replies
    if (!msg.reply_to_message) return;
    const replyToMsgId = (msg.reply_to_message as { message_id: number }).message_id;

    // Support staff reply — extract full content (text, photo, video, document)
    const content = extractMessageContent(msg);
    if (content.kind === 'OTHER') return;
    await handleSupportReply(ctx, replyToMsgId, content);
  }

  const menuButton = {
    type: 'web_app' as const,
    text: 'Wishlist',
    web_app: { url: MINI_APP_URL },
  };

  bot.start(async (ctx) => {
    const locale = getLocale(ctx);

    // Override any stale per-chat menu button left by previous bot versions
    await ctx.setChatMenuButton(menuButton).catch(() => {});

    const telegramId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    logger.info({ telegramId, startPayload: ctx.startPayload || null }, '/start received');
    // Capture every Telegram-supplied identity field. Bot-side ctx.from
    // mirrors the Mini App initData.user, so the bot path is the only way
    // to populate identity for users who only ever /start the bot and
    // never open the Mini App (~29% of all users on 2026-05-08).
    const fromFirstName = ctx.from.first_name || null;
    const fromLastName = ctx.from.last_name || null;
    const fromUsername = ctx.from.username || null;
    const fromIsPremium = ctx.from.is_premium === true;
    const fromLangCode = ctx.from.language_code || null;
    // Upsert user with welcomeSent=false on both create AND update.
    //  - create: brand-new user, hasn't received welcome yet
    //  - update: user may have been pre-created by Mini App (API getOrCreateTgUser)
    //    with welcomeSent=true (default), so /start must reset to false to track delivery
    // welcomeSent is set back to true after successful message delivery below.
    const user = await prisma.user.upsert({
      where: { telegramId },
      update: {
        telegramChatId: chatId,
        welcomeSent: false,
        firstName: fromFirstName,
        lastName: fromLastName,
        username: fromUsername,
        isPremium: fromIsPremium,
      },
      create: {
        telegramId,
        telegramChatId: chatId,
        welcomeSent: false,
        firstName: fromFirstName,
        lastName: fromLastName,
        username: fromUsername,
        isPremium: fromIsPremium,
      },
    }).catch((err) => {
      logger.warn({ err, telegramId }, 'user upsert failed in /start');
      return null;
    });

    // Persist locale segmentation on UserProfile via the shared
    // packages/db/locale-persistence helper — same atomic
    // INSERT…ON CONFLICT DO UPDATE used by the API tgRouter middleware,
    // so concurrent /start retries (webhook redelivery) and a parallel
    // Mini App request can't race. Bot has no browser/IP signals, so
    // only language_code + first_name script analysis feed the resolver.
    if (user && process.env.LOCALE_DETECTION_ENABLED !== 'false') {
      const { bucket } = resolveMarketBucket({
        languageCode: fromLangCode,
        firstName: fromFirstName,
      });
      if (bucket !== 'unknown' || fromLangCode != null) {
        await persistResolvedBucket({
          target: { userId: user.id },
          rawLanguage: fromLangCode,
          bucket,
        }).catch((err) => {
          logger.warn({ err, telegramId }, 'profile locale upsert failed in /start');
        });
      }
    }

    // Fire-and-forget analytics. userId is internal User.id (cuid). If the
    // upsert above failed (user === null), persist with NULL rather than
    // fall back to the Telegram id — see docs/analytics-events.md.
    prisma.analyticsEvent.create({
      data: {
        event: 'bot.start_received',
        userId: user?.id ?? null,
        props: {
          telegramId: ctx.from.id,
          hasStartParam: !!ctx.startPayload,
          startParam: ctx.startPayload || null,
        },
      },
    }).catch(() => {});

    const payload = ctx.startPayload; // slug passed via ?start=SLUG deep link

    // Deep link users get a contextual reply (not a welcome message).
    // Mark welcomeSent=true so the startup recovery loop doesn't spam them later.
    if (payload) {
      await prisma.user.update({ where: { telegramId }, data: { welcomeSent: true } }).catch((err) => {
        logger.warn({ err, telegramId }, 'failed to mark welcomeSent for deep-link user');
      });
    }

    if (payload?.startsWith('br_')) {
      // Birthday reminder deep link: ?start=br_<deliveryId>
      // The bot only acks here — actual target resolution + clickedAt
      // attribution happens in the Mini App via /tg/birthday-reminders/resolve.
      // We just open the Mini App with the same payload so the WebView gets it
      // via initDataUnsafe.start_param.
      try {
        return ctx.reply(
          t('bot_start', locale),
          Markup.inlineKeyboard([
            Markup.button.webApp(
              t('bot_referral_open_btn', locale),
              `${MINI_APP_URL}?startapp=${encodeURIComponent(payload)}`,
            ),
          ]),
        );
      } catch (err) {
        logger.error({ err }, 'birthday deep link error');
        return ctx.reply(t('bot_error', locale));
      }
    }
    if (payload?.startsWith('santa_')) {
      // Secret Santa invite deep link
      const token = payload.slice('santa_'.length);
      try {
        const campaign = await prisma.santaCampaign.findUnique({
          where: { inviteToken: token },
          select: { id: true, title: true, status: true, owner: { select: { firstName: true, profile: { select: { displayName: true } } } } },
        });
        if (!campaign || campaign.status === 'CANCELLED') {
          return ctx.reply(t('bot_santa_invite_expired', locale));
        }
        if (!['OPEN', 'DRAFT'].includes(campaign.status)) {
          return ctx.reply(t('bot_santa_invite_closed', locale));
        }
        const ownerName = campaign.owner.profile?.displayName || campaign.owner.firstName || t('api_user_fallback', locale);
        return ctx.reply(
          t('bot_santa_invite_msg', locale, { owner: ownerName, title: campaign.title }),
          Markup.inlineKeyboard([
            Markup.button.webApp(t('bot_santa_join_btn', locale), `${MINI_APP_URL}?startapp=santa_join_${token}`),
          ]),
        );
      } catch (err) {
        logger.error({ err }, 'santa deep link error');
        return ctx.reply(t('bot_error', locale));
      }
    }
    if (payload?.startsWith('hint_')) {
      // Hint deep link — friend clicks a gift hint link
      const itemId = payload.slice(5);
      try {
        const item = await prisma.item.findUnique({
          where: { id: itemId },
          select: { id: true, title: true, status: true, wishlist: { select: { slug: true, ownerId: true, owner: { select: { telegramId: true, firstName: true, telegramChatId: true } } } } },
        });
        if (!item) {
          return ctx.reply(t('bot_hint_unavailable', locale));
        }
        // Self-send check: owner opened their own hint
        if (item.wishlist.owner.telegramId === telegramId) {
          return ctx.reply(t('bot_hint_self', locale));
        }
        // Item no longer available
        if (item.status !== 'AVAILABLE') {
          return ctx.reply(t('bot_hint_reserved', locale));
        }
        // Resolve owner name
        let ownerName = item.wishlist.owner.firstName || t('api_user_fallback', locale);
        if (!item.wishlist.owner.firstName && item.wishlist.owner.telegramChatId) {
          try {
            const BOT_TOKEN = process.env.BOT_TOKEN!;
            const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${item.wishlist.owner.telegramChatId}`);
            const data = await resp.json() as { ok: boolean; result?: { first_name?: string } };
            if (data.ok && data.result?.first_name) {
              ownerName = data.result.first_name;
              // Cache for future
              await prisma.user.update({ where: { id: item.wishlist.ownerId }, data: { firstName: data.result.first_name } }).catch(() => {});
            }
          } catch { /* use fallback */ }
        }
        const shortName = ownerName.split(' ')[0] ?? ownerName;
        // Hint message uses the RECIPIENT's locale (the person opening the deep link)
        const msg = t('bot_hint_msg', locale, { owner: ownerName, title: item.title, shortName: shortName.toLowerCase() });
        return ctx.reply(msg, Markup.inlineKeyboard([
          Markup.button.webApp(t('bot_hint_view_btn', locale), `${MINI_APP_URL}?startapp=${item.wishlist.slug}__item_${item.id}`),
        ]));
      } catch (err) {
        logger.error({ err }, 'hint deep link error');
        return ctx.reply(t('bot_error', locale));
      }
    }
    if (payload?.startsWith('ref_')) {
      // ── Referral deep link: ?start=ref_<CODE> ──────────────────────────────
      // Flow:
      //   0. Defense-in-depth: short-circuit if program disabled.
      //   1. Parse code, resolve to inviter.
      //   2. Resolve/create the invitee user (already upserted at top of /start).
      //   3. Call tryCreateAttribution — first-touch, idempotent.
      //   4. Mark firstBotStartAt for the invitee (funnel tracking).
      //   5. Notify inviter if config says so.
      //   6. Reply to invitee with Mini App button.
      const refCode = payload.slice('ref_'.length);

      // Step 0: program kill-switch. tryCreateAttribution already returns
      // { kind: 'program_disabled' } when config.enabled=false
      // (packages/db/src/referral.ts:364), but checking here saves the
      // redundant DB roundtrips (resolveReferralCode → user.findUnique →
      // tryCreateAttribution → markFirstBotStart) and gives the invitee a
      // clean welcome rather than an error path. If the config load itself
      // fails, fall through to the original flow — that path has its own
      // gating downstream.
      try {
        const earlyConfig = await loadReferralConfig(prisma);
        if (!earlyConfig.enabled) {
          logger.info({ telegramId, refCode }, '[referral] /start ref_ while program disabled — ignoring');
          prisma.analyticsEvent.create({
            data: {
              event: 'referral.feature_flag_evaluated',
              userId: user?.id ?? null,
              props: { flag: 'enabled', value: false, context: 'bot.start', refCode },
            },
          }).catch(() => {});
          // Record acquisition source even when program is OFF — analytics
          // signal stays useful for cohort analysis regardless of rewards.
          if (user?.id) {
            await writeReferralAcquisitionSource(prisma, user.id, refCode);
          }
          return ctx.reply(
            t('bot_referral_welcome', locale),
            Markup.inlineKeyboard([
              Markup.button.webApp(t('bot_referral_open_btn', locale), MINI_APP_URL),
            ]),
          );
        }
      } catch (cfgErr) {
        logger.warn({ err: cfgErr, telegramId }, '[referral] config load failed in /start ref_; falling through');
      }

      try {
        const inviter = await resolveReferralCode(prisma, refCode);

        // Always log the event — even if code is invalid. userId is internal
        // User.id (cuid); see docs/analytics-events.md for the contract.
        prisma.analyticsEvent.create({
          data: {
            event: inviter ? 'referral.start_command_received' : 'referral.code_invalid',
            userId: user?.id ?? null,
            props: { refCode, hasInviter: !!inviter },
          },
        }).catch(() => {});

        if (!inviter) {
          logger.info({ telegramId, refCode }, '[referral] invalid code in /start');
          return ctx.reply(t('bot_referral_code_invalid', locale));
        }

        // Resolve invitee user (already upserted earlier in this handler).
        const invitee = await prisma.user.findUnique({
          where: { telegramId },
          select: { id: true },
        });
        if (!invitee) {
          // Extremely unlikely — upsert at top of /start should have created it.
          logger.warn({ telegramId }, '[referral] invitee user not found after upsert');
          return ctx.reply(
            t('bot_referral_welcome', locale),
            Markup.inlineKeyboard([
              Markup.button.webApp(t('bot_referral_open_btn', locale), MINI_APP_URL),
            ]),
          );
        }

        // Attribution — fire-and-forget semantics; don't let attribution failure
        // block the invitee's experience. Log all outcomes for observability.
        const attrResult = await tryCreateAttribution(prisma, {
          inviterUserId: inviter.inviterUserId,
          inviteeUserId: invitee.id,
          referralCode: refCode,
          locale: ctx.from.language_code ?? undefined,
        });

        logger.info({ telegramId, inviterUserId: inviter.inviterUserId, kind: attrResult.kind }, '[referral] attribution result');
        prisma.analyticsEvent.create({
          data: {
            event: attrResult.kind === 'attributed'
              ? 'referral.attributed'
              : 'referral.attribution_rejected_on_write',
            userId: invitee.id,
            props: { refCode, inviterUserId: inviter.inviterUserId, kind: attrResult.kind },
          },
        }).catch(() => {});

        // Mark firstBotStartAt for funnel tracking (idempotent — writes once).
        await markFirstBotStart(prisma, invitee.id).catch((err) => {
          logger.warn({ err, userId: invitee.id }, '[referral] markFirstBotStart failed');
        });

        // First-touch acquisition source. Parallel signal to referredByUserId
        // (set by tryCreateAttribution above) — feeds evaluateGuestConversion.
        await writeReferralAcquisitionSource(prisma, invitee.id, refCode);

        // ── Notify inviter (if config says so) ────────────────────────────────
        if (attrResult.kind === 'attributed') {
          try {
            const config = await loadReferralConfig(prisma);
            if (config.notifyInviterArrival) {
              const inviterUser = await prisma.user.findUnique({
                where: { id: inviter.inviterUserId },
                select: {
                  telegramChatId: true,
                  profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
                },
              });
              if (inviterUser?.telegramChatId) {
                // Resolve inviter's locale via the shared resolver chain
                // (manual → live (n/a here) → persisted normalizedLocale →
                // legacy raw → 'en'). Earlier this called Telegram getChat
                // on every invite to recover the live language_code; that
                // round-trip is now redundant because middleware persists
                // normalizedLocale on every Mini App / bot touch.
                const { locale: inviterLocale, source: inviterLocaleSource } = resolveLocaleWithSource(
                  profileToLanguageSettings(inviterUser.profile),
                );
                logger.debug({ inviterUserId: inviter.inviterUserId, locale: inviterLocale, localeSource: inviterLocaleSource }, '[referral] inviter arrival locale resolved');
                // Only emit `sent` analytics if Telegram actually accepted
                // the message — otherwise bot_notification_sent counts drift
                // above real deliveries and the dashboard lies.
                const delivered = await bot.telegram.sendMessage(
                  inviterUser.telegramChatId,
                  t('bot_referral_inviter_arrival', inviterLocale),
                ).then(() => true).catch((err) => {
                  logger.warn({ err, inviterUserId: inviter.inviterUserId }, '[referral] inviter arrival notification failed');
                  return false;
                });
                prisma.analyticsEvent.create({
                  data: {
                    event: delivered
                      ? 'referral.bot_notification_sent'
                      : 'referral.bot_notification_delivery_failed',
                    userId: inviter.inviterUserId,
                    props: { type: 'arrival' },
                  },
                }).catch(() => {});
              }
            }
          } catch (err) {
            logger.warn({ err }, '[referral] inviter notification error');
          }
        }

        // Reply to invitee with Mini App button.
        return ctx.reply(
          t('bot_referral_welcome', locale),
          Markup.inlineKeyboard([
            Markup.button.webApp(t('bot_referral_open_btn', locale), MINI_APP_URL),
          ]),
        );
      } catch (err) {
        logger.error({ err, refCode }, '[referral] ref deep link error');
        return ctx.reply(t('bot_error', locale));
      }
    }
    if (payload?.startsWith('gg_')) {
      // Group gift invite deep link
      const token = payload.slice(3);
      logger.info({ telegramId, type: 'group_gift', token }, 'deep link received');
      return ctx.reply(
        '👥 Тебя пригласили скинуться на подарок!',
        Markup.inlineKeyboard([
          Markup.button.webApp('Открыть', `${MINI_APP_URL}?startapp=gg_${token}`),
        ]),
      );
    }
    if (payload?.startsWith('cs_')) {
      // Curated selection deep link — open lite-wishlist in Mini App
      const token = payload.slice(3);
      logger.info({ telegramId, type: 'curated_selection', token }, 'deep link received');
      return ctx.reply(
        t('bot_cs_invite_msg', locale),
        Markup.inlineKeyboard([
          Markup.button.webApp(t('bot_cs_open_btn', locale), `${MINI_APP_URL}?startapp=cs_${token}`),
        ]),
      );
    }
    if (payload?.startsWith('profile_')) {
      // Public profile deep link
      const username = payload.slice('profile_'.length);
      logger.info({ telegramId, type: 'profile', username }, 'deep link received');
      if (username) {
        return ctx.reply(
          t('bot_view_profile', locale),
          Markup.inlineKeyboard([
            Markup.button.webApp(t('bot_view_profile_btn', locale), `${MINI_APP_URL}?startapp=profile_${username}`),
          ]),
        );
      }
    }
    if (payload) {
      // Guest deep link — open specific wishlist in mini app
      return ctx.reply(
        t('bot_view_wishlist', locale),
        Markup.inlineKeyboard([
          Markup.button.webApp(t('bot_view_wishlist_btn', locale), `${MINI_APP_URL}?startapp=${payload}`),
        ]),
      );
    }
    // Regular start — two separate messages:
    // 1. welcome (link preview disabled so the Support link doesn't generate preview)
    // 2. donation (link preview intentionally enabled for Tribute link)
    //
    // Guaranteed delivery: if the welcome reply fails (network, crash), welcomeSent
    // stays false and the startup recovery loop will retry on next boot.
    // This prevents losing first-time users who /start during downtime.
    //
    // Mark welcomeSent=true after the FIRST message — the donation is best-effort.
    // This avoids sending a duplicate welcome if only the donation message failed.
    try {
      await ctx.reply(t('bot_start', locale), { link_preview_options: { is_disabled: true } });
      await prisma.user.update({ where: { telegramId }, data: { welcomeSent: true } }).catch(() => {});
      await ctx.reply(t('bot_donation', locale)).catch(() => {});
    } catch (err) {
      logger.error({ err, telegramId }, 'failed to deliver welcome message');
      // welcomeSent stays false → startup recovery will retry
    }
  });

  // /help — includes support button
  bot.command('help', async (ctx) => {
    const locale = getLocale(ctx);
    return ctx.reply(t('bot_help', locale), Markup.inlineKeyboard([
      [Markup.button.callback(t('support_btn', locale), 'open_support')],
    ]));
  });

  // /support — immediately launch support flow
  bot.command('support', async (ctx) => {
    await sendSupportPrompt(ctx);
  });

  // Inline button "Contact support" from /help
  bot.action('open_support', async (ctx) => {
    await ctx.answerCbQuery();
    await sendSupportPrompt(ctx);
  });

  // Inline button "Куплено" from reservation reminder notifications
  bot.action(/^res_purchased:(.+)$/, async (ctx) => {
    try {
      const itemId = ctx.match[1]!;
      const telegramId = String(ctx.from.id);

      // Find the user by Telegram ID
      const user = await prisma.user.findFirst({
        where: { telegramId },
        select: { id: true },
      });
      if (!user) {
        await ctx.answerCbQuery('Пользователь не найден');
        return;
      }

      // Verify the user has this item reserved
      const item = await prisma.item.findUnique({
        where: { id: itemId },
        select: { reserverUserId: true, status: true, title: true },
      });
      if (!item || item.reserverUserId !== user.id || item.status !== 'RESERVED') {
        await ctx.answerCbQuery('Бронирование не найдено');
        return;
      }

      // Toggle purchased flag via reservationMeta
      const existing = await prisma.reservationMeta.findUnique({
        where: { itemId_reserverUserId: { itemId, reserverUserId: user.id } },
        select: { purchased: true },
      });
      const newPurchased = !(existing?.purchased ?? false);

      await prisma.reservationMeta.upsert({
        where: { itemId_reserverUserId: { itemId, reserverUserId: user.id } },
        create: { itemId, reserverUserId: user.id, purchased: newPurchased, purchasedAt: newPurchased ? new Date() : null },
        update: { purchased: newPurchased, purchasedAt: newPurchased ? new Date() : null },
      });

      // Update inline keyboard to reflect new state
      const newKeyboard = newPurchased
        ? [[{ text: '📱 Открыть', url: 'https://t.me/WishBoardBot/app' }, { text: '✓ Куплено ✅', callback_data: `res_purchased:${itemId}` }]]
        : [[{ text: '📱 Открыть', url: 'https://t.me/WishBoardBot/app' }, { text: '✓ Куплено', callback_data: `res_purchased:${itemId}` }]];

      await ctx.editMessageReplyMarkup({ inline_keyboard: newKeyboard });
      await ctx.answerCbQuery(newPurchased ? 'Отмечено как купленное' : 'Отметка снята');
    } catch (err) {
      logger.error({ err }, 'res_purchased callback failed');
      await ctx.answerCbQuery('Произошла ошибка').catch(() => {});
    }
  });

  // ─── Birthday Reminders: mute callback "🔕 Не напоминать об этом человеке" ──
  // Callback data: bdm:<deliveryId>. Resolves the delivery → upserts a
  // BirthdayReminderMute row → answers callback + edits the keyboard so the
  // mute button is replaced by a confirmation-style row. Idempotent: clicking
  // twice is a no-op apart from the toast.
  bot.action(/^bdm:(.+)$/, async (ctx) => {
    try {
      const deliveryId = ctx.match[1]!;
      const telegramId = String(ctx.from.id);
      const locale = getLocale(ctx);

      const user = await prisma.user.findFirst({
        where: { telegramId },
        select: { id: true },
      });
      if (!user) {
        await ctx.answerCbQuery('User not found');
        return;
      }

      const delivery = await prisma.birthdayReminderDelivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true,
          recipientUserId: true,
          birthdayUserId: true,
          birthdayUser: {
            select: {
              firstName: true,
              profile: { select: { displayName: true, username: true } },
            },
          },
        },
      });
      if (!delivery) {
        await ctx.answerCbQuery('Delivery not found');
        return;
      }
      if (delivery.recipientUserId !== user.id) {
        await ctx.answerCbQuery('Forbidden');
        return;
      }

      // Idempotent upsert
      const existing = await prisma.birthdayReminderMute.findUnique({
        where: {
          userId_mutedBirthdayUserId: {
            userId: user.id,
            mutedBirthdayUserId: delivery.birthdayUserId,
          },
        },
      });

      if (!existing) {
        await prisma.birthdayReminderMute.create({
          data: {
            userId: user.id,
            mutedBirthdayUserId: delivery.birthdayUserId,
          },
        });
      }

      const displayName =
        delivery.birthdayUser.profile?.displayName?.trim() ||
        delivery.birthdayUser.firstName?.trim() ||
        delivery.birthdayUser.profile?.username?.trim() ||
        'WishBoard';

      const toastText = existing
        ? t('bot_br_mute_already', locale)
        : t('bot_br_mute_done', locale, { name: displayName });
      await ctx.answerCbQuery(toastText);

      // Replace the inline keyboard: keep the primary CTA, drop the mute row.
      // Telegram rejects edit if the new markup is identical, so guard with try/catch.
      try {
        const msg = ctx.callbackQuery.message;
        const reply = (msg && 'reply_markup' in msg ? msg.reply_markup : undefined) as
          | { inline_keyboard?: unknown[][] }
          | undefined;
        const original = (reply?.inline_keyboard ?? []) as Array<Array<Record<string, unknown>>>;
        const filtered = original.filter(
          (row) =>
            !row.some(
              (btn) =>
                'callback_data' in btn && typeof btn.callback_data === 'string' && (btn.callback_data as string).startsWith('bdm:'),
            ),
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await ctx.editMessageReplyMarkup({ inline_keyboard: filtered as any });
      } catch {
        // Already edited or no message context — toast is enough.
      }
    } catch (err) {
      logger.error({ err }, 'birthday: bdm callback failed');
      await ctx.answerCbQuery('Error').catch(() => {});
    }
  });

  bot.command('paysupport', (ctx) => {
    const locale = getLocale(ctx);
    return ctx.reply(t('bot_paysupport', locale));
  });

  // ─── Payment handlers (must be registered BEFORE bot.on('text')) ──────────

  // pre_checkout_query — Telegram requires a response within 10 seconds
  // Handles both subscription (pro_monthly:...) and one-time addon (addon:...) payments
  bot.on('pre_checkout_query', async (ctx) => {
    try {
      const raw = ctx.preCheckoutQuery.invoice_payload;
      logger.info({ invoicePayload: raw }, 'pre_checkout received');

      const parts = raw.split(':');
      const payloadType = parts[0];

      if (payloadType === 'pro_monthly' || payloadType === 'pro_yearly' || payloadType === 'pro_lifetime') {
        // pro_monthly:<telegramId>:<uuid>  |  pro_yearly:<telegramId>:<uuid>  |  pro_lifetime:<telegramId>:<uuid>
        if (parts.length < 3) {
          logger.warn({ invoicePayload: raw, reason: 'invalid_pro_payload' }, 'pre_checkout rejected');
          await ctx.answerPreCheckoutQuery(false, 'Invalid payment');
          return;
        }
        const telegramId = parts[1];
        const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
        if (!user) {
          logger.warn({ telegramId, reason: 'user_not_found' }, 'pre_checkout rejected');
          await ctx.answerPreCheckoutQuery(false, 'User not found');
          return;
        }
        await ctx.answerPreCheckoutQuery(true);

      } else if (payloadType === 'addon') {
        // addon:<skuCode>:<telegramId>:<targetId|_>:<sessionId>
        if (parts.length < 5) {
          logger.warn({ invoicePayload: raw, reason: 'invalid_addon_payload' }, 'pre_checkout rejected');
          await ctx.answerPreCheckoutQuery(false, 'Invalid addon payload');
          return;
        }
        const skuCode = parts[1];
        const telegramId = parts[2];
        // Single source of truth — KNOWN_ADDON_SKUS is exported from
        // ./payments and union-derived from SKU_ADDON_TYPES + SKU_CREDITS,
        // so pre_checkout's allow-list can never drift from the processor's
        // map again. Previously this was a hand-maintained list that
        // dropped `group_gift_unlock`, silently breaking the group-gift
        // purchase flow at the Telegram pre_checkout step.
        if (!skuCode || !KNOWN_ADDON_SKUS.has(skuCode)) {
          logger.warn({ skuCode, reason: 'unknown_sku' }, 'pre_checkout rejected');
          await ctx.answerPreCheckoutQuery(false, 'Unknown SKU');
          return;
        }
        const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
        if (!user) {
          logger.warn({ telegramId, reason: 'addon_user_not_found' }, 'pre_checkout rejected');
          await ctx.answerPreCheckoutQuery(false, 'User not found');
          return;
        }
        await ctx.answerPreCheckoutQuery(true);

      } else {
        logger.warn({ invoicePayload: raw, reason: 'unknown_payload_type', payloadType }, 'pre_checkout rejected');
        await ctx.answerPreCheckoutQuery(false, 'Invalid payment');
      }
    } catch (err) {
      logger.error({ err }, 'pre_checkout error');
      if (process.env.GLITCHTIP_DSN) Sentry.captureException(err);
      await ctx.answerPreCheckoutQuery(false, 'Error').catch(() => {});
    }
  });

  // successful_payment — handles PRO subscription renewals and one-time add-on purchases
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!('successful_payment' in msg) || !msg.successful_payment) {
      return next();
    }

    const payment = msg.successful_payment as Record<string, unknown> & TelegramSuccessfulPayment;

    try {
      const raw = payment.invoice_payload;
      logger.info({ invoicePayload: raw, totalAmount: payment.total_amount, currency: payment.currency }, 'payment success received');

      const parts = raw.split(':');
      const payloadType = parts[0];

      // ── PRO subscription: pro_monthly:<telegramId>:<uuid> ─────────────────
      if (payloadType === 'pro_monthly') {
        if (parts.length < 3) return;
        const telegramId = parts[1];

        const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
        if (!user) {
          logger.error({ telegramId }, 'payment user not found');
          return;
        }

        const chargeId = payment.telegram_payment_charge_id;
        const outcome = await applyProMonthlyPayment(prisma, user.id, payment);

        if (outcome.kind === 'duplicate') {
          logger.info({ chargeId }, 'duplicate payment, skip');
          return;
        }
        if (outcome.kind === 'lifetime_guard') {
          logger.warn({ userId: user.id, chargeId }, 'monthly payment received after lifetime — kept lifetime, audited only');
          return;
        }
        if (outcome.kind !== 'pro_monthly_activated') return;

        emitPaymentAnalytics({
          userId: user.id,
          payload: payment,
          planCode: 'PRO',
          billingPeriod: 'monthly',
          hadActivePriorSub: outcome.hadActivePriorSub,
        });

        const locale = getLocale(ctx);
        const dateFmtLocale = localeToBCP47(locale);
        const fmtDate = outcome.periodEnd.toLocaleDateString(dateFmtLocale, { day: 'numeric', month: 'long', year: 'numeric' });
        await ctx.reply(
          t('bot_pro_activated', locale, { date: fmtDate }),
          Markup.inlineKeyboard([Markup.button.webApp(t('bot_open_app', locale), MINI_APP_URL)]),
        );
        logger.info({ userId: user.id, chargeId, periodEnd: outcome.periodEnd.toISOString() }, 'subscription activated');
        return;
      }

      // ── PRO yearly (one-time): pro_yearly:<telegramId>:<uuid> ─────────────
      //   Telegram Stars doesn't support subscription_period > 30 days, so
      //   yearly is a non-recurring invoice. We extend currentPeriodEnd by
      //   365 days from max(now, existing end), set cancelAtPeriodEnd=true
      //   (nothing to auto-renew), and log the event. Renewal is handled
      //   by the yearly-expiry reminder cron in apps/api.
      if (payloadType === 'pro_yearly') {
        if (parts.length < 3) return;
        const telegramId = parts[1];

        const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
        if (!user) {
          logger.error({ telegramId }, 'yearly payment user not found');
          return;
        }

        const chargeId = payment.telegram_payment_charge_id;
        const outcome = await applyProYearlyPayment(prisma, user.id, payment);

        if (outcome.kind === 'duplicate') {
          logger.info({ chargeId }, 'duplicate yearly payment, skip');
          return;
        }
        if (outcome.kind === 'lifetime_guard') {
          logger.warn({ userId: user.id, chargeId }, 'yearly payment received after lifetime — kept lifetime, audited only');
          return;
        }
        if (outcome.kind !== 'pro_yearly_activated') return;

        emitPaymentAnalytics({
          userId: user.id,
          payload: payment,
          planCode: 'PRO',
          billingPeriod: 'yearly',
          hadActivePriorSub: outcome.hadActivePriorSub,
        });

        const locale = getLocale(ctx);
        const dateFmtLocale = localeToBCP47(locale);
        const fmtDate = outcome.periodEnd.toLocaleDateString(dateFmtLocale, { day: 'numeric', month: 'long', year: 'numeric' });
        await ctx.reply(
          t('bot_pro_activated_yearly', locale, { date: fmtDate }),
          Markup.inlineKeyboard([Markup.button.webApp(t('bot_open_app', locale), MINI_APP_URL)]),
        );
        logger.info({ userId: user.id, chargeId, periodEnd: outcome.periodEnd.toISOString(), stackedFromExisting: outcome.stackedFromExisting }, 'yearly subscription activated');
        return;
      }

      // ── PRO lifetime (one-time, permanent): pro_lifetime:<telegramId>:<uuid> ──
      //   Lifetime is a non-recurring Stars purchase that grants permanent Pro.
      //   We write a Subscription with billingPeriod='lifetime', cancelAtPeriodEnd=false,
      //   and currentPeriodEnd anchored at 2099-12-31 (a semantic "no expiry"
      //   sentinel — resolvers always treat billingPeriod='lifetime' as truth,
      //   the date is just defensive padding so the expiry-sweep cron never
      //   flips it to EXPIRED). Lifetime overrides any prior monthly/yearly row;
      //   if a previous row existed, this upsert overwrites it (preserving
      //   PaymentEvent history via the audit trail). Idempotent on chargeId.
      if (payloadType === 'pro_lifetime') {
        if (parts.length < 3) return;
        const telegramId = parts[1];

        const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
        if (!user) {
          logger.error({ telegramId }, 'lifetime payment user not found');
          return;
        }

        const chargeId = payment.telegram_payment_charge_id;
        const outcome = await applyProLifetimePayment(prisma, user.id, payment);

        if (outcome.kind === 'duplicate') {
          logger.info({ chargeId }, 'duplicate lifetime payment, skip');
          return;
        }
        if (outcome.kind !== 'pro_lifetime_activated') return;

        emitPaymentAnalytics({
          userId: user.id,
          payload: payment,
          planCode: 'PRO',
          billingPeriod: 'lifetime',
          hadActivePriorSub: outcome.hadActivePriorSub,
        });

        const locale = getLocale(ctx);
        await ctx.reply(
          t('bot_pro_activated_lifetime', locale),
          Markup.inlineKeyboard([Markup.button.webApp(t('bot_open_app', locale), MINI_APP_URL)]),
        );
        logger.info(
          { userId: user.id, chargeId, replacedPrior: outcome.replacedPrior },
          'lifetime subscription activated',
        );
        return;
      }

      // ── One-time add-on: addon:<skuCode>:<telegramId>:<targetId|_>:<sessionId> ──
      if (payloadType === 'addon') {
        // parts: [addon, skuCode, telegramId, targetIdOrUnderscore, sessionId]
        if (parts.length < 5) return;
        const [, skuCode, telegramId, rawTargetId] = parts;
        if (!skuCode || !telegramId) return;
        const targetId = rawTargetId === '_' ? null : rawTargetId ?? null;

        const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
        if (!user) {
          logger.error({ telegramId }, 'addon payment user not found');
          return;
        }

        const chargeId = payment.telegram_payment_charge_id;
        const outcome = await applyAddonPayment(prisma, user.id, skuCode, targetId, payment);

        if (outcome.kind === 'duplicate') {
          logger.info({ chargeId }, 'duplicate addon payment, skip');
          return;
        }
        if (outcome.kind === 'addon_unknown_sku') {
          logger.warn({ skuCode, chargeId }, 'addon payment for unknown SKU, ignored');
          return;
        }
        if (outcome.kind !== 'addon_permanent_activated' && outcome.kind !== 'addon_consumable_activated') return;

        emitPaymentAnalytics({
          userId: user.id,
          payload: payment,
          planCode: null,
          billingPeriod: 'addon',
          hadActivePriorSub: false,
          skuCode,
        });

        const locale = getLocale(ctx);
        await ctx.reply(
          t('bot_addon_activated', locale),
          Markup.inlineKeyboard([Markup.button.webApp(t('bot_open_app', locale), MINI_APP_URL)]),
        );
        logger.info({ userId: user.id, skuCode, targetId, chargeId }, 'addon activated');
        return;
      }

      logger.warn({ invoicePayload: raw }, 'unknown payment payload format');
    } catch (err) {
      logger.error({ err }, 'payment processing error');
      if (process.env.GLITCHTIP_DSN) Sentry.captureException(err);
    }
  });

  // ─── Hint direct delivery: users_shared handler ─────────────────────────
  // When sender selects recipients via request_users keyboard, Telegram sends
  // a message with users_shared. We deliver the hint directly via Bot API.
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message as unknown as Record<string, unknown>;
    if (!msg.users_shared) return next();

    const senderTgId = String(ctx.from!.id);
    const locale = getLocale(ctx); // sender's locale for status messages
    const shared = msg.users_shared as { request_id: number; users: Array<{ user_id: number; first_name?: string }> };

    logger.info(
      { senderTgId, requestId: shared.request_id, selectedCount: shared.users.length },
      'hint_users_shared_received',
    );

    // Find sender's most recent active hint (created in the producer's
    // idempotency window). HINT_LOOKUP_WINDOW_MS is shared with the API's
    // POST /tg/items/:id/hint so producer and consumer never drift —
    // see 2026-05-03 BUGFIX_LESSONS entry.
    const lookupWindowStart = new Date(Date.now() - HINT_LOOKUP_WINDOW_MS);
    const sender = await prisma.user.findUnique({ where: { telegramId: senderTgId }, select: { id: true } });
    if (!sender) {
      await ctx.reply(t('bot_users_shared_no_profile', locale), Markup.removeKeyboard());
      return;
    }

    const hint = await prisma.hint.findFirst({
      where: { senderUserId: sender.id, status: 'SENT', createdAt: { gte: lookupWindowStart } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        item: {
          select: {
            id: true, title: true, status: true,
            wishlist: { select: { slug: true, ownerId: true } },
          },
        },
      },
    });

    if (!hint) {
      // Telegram occasionally fires users_shared twice for one user-side
      // action (rapid re-tap of the request_users keyboard, or a transport
      // retry on the client). The first event marks the hint DELIVERED;
      // the second arrives with no SENT hint left and used to error out
      // with "Активный намёк не найден" in the sender's chat — confusing
      // because the first message already confirmed delivery.
      //
      // Detect the duplicate: a hint from this sender DELIVERED in the last
      // 60 s means we just processed the first event. Silently swallow.
      const recentlyDelivered = await prisma.hint.findFirst({
        where: {
          senderUserId: sender.id,
          status: 'DELIVERED',
          deliveredAt: { gte: new Date(Date.now() - 60_000) },
        },
        select: { id: true },
      });
      if (recentlyDelivered) {
        logger.info(
          { senderId: sender.id, hintId: recentlyDelivered.id },
          'users_shared: ignoring duplicate event for recently delivered hint',
        );
        return;
      }
      await ctx.reply(t('bot_users_shared_no_hint', locale), Markup.removeKeyboard());
      return;
    }

    if (hint.item.status !== 'AVAILABLE') {
      await ctx.reply(t('bot_users_shared_reserved', locale), Markup.removeKeyboard());
      return;
    }

    // ─── Atomic claim ──────────────────────────────────────────────────────
    // Telegraf processes updates sequentially within one bot.launch instance,
    // but Telegram itself can deliver the same users_shared event twice (long
    // polling retry, client double-fire on rapid keyboard tap, transport
    // quirks). Without an atomic claim BOTH events race past the SENT lookup
    // above, both run the delivery loop, and the second sendMessage to the
    // same recipient gets ok=false from Telegram (rate-limit / dedup) → the
    // second event posts "Не удалось отправить напрямую: 1" + fallback even
    // though the first message was actually delivered (sentCount=1 then
    // overwritten to sentCount=0,pendingCount=1 by the loser's update).
    //
    // Observed: 2026-05-01 17:22 hint cmon6l3ms — single API hint POST,
    // single keyboard sent, but two summary replies in sender chat and DB
    // ended up with sentCount=0,pendingCount=1.
    //
    // Fix: flip status SENT → DELIVERED in one row-level UPDATE. Only the
    // first event's claim returns count=1; all later events get count=0 and
    // silent-return. The recipient-side sendMessage runs at most once per
    // hint, so the sender sees one summary and one decision.
    const claim = await prisma.hint.updateMany({
      where: { id: hint.id, status: 'SENT' },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    if (claim.count === 0) {
      logger.info(
        { hintId: hint.id, senderTgId, requestId: shared.request_id },
        'users_shared: hint already claimed by concurrent event, skipping',
      );
      return;
    }

    // The hint just transitioned SENT → DELIVERED — the friend-picker was
    // completed and this event won the claim. Per the contract (spec point 1)
    // the FREE quota is spent on that DELIVERED status transition: when the
    // user completes the picker — NOT on wave creation, and NOT gated on how
    // many recipient DMs the loop below lands. A picker can complete with zero
    // direct sends (every recipient unreachable) and the sender still gets a
    // forwardable link, so the scenario is "done" either way. A hint that
    // never reaches DELIVERED (picker abandoned → stays SENT → CANCELLED /
    // EXPIRED) is never charged. Fire-and-forget — never blocks the delivery
    // loop below — with a bounded idempotent retry inside chargeDeliveredHint;
    // a charge lost after all retries fails OPEN (the user keeps the hint).
    // See apps/api POST /internal/hints/credit + services/hint-credits.ts.
    void chargeDeliveredHint(hint.id, API_BASE_URL, token!);

    // Resolve owner name for the hint message
    const owner = await prisma.user.findUnique({
      where: { id: hint.item.wishlist.ownerId },
      select: { firstName: true, telegramId: true, telegramChatId: true },
    });
    // Owner name fallback: use 'en' as default since we don't know recipient locale yet
    let ownerName = owner?.firstName || t('api_user_fallback', 'en');
    if (!owner?.firstName && owner?.telegramChatId) {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${owner.telegramChatId}`);
        const data = await resp.json() as { ok: boolean; result?: { first_name?: string } };
        if (data.ok && data.result?.first_name) {
          ownerName = data.result.first_name;
          await prisma.user.update({ where: { id: hint.item.wishlist.ownerId }, data: { firstName: data.result.first_name } }).catch(() => {});
        }
      } catch { /* fallback */ }
    }
    const shortName = ownerName.split(' ')[0] ?? ownerName;

    let directSent = 0;
    let pendingCount = 0;

    // Intra-event recipient dedup. shared.users could legitimately contain
    // the same user_id twice if the picker fires multiple chips for one
    // contact, or if the user accidentally tapped the same person twice.
    // Without dedup, the second sendMessage to the same chat_id usually
    // returns ok=false (TG dedup/rate-limit), inflating pendingCount and
    // triggering a fallback that shouldn't apply.
    const seenRecipients = new Set<string>();

    logger.info(
      {
        hintId: hint.id,
        senderTgId,
        requestId: shared.request_id,
        selectedCount: shared.users.length,
      },
      'users_shared: starting delivery',
    );

    for (const u of shared.users) {
      const recipientTgId = String(u.user_id);
      if (seenRecipients.has(recipientTgId)) continue;
      seenRecipients.add(recipientTgId);
      // Skip self-send
      if (recipientTgId === senderTgId) continue;
      // Skip if recipient is the owner themselves (edge case)
      if (owner?.telegramId === recipientTgId) continue;

      // Look up whether we already know this recipient + their persisted
      // language settings (sender's request locale is irrelevant — recipient
      // is whoever the sender picked from the user-share dialog). For known
      // recipients (any prior /start or Mini App touch), the resolver chain
      // gives manual override → persisted normalizedLocale → legacy raw →
      // 'en'. Cold-start unknown recipients fall through to 'en' default.
      const knownRecipient = await prisma.user.findUnique({
        where: { telegramId: recipientTgId },
        select: {
          telegramChatId: true,
          profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
        },
      }).catch(() => null);
      const { locale: recipientLocale, source: recipientLocaleSource } = resolveLocaleWithSource(
        profileToLanguageSettings(knownRecipient?.profile ?? null),
      );
      const hintText = t('bot_hint_msg', recipientLocale, { owner: ownerName, title: hint.item.title, shortName: shortName.toLowerCase() });
      logger.debug({ hintId: hint.id, recipientTgId, locale: recipientLocale, localeSource: recipientLocaleSource }, 'users_shared: recipient locale resolved');

      // Try direct bot delivery — retry on network failure to ride out the
      // VPS↔Telegram path flaps (RKN-blocked IPv4 + deprecated IPv6 source
      // currently give ~40-60% success per attempt). 3 attempts × 5 s gives
      // ~92% expected success vs 40% with one shot. Telegram-side rejections
      // (data.ok === false) are NOT retried — those are deterministic.
      let directOk = false;
      let tgDescription: string | null = null;
      const sendBody = JSON.stringify({
        chat_id: u.user_id,
        text: hintText,
        reply_markup: {
          inline_keyboard: [[
            { text: t('bot_hint_view_btn', recipientLocale), web_app: { url: `${MINI_APP_URL}?startapp=${hint.item.wishlist.slug}__item_${hint.item.id}` } },
          ]],
        },
      });
      const SEND_TIMEOUT_MS = 5000;
      const SEND_MAX_ATTEMPTS = 3;
      let attemptError: string | null = null;
      let lastHttpStatus: number | null = null;
      let tgErrorCode: number | null = null;
      let networkErrCode: string | null = null;
      for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
        // (#5) Per-attempt log — emitted before the fetch so a hung attempt
        // is visible while it's hung, not only after timeout.
        const attemptStart = Date.now();
        logger.info(
          {
            hintId: hint.id,
            recipientTgId,
            attempt,
            maxAttempts: SEND_MAX_ATTEMPTS,
            timeoutMs: SEND_TIMEOUT_MS,
          },
          'hint send attempt',
        );
        try {
          const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: sendBody,
            signal: controller.signal,
          });
          clearTimeout(timer);
          lastHttpStatus = resp.status;
          const data = await resp.json() as { ok: boolean; description?: string; error_code?: number };
          directOk = data.ok;
          tgDescription = data.description ?? null;
          tgErrorCode = data.error_code ?? null;
          // (#8) Telegram response — http status + ok/error_code/description.
          // Logged for both success and structured rejection so we can audit
          // what TG actually said.
          logger.info(
            {
              hintId: hint.id,
              recipientTgId,
              attempt,
              httpStatus: lastHttpStatus,
              ok: data.ok,
              tgErrorCode,
              tgDescription,
              elapsedMs: Date.now() - attemptStart,
            },
            data.ok ? 'hint send attempt: telegram accepted' : 'hint send attempt: telegram rejected',
          );
          if (data.ok) {
            directSent++;
            await prisma.user.upsert({
              where: { telegramId: recipientTgId },
              update: { telegramChatId: recipientTgId },
              create: { telegramId: recipientTgId, telegramChatId: recipientTgId },
            }).catch(() => {});
          } else {
            pendingCount++;
          }
          attemptError = null;
          break;
        } catch (err) {
          clearTimeout(timer);
          attemptError = err instanceof Error ? err.message : String(err);
          networkErrCode = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code ?? '') || null : null;
          // (#8) Network-level error — captured without HTTP status (the
          // request never got a response). errCode is the OS errno surfaced
          // by undici (ETIMEDOUT, ECONNRESET, ENOTFOUND, etc).
          logger.warn(
            {
              hintId: hint.id,
              recipientTgId,
              attempt,
              maxAttempts: SEND_MAX_ATTEMPTS,
              errMessage: attemptError,
              errCode: networkErrCode,
              elapsedMs: Date.now() - attemptStart,
            },
            'hint send attempt: network failure',
          );
          if (attempt < SEND_MAX_ATTEMPTS) {
            // (#6) Retry-reason — explicit log so we can see *why* we're
            // retrying separately from the per-attempt failure above.
            const backoffMs = 500;
            logger.info(
              {
                hintId: hint.id,
                recipientTgId,
                fromAttempt: attempt,
                toAttempt: attempt + 1,
                retryReason: networkErrCode ?? 'network_failure',
                backoffMs,
              },
              'hint send: retrying',
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          pendingCount++;
          tgDescription = attemptError;
        }
      }

      // (#7) Final per-recipient outcome — kept for back-compat with any
      // dashboard that already keys off this msg. Augmented with HTTP/TG
      // codes captured during the loop.
      logger.info(
        {
          hintId: hint.id,
          recipientTgId,
          hasKnownChatId: !!knownRecipient?.telegramChatId,
          ok: directOk,
          httpStatus: lastHttpStatus,
          tgErrorCode,
          tgDescription,
          networkErrCode,
        },
        'users_shared: recipient processed',
      );
    }

    // Status was already set to DELIVERED in the atomic claim above; only
    // refresh sentCount/pendingCount with the loop's actual results.
    await prisma.hint.update({
      where: { id: hint.id },
      data: { sentCount: directSent, pendingCount },
    }).catch((err) => {
      logger.error({ err, hintId: hint.id }, 'failed to update hint delivery counts');
    });

    logger.info(
      {
        hintId: hint.id,
        senderTgId,
        directSent,
        pendingCount,
        uniqueRecipients: seenRecipients.size,
      },
      'users_shared: delivery complete',
    );

    // Summary to sender (uses sender's locale)
    const parts: string[] = [];
    if (directSent > 0) {
      const contactWord = getHintContactWord(directSent, locale);
      parts.push(t('bot_sent_count', locale, { n: directSent, contactWord }));
    }
    if (pendingCount > 0) parts.push(t('bot_pending_count', locale, { n: pendingCount }));
    if (parts.length === 0) parts.push(t('bot_no_recipients', locale));

    await ctx.reply(parts.join('\n'), Markup.removeKeyboard());

    // Fallback for pending: explanation message + a separate forwardable
    // template the sender can long-press → forward to the friend manually.
    // Two-message structure replaces the previous single message that
    // confusingly mixed instructions and the link in one body.
    if (pendingCount > 0) {
      const botInfo = await bot.telegram.getMe();
      const deepLink = `https://t.me/${botInfo.username}?start=hint_${hint.item.id}`;
      await ctx.reply(t('bot_fallback_msg', locale));
      await ctx.reply(t('bot_fallback_forward_template', locale, { link: deepLink }));
    }
  });

  // ─── Support flow handler ────────────────────────────────────────────────
  // Intercepts:
  //   1. All messages from the support chat (SUPPORT_CHAT_ID)
  //   2. User replies to a support ForceReply prompt → create ticket
  //   3. User replies to a bot support message → follow-up on existing ticket
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message as any;
    if (!msg || !ctx.from) return next();

    const chatId = String(ctx.chat.id);

    // ── Handle messages from support chat ──────────────────────────────────
    if (SUPPORT_CHAT_ID && chatId === SUPPORT_CHAT_ID) {
      await handleSupportChatMessage(ctx);
      return; // consumed — don't fall through to URL import handler
    }

    // ── Handle user messages in private chat ─────────────────────────────
    const replyToId: number | null = msg.reply_to_message
      ? (msg.reply_to_message as { message_id: number }).message_id
      : null;

    if (replyToId) {
      // Case 1: Reply to a ForceReply support prompt → create new ticket
      const session = await prisma.supportSession.findFirst({
        where: {
          telegramChatId: chatId,
          promptMessageId: replyToId,
          expiresAt: { gte: new Date() },
        },
      });
      if (session) {
        // Consume the session so it can't be used again
        await prisma.supportSession.delete({ where: { id: session.id } }).catch(() => {});
        await handleCreateTicket(ctx);
        return;
      }

      // Case 2: Reply to a bot support message (support reply sent to user) → follow-up
      const linkedMsg = await prisma.supportMessage.findFirst({
        where: { telegramUserChatId: chatId, telegramUserMsgId: replyToId },
        include: { ticket: true },
      });
      if (linkedMsg) {
        const ticket = linkedMsg.ticket;
        const locale = getLocale(ctx);
        if (ticket.status === 'CLOSED') {
          await ctx.reply(t('support_ticket_closed', locale, { code: ticket.ticketCode }));
        } else {
          await handleUserFollowUp(ctx, ticket);
        }
        return;
      }
    }

    // Case 3: User has an open ticket → any non-URL, non-command message is a follow-up
    const msgText: string = 'text' in msg ? String((msg as any).text || '') : '';
    const looksLikeUrl = /^https?:\/\/\S+$/i.test(msgText.trim());
    const isCommand = msgText.startsWith('/');
    if (!looksLikeUrl && !isCommand) {
      const openTicket = await prisma.supportTicket.findFirst({
        where: { user: { telegramChatId: chatId }, status: { notIn: ['CLOSED'] } },
      });
      if (openTicket) {
        await handleUserFollowUp(ctx, openTicket);
        return;
      }
    }

    return next();
  });

  // ─── URL import: text message handler ────────────────────────────────────
  const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // skip commands

    const locale = getLocale(ctx);

    const urls = text.match(URL_REGEX);
    if (!urls || urls.length === 0) return; // no URL — stay silent

    const firstUrl = urls[0];

    // Multiple URLs — warn
    if (urls.length > 1) {
      await ctx.reply(t('bot_multiple_urls', locale));
    }

    // Text without URL = user note
    const note = text.replace(URL_REGEX, '').trim() || undefined;

    // Show typing indicator while parsing
    await ctx.sendChatAction('typing');

    // Upsert user
    const telegramId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    const user = await prisma.user.upsert({
      where: { telegramId },
      update: { telegramChatId: chatId },
      create: { telegramId, telegramChatId: chatId },
    });

    try {
      const res = await fetch(`${API_BASE_URL}/internal/import-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-INTERNAL-KEY': token!,
        },
        body: JSON.stringify({ userId: user.id, url: firstUrl, note, source: 'bot' }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; feature?: string };
        if (res.status === 402) {
          const isProGate = body.feature === 'url_import' || body.error === 'Pro feature';
          if (isProGate) {
            await ctx.reply(t('bot_import_pro_required', locale), Markup.inlineKeyboard([
              Markup.button.webApp(t('bot_import_pro_btn', locale), `${MINI_APP_URL}?startapp=upgrade_pro`),
            ]));
          } else {
            await ctx.reply(t('bot_import_drafts_full', locale));
          }
          logger.info({ telegramId, url: firstUrl, reason: isProGate ? 'pro_required' : 'drafts_full' }, 'bot import rejected');
          return;
        }
        if (res.status === 400) {
          await ctx.reply(body.error || t('bot_import_error', locale));
          logger.info({ telegramId, url: firstUrl, status: 400, error: body.error }, 'bot import failed');
          return;
        }
        await ctx.reply(t('bot_import_error_retry', locale));
        logger.warn({ telegramId, url: firstUrl, status: res.status }, 'bot import error');
        return;
      }

      const { item, parseStatus } = await res.json() as {
        item: { id: string; title: string; sourceDomain: string | null; price: number | null };
        parseStatus: string;
      };

      const priceFmtLocale = localeToBCP47(locale);
      let msg = `${t('bot_import_success', locale)}\n\n`;
      msg += `<b>${escapeHtml(item.title)}</b>`;
      if (item.sourceDomain) msg += `\n🔗 ${escapeHtml(item.sourceDomain)}`;
      if (item.price) msg += `\n💰 ${Number(item.price).toLocaleString(priceFmtLocale)} ₽`;

      if (parseStatus === 'failed') {
        msg += `\n\n${t('bot_import_parse_failed', locale)}`;
      } else if (parseStatus === 'partial') {
        msg += `\n\n${t('bot_import_parse_partial', locale)}`;
      }

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          Markup.button.webApp(t('bot_import_open', locale), `${MINI_APP_URL}?startapp=draft_${item.id}`),
        ]),
      });
      logger.info({ telegramId, url: firstUrl, itemId: item.id, domain: item.sourceDomain, parseStatus }, 'bot import succeeded');
    } catch (err) {
      logger.error({ err }, 'import-url error');
      await ctx.reply(t('bot_error', locale)).catch(() => {});
    }
  });

  // Transient error detection — shared by retryTgApi and launchBot.
  //
  // node-fetch's FetchError stashes the OS errno in .code/.errno but the
  // .message field is just `request to ... failed, reason: ` — so a regex
  // over the message alone misses ETIMEDOUT/ECONNRESET/etc. coming from
  // FetchError. We MUST check the error's .code and .errno fields too;
  // otherwise launchBot misclassifies a temp IPv6-route flap as a fatal
  // error and exits, instead of using the in-process retry budget.
  // (See incident 2026-04-26 14:30–14:37 UTC: 4 process restarts back-to-
  // back during a deploy because every ETIMEDOUT was tagged transient:false.)
  const TRANSIENT_CODE_RE = /^E(TIMEDOUT|CONNRESET|CONNREFUSED|HOSTUNREACH|NETUNREACH|NOTFOUND|AI_AGAIN|PIPE)$/;
  function isTransientError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === 'AbortError') return true;
    const msg = err.message;
    const code = (err as { code?: unknown }).code;
    const errno = (err as { errno?: unknown }).errno;
    if (typeof code === 'string' && TRANSIENT_CODE_RE.test(code)) return true;
    if (typeof errno === 'string' && TRANSIENT_CODE_RE.test(errno)) return true;
    return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|network/i.test(msg) ||
      ('code' in err && typeof (err as any).code === 'number' && (err as any).code >= 500);
  }

  const STARTUP_TG_CONFIG_TIMEOUT_MS = 15_000;
  type TgCallApiOptions = NonNullable<Parameters<typeof bot.telegram.callApi>[2]>;

  function startupTgApiOptions(): TgCallApiOptions {
    return {
      signal: AbortSignal.timeout(STARTUP_TG_CONFIG_TIMEOUT_MS) as TgCallApiOptions['signal'],
    };
  }

  function redactTelegramToken(value: string): string {
    return token ? value.split(token).join('[REDACTED]') : value;
  }

  function telegramErrorSummary(err: unknown): { errCode: string | null; errMessage: string } {
    if (!(err instanceof Error)) return { errCode: null, errMessage: redactTelegramToken(String(err)) };
    const code = (err as { code?: unknown }).code;
    const errno = (err as { errno?: unknown }).errno;
    const errCode = typeof code === 'string' && code
      ? code
      : typeof errno === 'string' && errno
        ? errno
        : typeof code === 'number'
          ? String(code)
          : err.name && err.name !== 'Error'
            ? err.name
            : null;
    return { errCode, errMessage: redactTelegramToken(err.message) };
  }

  // Retry helper for Telegram API calls — exponential backoff on transient errors.
  // `bestEffort: true` downgrades final-failure log level from error→info, used
  // for cosmetic startup calls (setMyCommands/setMyDescription) where a TG-side
  // timeout doesn't impact users — they'd just see the previous-set value.
  // Without this, every container restart during an IPv4 RKN block produces
  // 4-12 `level:50 "telegram API call failed"` lines that look like real fails
  // in `grep -E "level":50` log audits.
  async function retryTgApi<T>(
    label: string,
    fn: () => Promise<T>,
    opts: { maxAttempts?: number; bestEffort?: boolean } | number = {},
  ): Promise<T | undefined> {
    // Backwards-compat: a numeric arg is the legacy maxAttempts param.
    const { maxAttempts = 3, bestEffort = false } = typeof opts === 'number'
      ? { maxAttempts: opts, bestEffort: false }
      : opts;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const transient = isTransientError(err);
        const errSummary = telegramErrorSummary(err);
        if (!transient || attempt === maxAttempts) {
          if (bestEffort && transient) {
            logger.info({ ...errSummary, label, attempt, bestEffort }, 'telegram API call failed (best-effort, ignored)');
          } else {
            logger.error({ err, ...errSummary, label, attempt, transient, bestEffort }, 'telegram API call failed');
          }
          return undefined;
        }
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        const retryMeta = { ...errSummary, label, attempt, nextRetryMs: delay, transient, bestEffort };
        if (bestEffort) {
          logger.info(retryMeta, 'telegram API call failed, retrying');
        } else {
          logger.warn(retryMeta, 'telegram API call failed, retrying');
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return undefined;
  }

  // Set bot commands for default (English) and Russian locales.
  // bestEffort: cosmetic startup config — a transient timeout shouldn't fail-loud.
  void retryTgApi('setChatMenuButton:default', () =>
    bot.telegram.callApi('setChatMenuButton', {
      menu_button: menuButton,
    }, startupTgApiOptions()),
    { bestEffort: true },
  );

  void retryTgApi('setMyCommands:en', () =>
    bot.telegram.callApi('setMyCommands', {
      commands: [
        { command: 'start', description: t('bot_cmd_start', 'en') },
        { command: 'support', description: t('bot_cmd_support', 'en') },
        { command: 'paysupport', description: t('bot_cmd_paysupport', 'en') },
      ],
    }, startupTgApiOptions()),
    { bestEffort: true },
  );

  void retryTgApi('setMyCommands:ru', () =>
    bot.telegram.callApi('setMyCommands', {
      commands: [
        { command: 'start', description: t('bot_cmd_start', 'ru') },
        { command: 'support', description: t('bot_cmd_support', 'ru') },
        { command: 'paysupport', description: t('bot_cmd_paysupport', 'ru') },
      ],
      language_code: 'ru',
    }, startupTgApiOptions()),
    { bestEffort: true },
  );

  // Set bot description for all supported locales (shown in "What can this bot do?").
  // Default (no language_code) = English as fallback for unsupported locales.
  const descriptionLocales: Array<{ locale: Locale; tgCode: string | undefined }> = [
    { locale: 'en', tgCode: undefined },
    { locale: 'ru', tgCode: 'ru' },
    { locale: 'zh-CN', tgCode: 'zh' },
    { locale: 'hi', tgCode: 'hi' },
    { locale: 'es', tgCode: 'es' },
    { locale: 'ar', tgCode: 'ar' },
  ];
  for (const { locale, tgCode } of descriptionLocales) {
    void retryTgApi(`setMyDescription:${tgCode ?? 'default'}`, () =>
      bot.telegram.callApi('setMyDescription', {
        description: t('bot_description', locale),
        ...(tgCode ? { language_code: tgCode } : {}),
      } as Parameters<typeof bot.telegram.callApi>[1], startupTgApiOptions()),
      { bestEffort: true },
    );
  }

  // Heartbeat: update every 60 s so /health/deep can detect bot absence.
  // Paused during launch retries so zombies can't fake health; resumed on success.
  void updateHeartbeat();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => void updateHeartbeat(), 60_000);

  function pauseHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }
  function resumeHeartbeat() {
    if (!heartbeatTimer) { heartbeatTimer = setInterval(() => void updateHeartbeat(), 60_000); }
  }

  // ─── Launch with retry ───────────────────────────────────────────────────
  // bot.launch() resolves when polling STOPS (on SIGTERM), not on start.
  // On transient failures (ETIMEDOUT, ECONNRESET) we retry in-process with
  // exponential backoff (1s → 2s → 4s → 8s → 16s → 32s → 60s cap) instead
  // of process.exit(1) + Docker restart (which adds its own backoff on top).
  // Fatal errors (409 Conflict, 401 Unauthorized) still exit immediately.
  // Total budget: 12 attempts × (~75s OS-level connect timeout + delay) ≈
  // 16 min — covers the worst IPv6-flap windows we've seen post-deploy.
  const MAX_LAUNCH_ATTEMPTS = 12;
  let launchAttempt = 0;
  let shutdownRequested = false;

  async function launchBot(): Promise<void> {
    while (!shutdownRequested) {
      launchAttempt++;
      // Clear stale botInfo from previous failed attempts — Telegraf sets it
      // after getMe() but never clears it. Without this, startupCheck may fire
      // on a stale value before polling is actually active.
      (bot as any).botInfo = undefined;
      // (#2) getMe is the FIRST thing Telegraf does inside bot.launch().
      // We log the attempt start here so we can see "we're trying" even
      // when the call hangs at the network layer with no error yet.
      const launchStart = Date.now();
      logger.info(
        { attempt: launchAttempt, maxAttempts: MAX_LAUNCH_ATTEMPTS },
        'bot launch attempt (getMe pending)',
      );
      try {
        await bot.launch();
        // launch() resolves when polling stops (SIGTERM/SIGINT)
        logger.info('bot stopped gracefully');
        return;
      } catch (err: unknown) {
        if (shutdownRequested) return;

        const transient = isTransientError(err);
        const canRetry = transient && launchAttempt < MAX_LAUNCH_ATTEMPTS;
        const errCode = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code ?? '') || null : null;
        const errMessage = err instanceof Error ? err.message : String(err);

        if (canRetry) {
          const delay = Math.min(1000 * Math.pow(2, launchAttempt - 1), 60_000);
          // (#2) getMe failure (transient) — surfaces err code (ETIMEDOUT,
          // ECONNRESET, EAI_AGAIN, …) and elapsed so we can see whether the
          // call hung the full connect timeout or failed fast.
          logger.warn(
            {
              err,
              errCode,
              errMessage,
              attempt: launchAttempt,
              nextRetryMs: delay,
              elapsedMs: Date.now() - launchStart,
            },
            'bot launch failed, retrying (getMe failed)',
          );
          pauseHeartbeat();
          if (launchAttempt === 1) {
            void sendAdminAlert(`⚠️ <b>Bot launch failed</b> (attempt ${launchAttempt}, retrying in ${delay / 1000}s)\n${String(err)}`);
          }
          await new Promise((r) => setTimeout(r, delay));
        } else {
          // Fatal or exhausted retries — exit and let Docker restart
          logger.fatal(
            { err, errCode, errMessage, attempt: launchAttempt, transient, elapsedMs: Date.now() - launchStart },
            'failed to start (getMe exhausted)',
          );
          if (process.env.GLITCHTIP_DSN && err instanceof Error) Sentry.captureException(err);
          pauseHeartbeat();
          setTimeout(() => process.exit(1), 15_000).unref();
          void sendAdminAlert(`🔴 <b>Bot failed to start</b> (${launchAttempt} attempts)\n${String(err)}`).finally(() => process.exit(1));
          return;
        }
      }
    }
  }

  void launchBot();

  // ─── Startup welcome recovery ──────────────────────────────────────────
  // On startup, find users who never received their welcome message (welcomeSent=false)
  // and deliver it. This covers crashes/network errors during /start handling.
  // Limited to users created in last 7 days to avoid spamming ancient records.
  async function deliverPendingWelcomes(): Promise<void> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const pending = await prisma.user.findMany({
        where: {
          welcomeSent: false,
          telegramChatId: { not: null },
          createdAt: { gte: sevenDaysAgo },
        },
        select: {
          id: true, telegramId: true, telegramChatId: true,
          // Full language settings so we go through the same resolver chain
          // as every other proactive send. New users almost never have
          // manualLanguage set (haven't opened settings yet) — but we honour
          // it if they did, instead of silently overriding.
          profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
        },
      });

      if (pending.length === 0) return;
      logger.info({ count: pending.length }, 'delivering pending welcome messages');

      let sent = 0;
      let blocked = 0;
      let failed = 0;

      for (const user of pending) {
        if (shutdownRequested) break;
        const chatId = user.telegramChatId!;
        const { locale, source: localeSource } = resolveLocaleWithSource(
          profileToLanguageSettings(user.profile),
        );

        try {
          // Send welcome via raw API (not ctx — we're outside an update handler).
          // Mark welcomeSent=true after the first message so partial delivery
          // doesn't cause a full duplicate on the next retry.
          await bot.telegram.sendMessage(chatId, t('bot_start', locale), { link_preview_options: { is_disabled: true } });
          await prisma.user.update({ where: { id: user.id }, data: { welcomeSent: true } });
          await bot.telegram.sendMessage(chatId, t('bot_donation', locale)).catch(() => {});
          sent++;
          logger.info({ telegramId: user.telegramId, locale, localeSource }, 'pending welcome delivered');
        } catch (err: unknown) {
          // 403 = user blocked bot — mark as sent so we don't retry forever
          const is403 = (err instanceof TelegramError && err.code === 403);
          if (is403) {
            await prisma.user.update({ where: { id: user.id }, data: { welcomeSent: true } }).catch(() => {});
            blocked++;
            logger.warn({ telegramId: user.telegramId }, 'user blocked bot, marking welcome as delivered');
          } else {
            failed++;
            logger.error({ err, telegramId: user.telegramId }, 'failed to deliver pending welcome');
          }
        }

        // Small delay between messages to respect Telegram rate limits
        if (pending.length > 1) await new Promise((r) => setTimeout(r, 500));
      }

      logger.info({ sent, blocked, failed }, 'pending welcome delivery complete');
      if (sent > 0 || blocked > 0) {
        void sendAdminAlert(`📬 <b>Pending welcomes</b>: ${sent} sent, ${blocked} blocked, ${failed} failed`);
      }
    } catch (err) {
      logger.error({ err }, 'deliverPendingWelcomes failed');
    }
  }

  // Startup detection — poll for bot.botInfo (set by Telegraf after getMe succeeds).
  // bot.launch() resolves only when polling STOPS, so we can't use .then().
  // .unref() so this interval doesn't prevent process.exit() on fatal errors.
  const startupCheck = setInterval(() => {
    if (shutdownRequested) { clearInterval(startupCheck); return; }
    if (bot.botInfo) {
      clearInterval(startupCheck);
      resumeHeartbeat();
      // (#2) getMe success — Telegraf sets botInfo only after getMe resolves,
      // so this is our proof that getMe succeeded. Include id+username so a
      // grep on this line confirms which bot account is running.
      logger.info(
        {
          attempt: launchAttempt,
          botId: bot.botInfo.id,
          botUsername: bot.botInfo.username,
        },
        'bot polling active (getMe ok)',
      );
      void sendAdminAlert(`🟢 <b>Bot started</b>${launchAttempt > 1 ? ` (after ${launchAttempt} attempts)` : ''}\nEnv: ${process.env.NODE_ENV ?? 'development'}`);
      // Deliver any pending welcome messages from previous failed /start attempts
      void deliverPendingWelcomes();
    }
  }, 2_000);
  startupCheck.unref();

  // Uncaught exception / rejection alerts
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    if (process.env.GLITCHTIP_DSN) Sentry.captureException(err);
    setTimeout(() => process.exit(1), 15_000).unref();
    void sendAdminAlert(`🔴 <b>Bot uncaughtException</b>\n${String(err)}`).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection');
    if (process.env.GLITCHTIP_DSN && reason instanceof Error) Sentry.captureException(reason);
    void sendAdminAlert(`🔴 <b>Bot unhandledRejection</b>\n${String(reason)}`);
  });

  // Graceful shutdown — set flag to abort retry loop, then stop bot.
  // Guards against "Bot is not running!" when SIGTERM arrives during getMe timeout.
  // Do NOT process.exit(0) on the catch — exit code 0 prevents Docker restart.
  // Instead let launchBot() check shutdownRequested and return naturally.
  const gracefulStop = (signal: string) => {
    shutdownRequested = true;
    try { bot.stop(signal); } catch { /* not running yet — launchBot will exit via flag */ }
  };
  process.once('SIGINT', () => gracefulStop('SIGINT'));
  process.once('SIGTERM', () => gracefulStop('SIGTERM'));
}
