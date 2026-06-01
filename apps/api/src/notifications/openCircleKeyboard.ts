// Inline keyboard for the "Открыть группу" / "Open circle" button on the
// owner's join notification (P0.1 «Близкие»). Mirrors openWishKeyboard.ts.
//
// The button deep-links via the invite token the joiner used. The frontend
// `circ_` parser opens the join preview, which for an already-member (the
// owner) renders an "Open circle" CTA into the circle. Wire format documented
// in telegram/deepLinks.ts.

import { t, type Locale } from '@wishlist/shared';
import { buildCircleDeepLink } from '../telegram/deepLinks';

export function buildOpenCircleKeyboard(
  token: string,
  locale: Locale,
): { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> } {
  return {
    inline_keyboard: [[
      { text: t('notif_open_circle_btn', locale), web_app: { url: buildCircleDeepLink(token) } },
    ]],
  };
}
