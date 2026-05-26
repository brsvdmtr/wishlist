// Module-level miniapp constants extracted from MiniApp.tsx — F5.
// All entries here are immutable, dependency-free literals. Anything
// that depends on `locale` lives in its respective i18n factory; anything
// that depends on closure state stays in MiniAppInner.
//
// Source-of-truth note for the PRO pricing constants: the canonical
// values are the API env defaults (`PRO_PRICE_XTR`, `PRO_YEARLY_PRICE_XTR`,
// etc.). If ops bumps the env vars, update these too.

/**
 * Budget filter presets surfaced on the guest view. Matched against the
 * `max` field returned by `getGuestBudgetPresets(locale)`.
 */
export const GUEST_BUDGET_PRESETS = [3000, 5000, 10000, 25000] as const;

/**
 * Pre-bootstrap fallback for `credits.freeHintsLimit`.
 *
 * The server always sends the real, env-tunable limit
 * (`FREE_HINT_QUOTA_PER_MONTH`, default 3) in the entitlements payload;
 * this constant only applies in the sub-second window before the first
 * bootstrap resolves. Keep in sync with that server default.
 */
export const HINT_QUOTA_FALLBACK = 3;

/**
 * PRO pricing in Telegram Stars (XTR), kept in sync with apps/api env
 * defaults (`PRO_PRICE_XTR`, `PRO_YEARLY_PRICE_XTR`,
 * `PRO_LIFETIME_PRICE_XTR`). The miniapp uses these to render paywall
 * tiles before the server `pricing.json` round-trip — server pricing
 * always wins once it's loaded.
 */
export const PRO_PRICE_MONTHLY_STARS = 100;
export const PRO_PRICE_YEARLY_STARS = 800;
export const PRO_PRICE_LIFETIME_STARS = 2490;

/**
 * Card redesign flag — rolled out to all users. Kept as a guard for any
 * future quick-rollback path (flip to false).
 */
export const CARD_REDESIGN_ENABLED = true;

/**
 * Item-detail redesign flag — rolled out to all users. Same rollback
 * affordance as `CARD_REDESIGN_ENABLED`.
 */
export const ITEM_DETAIL_REDESIGN_ALL = true;

/**
 * Profile-screen redesign canary list. Telegram IDs in this Set get the
 * new profile UI; everyone else stays on legacy. Migrate to a server-side
 * feature flag once the canary completes.
 */
export const PROFILE_REDESIGN_IDS = new Set(['8747175307']);

/**
 * Anti-gift category keys ("don't gift X to me"). Each key has a stable
 * emoji in `DONT_GIFT_PRESET_EMOJIS` and a localised label served via
 * the i18n `dont_gift_<key>` strings.
 */
export const DONT_GIFT_PRESETS = [
  'sweets', 'flowers', 'perfume', 'cosmetics', 'jewelry', 'clothes',
  'shoes', 'souvenirs', 'soft_toys', 'alcohol', 'gift_cards', 'tech',
  'candles', 'food',
] as const;

/** Emoji per anti-gift preset (display-only; keys mirror DONT_GIFT_PRESETS). */
export const DONT_GIFT_PRESET_EMOJIS: Record<string, string> = {
  sweets: '🍬',
  flowers: '💐',
  perfume: '🧴',
  cosmetics: '💄',
  jewelry: '💍',
  clothes: '👔',
  shoes: '👟',
  souvenirs: '🏺',
  soft_toys: '🧸',
  alcohol: '🍷',
  gift_cards: '🎫',
  tech: '📱',
  candles: '🕯',
  food: '🍕',
};

/**
 * Service `?startapp=…` payloads that the bot redirects users to from
 * internal flows (onboarding nudges, settings tiles, lifecycle DMs).
 *
 * Anything in this Set is an internal command — NOT a public share token
 * or wishlist slug. Boot logic routes these to authenticated screens
 * rather than guest views.
 */
export const SERVICE_START_PARAMS = new Set([
  'create_wishlist',
  'add_first_wish',
  'add_more_wishes',
  'add_first_wish_promo',
  'add_more_wishes_promo',
  'add_item',
  'open_drafts',
  'open_profile',
  'upgrade_pro',
]);
