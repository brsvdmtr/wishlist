import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@wishlist/db';

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

if (!token) {
  // eslint-disable-next-line no-console
  console.warn('[bot] BOT_TOKEN is missing. Bot is disabled (see apps/bot/.env.example).');
  // Keep process alive so `pnpm dev` can still run web+api without a bot token.
  setInterval(() => {}, 60_000);
} else {
  const bot = new Telegraf(token);

  // Set the persistent menu button (bottom-left "Вишлист" button)
  bot.telegram
    .setChatMenuButton({
      menuButton: {
        type: 'web_app',
        text: 'Вишлист',
        web_app: { url: MINI_APP_URL },
      },
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to set menu button', err);
    });

  const menuButton = {
    type: 'web_app' as const,
    text: 'Вишлист',
    web_app: { url: MINI_APP_URL },
  };

  bot.start(async (ctx) => {
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
          return ctx.reply('Это желание больше не доступно 🤷');
        }
        // Self-send check: owner opened their own hint
        if (item.wishlist.owner.telegramId === telegramId) {
          return ctx.reply('Себе намек отправлять не нужно 😊');
        }
        // Item no longer available
        if (item.status !== 'AVAILABLE') {
          return ctx.reply('На это желание уже не нужно намекать — оно забронировано 🎁');
        }
        // Resolve owner name
        let ownerName = item.wishlist.owner.firstName || 'Пользователь';
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
        const msg = `Есть идея подарка для ${ownerName} 🎁\n\nОбрати внимание на желание «${item.title}» — похоже, ${shortName.toLowerCase()} особенно нравится это.`;
        return ctx.reply(msg, Markup.inlineKeyboard([
          Markup.button.webApp('Посмотреть желание 🎁', `${MINI_APP_URL}?startapp=${item.wishlist.slug}__item_${item.id}`),
        ]));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[bot] hint deep link error:', err);
        return ctx.reply('Произошла ошибка. Попробуй позже 🙈');
      }
    }
    if (payload) {
      // Guest deep link — open specific wishlist in mini app
      return ctx.reply(
        `Смотри вишлист 🎁`,
        Markup.inlineKeyboard([
          Markup.button.webApp('Смотреть вишлист 🎁', `${MINI_APP_URL}?startapp=${payload}`),
        ]),
      );
    }
    // Regular start — no inline button, user uses the menu button
    return ctx.reply(
      'Привет! WishBoard — твой персональный список желаний 🎁\nНажми кнопку «Вишлист» внизу, чтобы открыть приложение.',
    );
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'WishBoard — создавай вишлисты и делись ими с друзьями.\n\n/start — начать\n/paysupport — помощь с оплатой\n\nОтправь ссылку на товар — я создам карточку желания!',
    ),
  );

  bot.command('paysupport', (ctx) =>
    ctx.reply(
      '💳 Помощь с оплатой\n\n' +
        'Если у тебя возникли проблемы с оплатой или подпиской PRO:\n\n' +
        '1. Убедись, что у тебя достаточно Telegram Stars\n' +
        '2. Попробуй перезапустить приложение и повторить оплату\n' +
        '3. Если проблема сохраняется — напиши описание проблемы в этот чат, мы разберёмся 🙏',
    ),
  );

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

      const fmtDate = periodEnd.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      await ctx.reply(
        `🎉 PRO подключен!\n\n` +
          `✅ 10 вишлистов\n` +
          `✅ 100 желаний в каждом\n` +
          `✅ Комментарии и импорт по ссылке\n\n` +
          `Действует до ${fmtDate}`,
        Markup.inlineKeyboard([
          Markup.button.webApp('Открыть WishBoard ✨', MINI_APP_URL),
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
    const shared = msg.users_shared as { request_id: number; users: Array<{ user_id: number; first_name?: string }> };

    // Find sender's most recent active hint (created in last 30 min)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const sender = await prisma.user.findUnique({ where: { telegramId: senderTgId }, select: { id: true } });
    if (!sender) {
      await ctx.reply('Не удалось найти профиль. Открой приложение и попробуй снова.', Markup.removeKeyboard());
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
      await ctx.reply('Активный намёк не найден. Создай новый в приложении.', Markup.removeKeyboard());
      return;
    }

    if (hint.item.status !== 'AVAILABLE') {
      await ctx.reply('Это желание уже забронировано — намёк больше не нужен 🎁', Markup.removeKeyboard());
      return;
    }

    // Resolve owner name for the hint message
    const owner = await prisma.user.findUnique({
      where: { id: hint.item.wishlist.ownerId },
      select: { firstName: true, telegramId: true, telegramChatId: true },
    });
    let ownerName = owner?.firstName || 'Пользователь';
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
    const hintText = `Есть идея подарка для ${ownerName} 🎁\n\nОбрати внимание на желание «${hint.item.title}» — похоже, ${shortName.toLowerCase()} особенно нравится это.`;

    let directSent = 0;
    let pendingCount = 0;

    for (const u of shared.users) {
      const recipientTgId = String(u.user_id);
      // Skip self-send
      if (recipientTgId === senderTgId) continue;
      // Skip if recipient is the owner themselves (edge case)
      if (owner?.telegramId === recipientTgId) continue;

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
                { text: 'Посмотреть желание 🎁', web_app: { url: `${MINI_APP_URL}?startapp=${hint.item.wishlist.slug}__item_${hint.item.id}` } },
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

    // Summary to sender
    const parts: string[] = [];
    if (directSent > 0) parts.push(`✅ Отправлено напрямую: ${directSent}`);
    if (pendingCount > 0) parts.push(`⏳ Не удалось отправить: ${pendingCount} (нет диалога с ботом)`);
    if (parts.length === 0) parts.push('Не выбран ни один получатель.');

    await ctx.reply(parts.join('\n'), Markup.removeKeyboard());

    // Fallback for pending: send deep link template
    if (pendingCount > 0) {
      const botInfo = await bot.telegram.getMe();
      const deepLink = `https://t.me/${botInfo.username}?start=hint_${hint.item.id}`;
      await ctx.reply(
        `Некоторые друзья ещё не начали диалог с ботом.\n\nОтправь им эту ссылку — когда они откроют её, бот покажет намёк:\n${deepLink}`,
      );
    }
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

    const urls = text.match(URL_REGEX);
    if (!urls || urls.length === 0) return; // no URL — stay silent

    const firstUrl = urls[0];

    // Multiple URLs — warn
    if (urls.length > 1) {
      await ctx.reply('Нашёл несколько ссылок. Создаю карточку по первой 👌');
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
          await ctx.reply('Слишком много неразобранных желаний. Разбери часть в приложении, потом добавляй новые 📦');
          return;
        }
        if (res.status === 400) {
          await ctx.reply(body.error || 'Не удалось обработать ссылку 🤷');
          return;
        }
        await ctx.reply('Не удалось обработать ссылку. Попробуй ещё раз 🤷');
        return;
      }

      const { item, parseStatus } = await res.json() as {
        item: { id: string; title: string; sourceDomain: string | null; price: number | null };
        parseStatus: string;
      };

      let msg = `✅ <b>Добавлено в Неразобранное</b>\n\n`;
      msg += `<b>${escapeHtml(item.title)}</b>`;
      if (item.sourceDomain) msg += `\n🔗 ${escapeHtml(item.sourceDomain)}`;
      if (item.price) msg += `\n💰 ${Number(item.price).toLocaleString('ru-RU')} ₽`;

      if (parseStatus === 'failed') {
        msg += `\n\n⚠️ Не удалось распознать товар — отредактируй в приложении`;
      } else if (parseStatus === 'partial') {
        msg += `\n\n💡 Распознал не всё — проверь и дополни в приложении`;
      }

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          Markup.button.webApp('Открыть в WishBoard ✨', `${MINI_APP_URL}?startapp=draft_${item.id}`),
        ]),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[bot] import-url error:', err);
      await ctx.reply('Произошла ошибка. Попробуй позже 🙈');
    }
  });

  bot.telegram
    .setMyCommands([
      { command: 'start', description: 'Открыть WishBoard' },
      { command: 'paysupport', description: 'Помощь с оплатой' },
    ])
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to set commands', err);
    });

  bot
    .launch()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[bot] started');
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to start', err);
      process.exitCode = 1;
    });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
