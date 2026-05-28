// Inline keyboard shape for "Перейти к желанию" / "Open wish" buttons that
// land owners on the item-detail screen from a bot notification.
//
// Three notification sites currently use this:
//   - apps/api/src/routes/reservations.routes.ts — public reserve flow
//   - apps/api/src/routes/reservations.routes.ts — secret→public promotion
//   - apps/api/src/schedulers/reservations.ts    — smart-res auto-release
//
// Extracted from inline construction in each site because the iron rule in
// CLAUDE.md (Testing § "every new pure helper / formula repeated ≥2× anywhere
// is extracted to a named function with a unit test") applies — three sites
// is past the threshold, and the wire shape is exactly what we want pinned
// against silent refactor drift.
//
// Frontend side of the contract lives in apps/web/app/miniapp/startParam.ts
// (parser) and apps/web/app/miniapp/MiniApp.tsx (dispatcher). Wire format
// `item_<itemId>` documented at the top of telegram/deepLinks.ts.

import { t, type Locale } from '@wishlist/shared';
import { buildItemOpenDeepLink } from '../telegram/deepLinks';

export function buildOpenWishKeyboard(itemId: string, locale: Locale): { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> } {
  return {
    inline_keyboard: [[
      { text: t('notif_open_wish_btn', locale), web_app: { url: buildItemOpenDeepLink(itemId) } },
    ]],
  };
}
