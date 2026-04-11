import dns from 'node:dns';
// Prefer IPv6 for Telegram API — Timeweb VPS periodically loses IPv4 connectivity
// to Telegram DC2 (149.154.166.110) while IPv6 (2001:67c:4e8:f004::9) stays up.
dns.setDefaultResultOrder('ipv6first');

import dotenv from 'dotenv';
import { Telegraf, Markup, TelegramError } from 'telegraf';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@wishlist/db';
import { t, detectLocale, resolveEffectiveLocale, type Locale } from '@wishlist/shared';
import logger from './logger';

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
  const bot = new Telegraf(token);

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
      include: { ticket: { include: { user: { select: { telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true } } } } } } },
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

    const userLocale = resolveEffectiveLocale(
      ticket.user.profile ? { languageMode: ticket.user.profile.languageMode as any, manualLanguage: ticket.user.profile.manualLanguage as any } : null,
    );
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
      include: { ticket: { include: { user: { select: { telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true } } } } } } },
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
      const userLocale = resolveEffectiveLocale(
        ticket.user.profile ? { languageMode: ticket.user.profile.languageMode as any, manualLanguage: ticket.user.profile.manualLanguage as any } : null,
      );
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
      include: { user: { select: { telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true } } } } },
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
      const userLocale = resolveEffectiveLocale(
        ticket.user.profile ? { languageMode: ticket.user.profile.languageMode as any, manualLanguage: ticket.user.profile.manualLanguage as any } : null,
      );
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

  // Set the persistent menu button (bottom-left "Wishlist" button)
  bot.telegram
    .setChatMenuButton({
      menuButton: {
        type: 'web_app',
        text: 'Wishlist',
        web_app: { url: MINI_APP_URL },
      },
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'failed to set menu button');
    });

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
    // Upsert user with welcomeSent=false on both create AND update.
    //  - create: brand-new user, hasn't received welcome yet
    //  - update: user may have been pre-created by Mini App (API getOrCreateTgUser)
    //    with welcomeSent=true (default), so /start must reset to false to track delivery
    // welcomeSent is set back to true after successful message delivery below.
    await prisma.user.upsert({
      where: { telegramId },
      update: { telegramChatId: chatId, welcomeSent: false },
      create: { telegramId, telegramChatId: chatId, welcomeSent: false },
    }).catch((err) => {
      logger.warn({ err, telegramId }, 'user upsert failed in /start');
    });

    // Fire-and-forget analytics
    prisma.analyticsEvent.create({
      data: {
        event: 'bot.start_received',
        userId: String(ctx.from.id),
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

      if (payloadType === 'pro_monthly') {
        // pro_monthly:<telegramId>:<uuid>
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
        const KNOWN_SKUS = new Set([
          'extra_wishlist_slot', 'extra_subscription_slot',
          'extra_items_5', 'extra_items_15',
          'hints_pack_5', 'hints_pack_10',
          'import_pack_10', 'import_pack_25',
          'seasonal_decoration',
          'gift_notes_unlock',
          'reservation_pro_unlock',
        ]);
        if (!skuCode || !KNOWN_SKUS.has(skuCode)) {
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

    const payment = msg.successful_payment as Record<string, unknown> & {
      telegram_payment_charge_id: string;
      provider_payment_charge_id?: string;
      invoice_payload: string;
      total_amount: number;
      currency: string;
      subscription_expiration_date?: number;
    };

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
        const providerChargeId = payment.provider_payment_charge_id ?? null;

        // Idempotency: skip duplicate webhook
        const existing = await prisma.paymentEvent.findUnique({ where: { telegramPaymentChargeId: chargeId } });
        if (existing) {
          logger.info({ chargeId }, 'duplicate payment, skip');
          return;
        }

        const now = new Date();
        const periodEnd = payment.subscription_expiration_date
          ? new Date(payment.subscription_expiration_date * 1000)
          : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        await prisma.$transaction(async (tx) => {
          const sub = await tx.subscription.upsert({
            where: { userId_planCode: { userId: user.id, planCode: 'PRO' } },
            create: {
              userId: user.id,
              planCode: 'PRO',
              status: 'ACTIVE',
              starsPrice: payment.total_amount,
              telegramChargeId: chargeId,
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
              source: 'telegram_stars',
              billingPeriod: 'monthly',
              cancelAtPeriodEnd: false,
            },
            update: {
              status: 'ACTIVE',
              starsPrice: payment.total_amount,
              telegramChargeId: chargeId,
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
              cancelledAt: null,
              cancelAtPeriodEnd: false,
              source: 'telegram_stars',
              billingPeriod: 'monthly',
            },
          });
          await tx.paymentEvent.create({
            data: {
              subscriptionId: sub.id,
              userId: user.id,
              telegramPaymentChargeId: chargeId,
              providerPaymentChargeId: providerChargeId,
              invoicePayload: payment.invoice_payload,
              totalAmount: payment.total_amount,
              currency: payment.currency,
              eventType: 'payment_success',
              rawPayload: JSON.stringify(payment),
            },
          });
        });

        const locale = getLocale(ctx);
        const dateFmtLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
        const fmtDate = periodEnd.toLocaleDateString(dateFmtLocale, { day: 'numeric', month: 'long', year: 'numeric' });
        await ctx.reply(
          t('bot_pro_activated', locale, { date: fmtDate }),
          Markup.inlineKeyboard([Markup.button.webApp(t('bot_open_app', locale), MINI_APP_URL)]),
        );
        logger.info({ userId: user.id, chargeId, periodEnd: periodEnd.toISOString() }, 'subscription activated');
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

        // Idempotency via Purchase table
        const existingPurchase = await prisma.purchase.findUnique({ where: { telegramChargeId: chargeId } });
        if (existingPurchase) {
          logger.info({ chargeId }, 'duplicate addon payment, skip');
          return;
        }

        // SKU type lookup (replicated constants to avoid cross-app imports)
        const SKU_ADDON_TYPES: Record<string, string | null> = {
          extra_wishlist_slot: 'wishlist_slot',
          extra_subscription_slot: 'subscription_slot',
          extra_items_5: 'item_slot_5',
          extra_items_15: 'item_slot_15',
          seasonal_decoration: 'seasonal_decoration',
          gift_notes_unlock: 'gift_notes_unlock',
          reservation_pro_unlock: 'reservation_pro_unlock',
          group_gift_unlock: 'group_gift_unlock',
        };
        const SKU_CREDITS: Record<string, { key: 'hintCredits' | 'importCredits'; amount: number }> = {
          hints_pack_5:   { key: 'hintCredits',   amount: 5  },
          hints_pack_10:  { key: 'hintCredits',   amount: 10 },
          import_pack_10: { key: 'importCredits', amount: 10 },
          import_pack_25: { key: 'importCredits', amount: 25 },
        };
        const SKU_PRICES: Record<string, number> = {
          extra_wishlist_slot: 39, extra_subscription_slot: 25,
          extra_items_5: 19, extra_items_15: 39,
          hints_pack_5: 29, hints_pack_10: 49,
          import_pack_10: 39, import_pack_25: 79,
          seasonal_decoration: 29,
          gift_notes_unlock: 19,
          reservation_pro_unlock: 50,
          group_gift_unlock: 79,
        };

        await prisma.$transaction(async (tx) => {
          // 1. Record the purchase (idempotency log)
          await tx.purchase.create({
            data: {
              userId: user.id,
              skuCode,
              quantity: 1,
              targetId,
              starsPrice: payment.total_amount,
              telegramChargeId: chargeId,
              invoicePayload: payment.invoice_payload,
              status: 'completed',
            },
          });

          // 2. Log payment event for history
          await tx.paymentEvent.create({
            data: {
              userId: user.id,
              telegramPaymentChargeId: chargeId,
              providerPaymentChargeId: payment.provider_payment_charge_id ?? null,
              invoicePayload: payment.invoice_payload,
              totalAmount: payment.total_amount,
              currency: payment.currency,
              eventType: 'addon_payment_success',
              rawPayload: JSON.stringify(payment),
            },
          });

          // 3a. Permanent add-on
          const addonType = SKU_ADDON_TYPES[skuCode];
          if (addonType != null) {
            const quantity = skuCode === 'extra_items_5' ? 5 : skuCode === 'extra_items_15' ? 15 : 1;
            await tx.userAddOn.create({
              data: { userId: user.id, addonType, quantity, targetId },
            });
          }

          // 3b. Consumable credits
          const creditInfo = SKU_CREDITS[skuCode];
          if (creditInfo) {
            await tx.userCredits.upsert({
              where: { userId: user.id },
              create: {
                userId: user.id,
                hintCredits: creditInfo.key === 'hintCredits' ? creditInfo.amount : 0,
                importCredits: creditInfo.key === 'importCredits' ? creditInfo.amount : 0,
              },
              update: { [creditInfo.key]: { increment: creditInfo.amount } },
            });
          }
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

    // Find sender's most recent active hint (created in last 30 min)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const sender = await prisma.user.findUnique({ where: { telegramId: senderTgId }, select: { id: true } });
    if (!sender) {
      await ctx.reply(t('bot_users_shared_no_profile', locale), Markup.removeKeyboard());
      return;
    }

    const hint = await prisma.hint.findFirst({
      where: { senderUserId: sender.id, status: 'SENT', createdAt: { gte: thirtyMinAgo } },
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
      await ctx.reply(t('bot_users_shared_no_hint', locale), Markup.removeKeyboard());
      return;
    }

    if (hint.item.status !== 'AVAILABLE') {
      await ctx.reply(t('bot_users_shared_reserved', locale), Markup.removeKeyboard());
      return;
    }

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

    for (const u of shared.users) {
      const recipientTgId = String(u.user_id);
      // Skip self-send
      if (recipientTgId === senderTgId) continue;
      // Skip if recipient is the owner themselves (edge case)
      if (owner?.telegramId === recipientTgId) continue;

      // Recipient locale: not available from users_shared, default to 'en'
      const recipientLocale: Locale = 'en';
      const hintText = t('bot_hint_msg', recipientLocale, { owner: ownerName, title: hint.item.title, shortName: shortName.toLowerCase() });

      // Try direct bot delivery
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: u.user_id,
            text: hintText,
            reply_markup: {
              inline_keyboard: [[
                { text: t('bot_hint_view_btn', recipientLocale), web_app: { url: `${MINI_APP_URL}?startapp=${hint.item.wishlist.slug}__item_${hint.item.id}` } },
              ]],
            },
          }),
        });
        const data = await resp.json() as { ok: boolean };
        if (data.ok) {
          directSent++;
          // Ensure recipient in DB
          await prisma.user.upsert({
            where: { telegramId: recipientTgId },
            update: { telegramChatId: recipientTgId },
            create: { telegramId: recipientTgId, telegramChatId: recipientTgId },
          }).catch(() => {});
        } else {
          pendingCount++;
        }
      } catch {
        pendingCount++;
      }
    }

    // Save delivery results to Hint record (for mini app polling)
    await prisma.hint.update({
      where: { id: hint.id },
      data: { status: 'DELIVERED', sentCount: directSent, pendingCount, deliveredAt: new Date() },
    }).catch((err) => {
      logger.error({ err, hintId: hint.id }, 'failed to update hint delivery status');
    });

    // Summary to sender (uses sender's locale)
    const parts: string[] = [];
    if (directSent > 0) parts.push(t('bot_sent_count', locale, { n: directSent }));
    if (pendingCount > 0) parts.push(t('bot_pending_count', locale, { n: pendingCount }));
    if (parts.length === 0) parts.push(t('bot_no_recipients', locale));

    await ctx.reply(parts.join('\n'), Markup.removeKeyboard());

    // Fallback for pending: send deep link template
    if (pendingCount > 0) {
      const botInfo = await bot.telegram.getMe();
      const deepLink = `https://t.me/${botInfo.username}?start=hint_${hint.item.id}`;
      await ctx.reply(t('bot_fallback_msg', locale, { link: deepLink }));
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
        const body = await res.json().catch(() => ({})) as { error?: string };
        if (res.status === 402) {
          await ctx.reply(t('bot_import_drafts_full', locale));
          logger.info({ telegramId, url: firstUrl, reason: 'drafts_full' }, 'bot import rejected');
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

      const priceFmtLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
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
  function isTransientError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|timeout|network/i.test(msg) ||
      ('code' in err && typeof (err as any).code === 'number' && (err as any).code >= 500);
  }

  // Retry helper for Telegram API calls — exponential backoff on transient errors.
  async function retryTgApi<T>(label: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T | undefined> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        if (!isTransientError(err) || attempt === maxAttempts) {
          logger.error({ err, label, attempt }, 'telegram API call failed');
          return undefined;
        }
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        logger.warn({ label, attempt, nextRetryMs: delay }, 'telegram API call failed, retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return undefined;
  }

  // Set bot commands for default (English) and Russian locales
  void retryTgApi('setMyCommands:en', () =>
    bot.telegram.setMyCommands([
      { command: 'start', description: t('bot_cmd_start', 'en') },
      { command: 'support', description: t('bot_cmd_support', 'en') },
      { command: 'paysupport', description: t('bot_cmd_paysupport', 'en') },
    ]),
  );

  void retryTgApi('setMyCommands:ru', () =>
    bot.telegram.setMyCommands(
      [
        { command: 'start', description: t('bot_cmd_start', 'ru') },
        { command: 'support', description: t('bot_cmd_support', 'ru') },
        { command: 'paysupport', description: t('bot_cmd_paysupport', 'ru') },
      ],
      { language_code: 'ru' },
    ),
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
      } as Parameters<typeof bot.telegram.callApi>[1]),
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
  // exponential backoff (5s → 10s → 20s → 40s → 60s cap) instead of
  // process.exit(1) + Docker restart (which adds its own backoff on top).
  // Fatal errors (409 Conflict, 401 Unauthorized) still exit immediately.
  const MAX_LAUNCH_ATTEMPTS = 10;
  let launchAttempt = 0;
  let shutdownRequested = false;

  async function launchBot(): Promise<void> {
    while (!shutdownRequested) {
      launchAttempt++;
      // Clear stale botInfo from previous failed attempts — Telegraf sets it
      // after getMe() but never clears it. Without this, startupCheck may fire
      // on a stale value before polling is actually active.
      (bot as any).botInfo = undefined;
      try {
        await bot.launch();
        // launch() resolves when polling stops (SIGTERM/SIGINT)
        logger.info('bot stopped gracefully');
        return;
      } catch (err: unknown) {
        if (shutdownRequested) return;

        const transient = isTransientError(err);
        const canRetry = transient && launchAttempt < MAX_LAUNCH_ATTEMPTS;

        if (canRetry) {
          const delay = Math.min(5000 * Math.pow(2, launchAttempt - 1), 60_000);
          logger.warn({ err, attempt: launchAttempt, nextRetryMs: delay }, 'bot launch failed, retrying');
          pauseHeartbeat();
          if (launchAttempt === 1) {
            void sendAdminAlert(`⚠️ <b>Bot launch failed</b> (attempt ${launchAttempt}, retrying in ${delay / 1000}s)\n${String(err)}`);
          }
          await new Promise((r) => setTimeout(r, delay));
        } else {
          // Fatal or exhausted retries — exit and let Docker restart
          logger.fatal({ err, attempt: launchAttempt, transient }, 'failed to start');
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
        select: { id: true, telegramId: true, telegramChatId: true, profile: { select: { normalizedLocale: true } } },
      });

      if (pending.length === 0) return;
      logger.info({ count: pending.length }, 'delivering pending welcome messages');

      let sent = 0;
      let blocked = 0;
      let failed = 0;

      for (const user of pending) {
        if (shutdownRequested) break;
        const chatId = user.telegramChatId!;
        const locale = detectLocale(user.profile?.normalizedLocale ?? undefined);

        try {
          // Send welcome via raw API (not ctx — we're outside an update handler).
          // Mark welcomeSent=true after the first message so partial delivery
          // doesn't cause a full duplicate on the next retry.
          await bot.telegram.sendMessage(chatId, t('bot_start', locale), { link_preview_options: { is_disabled: true } });
          await prisma.user.update({ where: { id: user.id }, data: { welcomeSent: true } });
          await bot.telegram.sendMessage(chatId, t('bot_donation', locale)).catch(() => {});
          sent++;
          logger.info({ telegramId: user.telegramId }, 'pending welcome delivered');
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
      logger.info({ attempt: launchAttempt }, 'bot polling active');
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
