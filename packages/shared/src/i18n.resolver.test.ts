// Unit tests for the locale resolver chain. Every proactive cron / bot push
// in the codebase routes through `resolveLocaleWithSource`, so the priority
// order is the single most safety-critical contract in i18n. The chain is:
//   1. manual override     (settings.languageMode='manual' && settings.manualLanguage)
//   2. live telegram       (telegramLanguageCode arg)
//   3. persisted normalized (settings.normalizedLocale, validated against Locale union)
//   4. legacy raw language (settings.legacyLanguage, normalised via normalizeLocale)
//   5. default 'en'
//
// History: a 2026-05-10 production bug had Russian users receiving English
// lifecycle DMs because the cron path called `resolveEffectiveLocale(profile)`
// without `telegramLanguageCode`, falling through to `normalizeLocale(undefined)`
// which returns 'en'. The fix was to extend the resolver with the persisted
// fallback (steps 3–4) and have every proactive caller pass those fields.

import { describe, it, expect } from 'vitest';
import { resolveEffectiveLocale, resolveLocaleWithSource, t, type Locale } from './i18n';

describe('resolveLocaleWithSource', () => {
  describe('manual override', () => {
    it('honours manual ru even when live telegram is en and persisted is en', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'manual', manualLanguage: 'ru', normalizedLocale: 'en', legacyLanguage: 'en-US' },
        'en-US',
      );
      expect(r).toEqual({ locale: 'ru', source: 'manual' });
    });

    it('honours manual en even when live telegram is ru and persisted is ru', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'manual', manualLanguage: 'en', normalizedLocale: 'ru', legacyLanguage: 'ru-RU' },
        'ru-RU',
      );
      expect(r).toEqual({ locale: 'en', source: 'manual' });
    });

    it('falls through to live telegram when manualLanguage is null even in manual mode', () => {
      // Defensive: a malformed profile (manual mode but no pick) should NOT
      // pin behaviour — we fall through to the next signal. This matches the
      // historical resolver behaviour pre-fix.
      const r = resolveLocaleWithSource(
        { languageMode: 'manual', manualLanguage: null, normalizedLocale: 'ru' },
        'en-US',
      );
      expect(r).toEqual({ locale: 'en', source: 'live_telegram' });
    });

    it('falls through when manualLanguage is dirty (unsupported value)', () => {
      // Defensive: if a dirty migration / admin tool writes 'pt-BR' to
      // manualLanguage, blindly returning it would crash `t()` because
      // dicts['pt-BR'] is undefined. The resolver must reject unsupported
      // values and fall through to the next signal — same shape as the
      // persisted_normalized guard.
      const r = resolveLocaleWithSource(
        // @ts-expect-error — exercising runtime defensive path with bogus type
        { languageMode: 'manual', manualLanguage: 'pt-BR', normalizedLocale: 'ru', legacyLanguage: 'ru-RU' },
      );
      expect(r).toEqual({ locale: 'ru', source: 'persisted_normalized' });
    });

    it('falls through when manualLanguage is empty string', () => {
      // Defensive: a malformed profile (manual mode but empty string pick) has
      // the same semantics as null — must fall through to next signal, not pin
      // on '' which would fail isSupportedLocale and crash `t('', locale)`.
      const r = resolveLocaleWithSource(
        // @ts-expect-error — exercising runtime defensive path with empty string
        { languageMode: 'manual', manualLanguage: '', normalizedLocale: 'ru', legacyLanguage: 'ru-RU' },
      );
      expect(r).toEqual({ locale: 'ru', source: 'persisted_normalized' });
    });
  });

  describe('live telegram', () => {
    it('uses live ru-RU in auto mode, ignoring persisted en', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', legacyLanguage: 'en-US' },
        'ru-RU',
      );
      expect(r).toEqual({ locale: 'ru', source: 'live_telegram' });
    });

    it('uses live en when no settings', () => {
      const r = resolveLocaleWithSource(null, 'en-US');
      expect(r).toEqual({ locale: 'en', source: 'live_telegram' });
    });
  });

  describe('persisted normalizedLocale', () => {
    it('uses persisted ru when no live telegram (cron / proactive context)', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru' },
        undefined,
      );
      expect(r).toEqual({ locale: 'ru', source: 'persisted_normalized' });
    });

    it('uses persisted ar when no live telegram', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ar' },
      );
      expect(r).toEqual({ locale: 'ar', source: 'persisted_normalized' });
    });

    it('rejects an unsupported persisted value and falls through to legacy', () => {
      // Defensive: if `normalizedLocale` was written by older / buggy code as
      // something outside the Locale union (e.g. raw 'pt-BR'), the resolver
      // must not return it unchecked — falls through to legacy normalisation.
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'pt-BR', legacyLanguage: 'ru-RU' },
      );
      expect(r).toEqual({ locale: 'ru', source: 'legacy_language' });
    });
  });

  describe('legacy raw language', () => {
    it('normalises legacy ru-RU to ru', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, legacyLanguage: 'ru-RU' },
      );
      expect(r).toEqual({ locale: 'ru', source: 'legacy_language' });
    });

    it('normalises legacy zh-Hans to zh-CN', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, legacyLanguage: 'zh-Hans' },
      );
      expect(r).toEqual({ locale: 'zh-CN', source: 'legacy_language' });
    });

    it('falls back to en for unknown legacy code', () => {
      // normalizeLocale lenient-defaults to 'en' for unknown languages —
      // mirror that in the resolver chain so downstream sees a Locale value
      // even on garbage input.
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, legacyLanguage: 'zz-XX' },
      );
      expect(r).toEqual({ locale: 'en', source: 'legacy_language' });
    });
  });

  describe('default fallback', () => {
    it('returns en + default_en when nothing is known', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null },
      );
      expect(r).toEqual({ locale: 'en', source: 'default_en' });
    });

    it('returns en + default_en when settings is null and no telegram code', () => {
      const r = resolveLocaleWithSource(null);
      expect(r).toEqual({ locale: 'en', source: 'default_en' });
    });
  });

  describe('priority chain ordering', () => {
    it('manual > live > normalized > legacy > default', () => {
      // All four signals supplied — manual wins.
      expect(resolveLocaleWithSource(
        { languageMode: 'manual', manualLanguage: 'ar', normalizedLocale: 'ru', legacyLanguage: 'en' },
        'es',
      ).source).toBe('manual');

      // Manual disabled → live wins.
      expect(resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', legacyLanguage: 'en' },
        'es',
      ).source).toBe('live_telegram');

      // No live → normalized wins.
      expect(resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', legacyLanguage: 'en' },
      ).source).toBe('persisted_normalized');

      // No normalized → legacy wins.
      expect(resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, legacyLanguage: 'en-US' },
      ).source).toBe('legacy_language');
    });
  });
});

describe('resolver → t() integration coverage', () => {
  // Meta-test: every i18n key added in the locale-fix wave (lifecycle button,
  // subscriber notification button, reservation reminder block, group-gift
  // fanouts, comment-batch plurals) MUST resolve to a non-empty string in
  // every supported locale. Catches the next time someone adds a new locale
  // to the union but forgets to add a key block — or drops a key during a
  // refactor — *before* prod sends a literal i18n-key string to a user.
  const SUPPORTED_LOCALES: Locale[] = ['ru', 'en', 'zh-CN', 'hi', 'es', 'ar'];

  // Keys added in the 2026-05-10 systemic fix + 2026-05-11 follow-ups,
  // plus the 2026-05-17 monolith localisation pass (Global Search, SR
  // onboarding panel, error boundary, multi-placement, popups, etc.).
  // Update when adding new keys to the dict in this category.
  const LOCALE_FIX_KEYS = [
    // 2026-05-10 systemic fix + 2026-05-11 follow-ups (lifecycle, notifications, plurals, santa).
    'lifecycle_dm_open_app_btn',
    'sub_notification_open_item_btn',
    'notif_res_reminder_header',
    'notif_res_reminder_body',
    'notif_res_reminder_body_with_price',
    'notif_res_reminder_from',
    'notif_res_reminder_note',
    'notif_res_reminder_btn_open',
    'notif_res_reminder_btn_purchased',
    'notif_group_gift_joined',
    'notif_group_gift_completed',
    'notif_group_gift_cancelled',
    'notif_batch_comments_word_one',
    'notif_batch_comments_word_few',
    'notif_batch_comments_word_many',
    'santa_broadcast_promo',
    'santa_broadcast_closing_soon',
    // 2026-05-17 localisation pass — full monolith sweep (Global Search,
    // SR onboarding panel, error boundary, multi-placement, popups,
    // emoji picker, link management, splash, toasts, smart chips, etc.).
    // ALL new keys from this wave are listed here so the meta-test catches
    // any future locale-block drop.
    // Keep alphabetical and append-only — duplicate keys will cause vitest
    // to emit identical test names (harmless but noisy), and breaking the
    // alphabetisation makes the next reviewer's diff harder to read.
    'addon_slots_prompt',
    'analyzing_link',
    'category_max_items',
    'changes_few',
    'changes_many',
    'changes_one',
    'comments_badge_new_one',
    'common_after',
    'common_before',
    'common_collapse',
    'common_skip',
    'copy_explainer_body',
    'copy_explainer_strong',
    'copy_sheet_title',
    'curated_subtitle_by_owner',
    'datetime_separator_at',
    'discard',
    'emoji_change_button',
    'emoji_change_hint',
    'emoji_custom_button',
    'emoji_only_warning_toast',
    'emoji_picker_back_palette',
    'emoji_picker_open_keyboard_hint',
    'emoji_picker_placeholder',
    'emoji_picker_title',
    'emoji_reset_auto',
    'error_boundary_body',
    'error_boundary_reload',
    'error_boundary_title',
    'error_link_expired',
    'error_load_page_try_another',
    'error_load_slow_or_lost_desc',
    'error_load_slow_or_lost_title',
    'error_load_wishes_desc',
    'error_load_wishes_title',
    'error_no_connection',
    'error_no_internet',
    'item_action_add_to_more',
    'item_action_create_copy',
    'item_action_manage_placements',
    'item_action_where_placed',
    'last_placement_warning_body',
    'link_created_label',
    'link_day_short',
    'link_disable_warning',
    'link_expired_body',
    'link_expiry_label',
    'link_subscribers_label',
    'link_valid_until',
    'link_views_label',
    'link_visibility_label',
    'multi_placement_checkbox_hint',
    'multi_placement_current_tag',
    'multi_placement_learn_pro',
    'multi_placement_pro_locked_desc',
    'multi_placement_pro_locked_title',
    'multi_placement_shared_explainer',
    'multi_placement_single_explainer',
    'multi_placement_title',
    'open_link',
    'placements_can_add',
    'placements_currently_placed',
    'placements_delete_completely',
    'placements_last_placement',
    'placements_last_wishlist_warning',
    'placements_no_category',
    'placements_primary_marker',
    'profile_close_warning',
    'promo_label',
    'promo_subtitle',
    'santa_alias_changes_hint',
    'santa_group_min_warning',
    'search_smart_archive',
    'search_smart_available',
    'search_smart_high_prio',
    'search_smart_mine',
    'search_smart_no_price',
    'search_smart_regular',
    'search_smart_secret',
    'search_smart_soon',
    'search_smart_subscribed',
    'search_smart_with_link',
    'search_smart_with_price',
    'search_tile_expiring_hint_pro',
    'search_tile_expiring_label',
    'search_tile_expiring_query',
    'search_tile_important_hint',
    'search_tile_important_label',
    'search_tile_important_query',
    'search_tile_secret_hint_pro',
    'search_tile_secret_label',
    'search_tile_secret_query',
    'search_tile_with_link_hint',
    'search_tile_with_link_label',
    'share_placement_count_prefix',
    'shared_wish_count_header',
    'shared_wish_explainer_body',
    'shared_wish_explainer_strong',
    'shared_wish_label',
    'shared_wish_multi_title',
    'single_wishlist_label',
    'smart_res_feature_auto_release',
    'smart_res_feature_extend',
    'smart_res_feature_reminders',
    'sort_button_expiring',
    'sort_label_expiring',
    'sort_label_gifted',
    'sort_label_reserved',
    'sort_label_wishes',
    'splash_loading_opening',
    'splash_loading_ready',
    'splash_loading_wishlists',
    'splash_subtitle',
    'sr_default_ext_label',
    'sr_default_ext_value',
    'sr_default_reminder_value',
    'sr_default_settings',
    'sr_default_ttl_label',
    'sr_default_ttl_value',
    'sr_event_created',
    'sr_event_created_desc',
    'sr_event_release',
    'sr_event_release_desc',
    'sr_event_reminder',
    'sr_event_reminder_desc',
    'sr_onboard_customize',
    'sr_onboard_keep_defaults',
    'sr_onboard_next',
    'sr_onboard_skip',
    'sr_onboard_step1_body',
    'sr_onboard_step1_title',
    'sr_onboard_step2_body',
    'sr_onboard_step2_explainer_html',
    'sr_onboard_step2_title',
    'sr_onboard_step3_body',
    'sr_onboard_step3_explainer',
    'sr_onboard_step3_title',
    'sr_onboard_step4_body',
    'sr_onboard_step4_title',
    'sr_onboard_whats_included',
    'sr_state_after_desc',
    'sr_state_before_desc',
    'toast_added_to_n_wishlists',
    'toast_added_to_wishlist',
    'toast_already_in_wishlist',
    'toast_link_copied',
    'toast_link_disabled',
    'toast_load_failed_check_network',
    'toast_load_failed_generic',
    'toast_removed_from_remaining',
    'toast_section_coming_soon',
    'unit_days_short',
    'unit_hours_short',
    'unsaved_changes_body',
    'unsaved_changes_title',
    'visibility_link_only_label',
    'visibility_public_label',
    'wishlist_cover_label',
  ];

  for (const locale of SUPPORTED_LOCALES) {
    for (const key of LOCALE_FIX_KEYS) {
      it(`${locale} → t('${key}') resolves to a non-empty string`, () => {
        const result = t(key, locale);
        expect(result).toBeTruthy();
        expect(result).not.toBe(key);
        // Body keys take params; calling without them yields raw `{{title}}`
        // tokens — still a non-empty string, so this only catches missing
        // entries, not malformed templates. Assertion shape kept tight on
        // purpose so the test fails loudly on the one regression class
        // (key missing from dict) without false-positives on template style.
      });
    }
  }

  it('every resolver-output locale resolves the lifecycle button key (end-to-end)', () => {
    // Belt-and-braces: feed each LocaleSource branch's output into t() and
    // confirm the path that ships the most user-visible string never throws
    // and never echoes the raw key. Defends the seam most likely to break.
    const cases = [
      resolveLocaleWithSource({ languageMode: 'manual', manualLanguage: 'ar' }).locale,
      resolveLocaleWithSource(null, 'ru-RU').locale,
      resolveLocaleWithSource({ languageMode: 'auto', manualLanguage: null, normalizedLocale: 'es' }).locale,
      resolveLocaleWithSource({ languageMode: 'auto', manualLanguage: null, legacyLanguage: 'hi-IN' }).locale,
      resolveLocaleWithSource(null).locale,
    ];
    for (const loc of cases) {
      const button = t('lifecycle_dm_open_app_btn', loc);
      expect(button).toBeTruthy();
      expect(button).not.toBe('lifecycle_dm_open_app_btn');
    }
  });
});

describe('resolveEffectiveLocale (locale-only convenience)', () => {
  it('returns just the locale, dropping the source', () => {
    expect(resolveEffectiveLocale(
      { languageMode: 'manual', manualLanguage: 'ru' },
    )).toBe('ru');
    expect(resolveEffectiveLocale(null, 'en-US')).toBe('en');
    expect(resolveEffectiveLocale(null)).toBe('en');
  });

  it('preserves byte-identical behaviour for the pre-fix call shape', () => {
    // Pre-fix code paths called the resolver with only languageMode +
    // manualLanguage and a live telegramLanguageCode (or undefined). Those
    // call sites must keep returning the same thing — extension is purely
    // additive. Regression guard against accidental priority reordering.
    expect(resolveEffectiveLocale(
      { languageMode: 'manual', manualLanguage: 'ru' },
      'en-US',
    )).toBe('ru');
    expect(resolveEffectiveLocale(
      { languageMode: 'auto', manualLanguage: null },
      'ru-RU',
    )).toBe('ru');
    expect(resolveEffectiveLocale(
      { languageMode: 'auto', manualLanguage: null },
      undefined,
    )).toBe('en');
  });
});
