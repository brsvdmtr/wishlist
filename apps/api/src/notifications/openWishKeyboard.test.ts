// Pins the inline keyboard wire shape for owner-side "Open wish" buttons.
// Three notification sites (public reserve, secret→public promotion,
// smart-res auto-release) consume this. A future refactor that drops the
// `web_app` field, swaps `item_` for a different prefix, or renames the
// i18n key would pass route-level tests (which often just assert "spy was
// called") but break the user-facing flow — this test fails first.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildOpenWishKeyboard } from './openWishKeyboard';

const ORIG_MINI_APP_URL = process.env.MINI_APP_URL;
const ORIG_WEB_ORIGIN = process.env.WEB_ORIGIN;

beforeEach(() => {
  delete process.env.MINI_APP_URL;
  delete process.env.WEB_ORIGIN;
  process.env.MINI_APP_URL = 'https://t.me/WishBoardBot/app';
});

afterEach(() => {
  // Restore BOTH env vars — vitest file order is unspecified, and
  // WEB_ORIGIN leakage across files would silently change the fallback
  // chain in deepLinks.ts for any later test.
  if (ORIG_MINI_APP_URL === undefined) delete process.env.MINI_APP_URL;
  else process.env.MINI_APP_URL = ORIG_MINI_APP_URL;
  if (ORIG_WEB_ORIGIN === undefined) delete process.env.WEB_ORIGIN;
  else process.env.WEB_ORIGIN = ORIG_WEB_ORIGIN;
});

describe('buildOpenWishKeyboard', () => {
  it('returns a single-row, single-button inline_keyboard', () => {
    const kb = buildOpenWishKeyboard('cmaa1bb2ccdd', 'ru');
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]).toHaveLength(1);
  });

  it('encodes the item id as `item_<id>` startapp payload', () => {
    const kb = buildOpenWishKeyboard('cmaa1bb2ccdd', 'ru');
    const btn = kb.inline_keyboard[0]![0]!;
    expect(btn.web_app.url).toBe('https://t.me/WishBoardBot/app?startapp=item_cmaa1bb2ccdd');
  });

  it('uses the recipient locale for the button label', () => {
    expect(buildOpenWishKeyboard('cmaa1bb2ccdd', 'ru').inline_keyboard[0]![0]!.text).toBe('🎁 Перейти к желанию');
    expect(buildOpenWishKeyboard('cmaa1bb2ccdd', 'en').inline_keyboard[0]![0]!.text).toBe('🎁 Open wish');
    expect(buildOpenWishKeyboard('cmaa1bb2ccdd', 'zh-CN').inline_keyboard[0]![0]!.text).toBe('🎁 查看愿望');
    expect(buildOpenWishKeyboard('cmaa1bb2ccdd', 'hi').inline_keyboard[0]![0]!.text).toBe('🎁 इच्छा देखें');
    expect(buildOpenWishKeyboard('cmaa1bb2ccdd', 'es').inline_keyboard[0]![0]!.text).toBe('🎁 Ver deseo');
    expect(buildOpenWishKeyboard('cmaa1bb2ccdd', 'ar').inline_keyboard[0]![0]!.text).toBe('🎁 عرض الأمنية');
  });

  it('uses `web_app` button mode (not `url`) — opens Mini App in-place', () => {
    // Contract: comments + subscriptions use web_app; reservation reminder
    // legacy uses url:. New owner-side reservation notifications standardise
    // on web_app for smoother UX (one tap instead of two). If a future PR
    // flips back to `url:`, this test fails and forces the call out.
    const btn = buildOpenWishKeyboard('cmaa1bb2ccdd', 'en').inline_keyboard[0]![0]!;
    expect(btn).toHaveProperty('web_app');
    expect(btn).not.toHaveProperty('url');
  });
});
