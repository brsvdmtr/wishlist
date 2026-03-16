import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@wishlist/db';
import { t, detectLocale, type Locale } from '@wishlist/shared';

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
  // eslint-disable-next-line no-console
  console.warn('[bot] BOT_TOKEN is missing. Bot is disabled (see apps/bot/.env.example).');
  // Keep process alive so `pnpm dev` can still run web+api without a bot token.
  setInterval(() => {}, 60_000);
} else {
  const bot = new Telegraf(token);

  const getLocale = (ctx: any): Locale => detectLocale(ctx.from?.language_code);

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
      console.error('[bot][support] failed to send to support chat:', err);
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
    }).catch((err: unknown) => console.error('[bot][support] failed to save session:', err));
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

    console.log(`[bot][support] ticket created: ${ticketCode} userId=${user.id}`);
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
  async function handleSupportReply(ctx: any, replyToMsgId: number, replyText: string): Promise<void> {
    // Find which ticket message was replied to
    const originalMsg = await prisma.supportMessage.findFirst({
      where: { telegramSupportMsgId: replyToMsgId },
      include: { ticket: { include: { user: { select: { telegramChatId: true } } } } },
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
        kind: 'TEXT',
        text: replyText,
        telegramSupportChatId: String(ctx.chat.id),
        telegramSupportMsgId: (ctx.message as any).message_id as number,
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

    const msgToUser = `[${ticket.ticketCode}] Ответ поддержки:\n${replyText}`;
    try {
      const sent = await bot.telegram.sendMessage(userChatId, msgToUser, {
        reply_markup: { force_reply: true, selective: true },
      });
      // Store delivery message ID so user can reply to continue the thread
      await prisma.supportMessage.update({
        where: { id: supportReplyRecord.id },
        data: { telegramUserChatId: userChatId, telegramUserMsgId: sent.message_id },
      }).catch(() => {});
      await ctx.reply(`✅ Ответ доставлен (${ticket.ticketCode})`).catch(() => {});
    } catch (err) {
      console.error('[bot][support] failed to deliver support reply to user:', err);
      await ctx.reply(`⚠️ [${ticket.ticketCode}] Не удалось доставить ответ пользователю: ${String(err)}`).catch(() => {});
    }
  }

  // ─── Support: close ticket ────────────────────────────────────────────────
  async function handleCloseTicket(ctx: any, replyToMsgId: number): Promise<void> {
    const supportMsg = await prisma.supportMessage.findFirst({
      where: { telegramSupportMsgId: replyToMsgId },
      include: { ticket: { include: { user: { select: { telegramChatId: true } } } } },
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

    // Notify user (best-effort, locale unknown for closed-ticket notification — use RU as default)
    const userChatId = ticket.user.telegramChatId;
    if (userChatId) {
      const closedTextRu = t('support_closed', 'ru', { code: ticket.ticketCode });
      await bot.telegram.sendMessage(userChatId, closedTextRu).catch(() => {});
    }

    await ctx.reply(`✅ Тикет ${ticket.ticketCode} закрыт.`).catch(() => {});
    console.log(`[bot][support] ticket closed: ${ticket.ticketCode}`);
  }

  // ─── Support: handle all messages from support chat ───────────────────────
  async function handleSupportChatMessage(ctx: any): Promise<void> {
    const msg = ctx.message as any;
    if (!msg) return;

    const text: string | undefined = 'text' in msg ? msg.text : undefined;

    // Must be a reply to be actionable
    if (!msg.reply_to_message) return;
    const replyToMsgId = (msg.reply_to_message as { message_id: number }).message_id;

    // /close command (reply to a ticket message)
    if (text?.startsWith('/close')) {
      await handleCloseTicket(ctx, replyToMsgId);
      return;
    }

    // Support staff reply (text only for now)
    const replyText = text ?? (msg.caption as string | undefined);
    if (!replyText) return;
    await handleSupportReply(ctx, replyToMsgId, replyText);
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
      // eslint-disable-next-line no-console
      console.error('[bot] failed to set menu button', err);
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

    // Store chat ID for notifications
    const telegramId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    await prisma.user.upsert({
      where: { telegramId },
      update: { telegramChatId: chatId },
      create: { telegramId, telegramChatId: chatId },
    }).catch(() => { /* user may not exist yet — will be created by API later */ });

    const payload = ctx.startPayload; // slug passed via ?start=SLUG deep link
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
        // eslint-disable-next-line no-console
        console.error('[bot] hint deep link error:', err);
        return ctx.reply(t('bot_error', locale));
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
    // Regular start — no inline button, user uses the menu button
    return ctx.reply(t('bot_start', locale));
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

  bot.command('paysupport', (ctx) => {
    const locale = getLocale(ctx);
    return ctx.reply(t('bot_paysupport', locale));
  });

  // ─── Payment handlers (must be registered BEFORE bot.on('text')) ──────────

  // pre_checkout_query — Telegram requires a response within 10 seconds
  bot.on('pre_checkout_query', async (ctx) => {
    try {
      const raw = ctx.preCheckoutQuery.invoice_payload;
      // eslint-disable-next-line no-console
      console.log('[bot] pre_checkout_received:', raw);

      // New format: pro_monthly:<telegramId>:<uuid>
      const parts = raw.split(':');
      if (parts.length < 3 || parts[0] !== 'pro_monthly') {
        await ctx.answerPreCheckoutQuery(false, 'Invalid payment');
        return;
      }
      const telegramId = parts[1];
      const user = await prisma.user.findUnique({
        where: { telegramId },
        select: { id: true },
      });
      if (!user) {
        await ctx.answerPreCheckoutQuery(false, 'User not found');
        return;
      }
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[bot] pre_checkout error:', err);
      await ctx.answerPreCheckoutQuery(false, 'Error').catch(() => {});
    }
  });

  // successful_payment — activates/renews PRO subscription
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
      // eslint-disable-next-line no-console
      console.log('[bot] payment_success_received:', raw);

      // New format: pro_monthly:<telegramId>:<uuid>
      const parts = raw.split(':');
      if (parts.length < 3 || parts[0] !== 'pro_monthly') return;
      const telegramId = parts[1];

      const user = await prisma.user.findUnique({
        where: { telegramId },
        select: { id: true },
      });
      if (!user) {
        // eslint-disable-next-line no-console
        console.error('[bot] payment user not found, telegramId:', telegramId);
        return;
      }

      const chargeId = payment.telegram_payment_charge_id;
      const providerChargeId = payment.provider_payment_charge_id ?? null;

      // Idempotency: skip duplicate webhook
      const existing = await prisma.paymentEvent.findUnique({
        where: { telegramPaymentChargeId: chargeId },
      });
      if (existing) {
        // eslint-disable-next-line no-console
        console.log('[bot] duplicate payment, skip:', chargeId);
        return;
      }

      const now = new Date();
      // Use subscription_expiration_date from Telegram if available, else 30 days
      const periodEnd = payment.subscription_expiration_date
        ? new Date(payment.subscription_expiration_date * 1000)
        : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      await prisma.$transaction(async (tx) => {
        const sub = await tx.subscription.upsert({
          where: {
            userId_planCode: { userId: user.id, planCode: 'PRO' },
          },
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
      const fmtDate = periodEnd.toLocaleDateString(dateFmtLocale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      await ctx.reply(
        t('bot_pro_activated', locale, { date: fmtDate }),
        Markup.inlineKeyboard([
          Markup.button.webApp(t('bot_open_app', locale), MINI_APP_URL),
        ]),
      );

      // eslint-disable-next-line no-console
      console.log(
        `[bot] subscription_activated: userId=${user.id} charge=${chargeId} periodEnd=${periodEnd.toISOString()}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[bot] payment processing error:', err);
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
      console.error('[bot] failed to update hint delivery status:', err);
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

    // ── Handle user replies in private chat ────────────────────────────────
    if (!msg.reply_to_message) return next();
    const replyToId: number = (msg.reply_to_message as { message_id: number }).message_id;

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

    return next();
  });

  // ─── URL import: text message handler ────────────────────────────────────
  const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';
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
          return;
        }
        if (res.status === 400) {
          await ctx.reply(body.error || t('bot_import_error', locale));
          return;
        }
        await ctx.reply(t('bot_import_error_retry', locale));
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
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[bot] import-url error:', err);
      await ctx.reply(t('bot_error', locale));
    }
  });

  // Set bot commands for default (English) and Russian locales
  bot.telegram
    .setMyCommands([
      { command: 'start', description: t('bot_cmd_start', 'en') },
      { command: 'support', description: t('bot_cmd_support', 'en') },
      { command: 'paysupport', description: t('bot_cmd_paysupport', 'en') },
    ])
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to set commands', err);
    });

  bot.telegram
    .setMyCommands(
      [
        { command: 'start', description: t('bot_cmd_start', 'ru') },
        { command: 'support', description: t('bot_cmd_support', 'ru') },
        { command: 'paysupport', description: t('bot_cmd_paysupport', 'ru') },
      ],
      { language_code: 'ru' },
    )
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to set ru commands', err);
    });

  bot
    .launch()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[bot] started');
      // Startup alert + initial heartbeat
      void sendAdminAlert(`🟢 <b>Bot started</b>\nEnv: ${process.env.NODE_ENV ?? 'development'}`);
      void updateHeartbeat();
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to start', err);
      process.exitCode = 1;
    });

  // Heartbeat: update every 60 s so /health/deep can detect bot absence
  setInterval(() => void updateHeartbeat(), 60_000);

  // Uncaught exception / rejection alerts
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[bot] uncaughtException:', err);
    void sendAdminAlert(`🔴 <b>Bot uncaughtException</b>\n${String(err)}`).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[bot] unhandledRejection:', reason);
    void sendAdminAlert(`🔴 <b>Bot unhandledRejection</b>\n${String(reason)}`);
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
