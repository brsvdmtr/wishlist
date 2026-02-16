import { Markup } from 'telegraf';

const SITE_URL = (
  process.env.SITE_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  'http://localhost:3000'
).replace(/\/+$/, '');

export function mainMenuKeyboard() {
  return Markup.keyboard(
    [
      ['➕ Добавить желание', '📋 Мой список'],
      ['🔗 Поделиться'],
      ['⚙️ Настройки'],
    ] as unknown as Parameters<typeof Markup.keyboard>[0],
    { resize_keyboard: true } as Parameters<typeof Markup.keyboard>[1],
  );
}

export function openWebAppKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.webApp('🎁 Открыть в браузере', SITE_URL)]]);
}

export function shareLinkKeyboard(slug: string) {
  const url = `${SITE_URL}/w/${slug}`;
  return Markup.inlineKeyboard([
    [Markup.button.webApp('🎁 Открыть вишлист', url)],
    [Markup.button.url('Копировать ссылку', `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('Мой вишлист')}`)],
  ]);
}

export function backToMenuKeyboard() {
  return Markup.keyboard([['◀️ В меню']] as unknown as Parameters<typeof Markup.keyboard>[0], { resize_keyboard: true } as Parameters<typeof Markup.keyboard>[1]);
}

export function cancelKeyboard() {
  return Markup.keyboard([['❌ Отмена']] as unknown as Parameters<typeof Markup.keyboard>[0], { resize_keyboard: true } as Parameters<typeof Markup.keyboard>[1]);
}
