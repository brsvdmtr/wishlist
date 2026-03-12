import { z } from 'zod';

export * from './i18n';

export const WishlistItemSchema = z.object({
  title: z.string().min(1),
  url: z.string().url().optional(),
  note: z.string().max(2000).optional(),
});

export type WishlistItemInput = z.infer<typeof WishlistItemSchema>;

// ─── Share / Deep Link helpers ───────────────────────────

/**
 * Build a Telegram deep link that opens the Mini App directly.
 * Format: https://t.me/<BOT>?startapp=<payload>
 */
export function buildTgDeepLink(botUsername: string, payload?: string): string | null {
  if (!botUsername) return null;
  const base = `https://t.me/${botUsername}`;
  return payload ? `${base}?startapp=${encodeURIComponent(payload)}` : base;
}

/**
 * Build a Telegram share URL that opens the native chat picker.
 * Format: https://t.me/share/url?url=<URL>&text=<TEXT>
 */
export function buildTgShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}
