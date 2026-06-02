// Circles («Близкие») i18n invariants.
//
// Regression guard for the live-test bug where the circle-join notification
// message and its "Open group" inline button both led with the same 👥 emoji,
// which read as a duplicated icon in the Telegram chat. The two strings must
// keep visually distinct leading icons in every locale.

import { describe, it, expect } from 'vitest';
import { dicts, type Locale } from './i18n';

const LOCALES: Locale[] = ['ru', 'en', 'zh-CN', 'hi', 'es', 'ar'];

// First grapheme via code-point spread (handles the astral-plane emoji).
// Accepts `string | undefined` because `noUncheckedIndexedAccess` types the
// dict lookups that way; the `.toBeTruthy()` guards below catch a real miss.
const leadingIcon = (s: string | undefined): string => [...(s ?? '').trim()][0] ?? '';

describe('Circles notification vs open-group button — distinct leading icons', () => {
  it.each(LOCALES)('locale %s: join-notif and the open-group button do not share a leading emoji', (loc) => {
    const join = dicts[loc].circle_join_notif;
    const button = dicts[loc].notif_open_circle_btn;
    expect(join, `circle_join_notif missing for ${loc}`).toBeTruthy();
    expect(button, `notif_open_circle_btn missing for ${loc}`).toBeTruthy();
    expect(leadingIcon(join)).not.toBe(leadingIcon(button));
  });
});
