// Locale-coverage guards. These tests are CI-blocking and exist to catch
// the two regression classes that have repeatedly shipped to production:
//
//   1. **Key-parity drop** — a new key added to `ru` (or `en`) but forgotten
//      in one of the other 5 locale blocks. Users on the missing locale see
//      either the raw key string echoed back from `t()` or a silent
//      EN-fallback that breaks the language-consistency invariant.
//
//   2. **English stub** — a key value left as English literal in a non-EN
//      locale block (most often because the author copy-pasted the EN block
//      into the locale block and forgot to translate). Caught by checking
//      that every value in a non-Latin-script locale contains at least one
//      character of that script, with a documented whitelist for the cases
//      where keeping English is intentional (brand names, units, codes,
//      pure-markup placeholders, Spanish cognates).
//
// History — these guards exist because:
//   - 2026-05-10: lifecycle DM regression where 5 locales had a key but a 6th
//     didn't, so Russian users got English DMs.
//   - 2026-05-17 (iter-1 review of ea38dd6): `plan_pro_f15-19` shipped as
//     English stubs in zh-CN/hi/es/ar for the Pro paywall.
//   - 2026-05-17 (iter-3 review of ed36e23): `sr_diff_field_priceText` and
//     `sr_diff_field_imageUrl` (camelCase keys) shipped as English stubs in
//     4 locales — caught only by manual review.
//
// **Adding a new locale** = update `SUPPORTED_LOCALES`, ensure every key is
// translated, and add any locale-specific whitelist if needed.
//
// **Adding a new key** = define it in every locale dict (these tests will
// fail loudly if you forget one).
//
// **Intentionally keeping English** = add the key to `INTENTIONAL_EN_KEYS`
// with a comment explaining why.

import { describe, it, expect } from 'vitest';
import { dicts, type Locale } from './i18n';

const SUPPORTED_LOCALES: Locale[] = ['ru', 'en', 'zh-CN', 'hi', 'es', 'ar'];

// ─── KNOWN_BACKLOG ────────────────────────────────────────────────────────────
//
// Historical translation gap as of 2026-05-17: 559 keys exist in RU/EN but
// are missing from one or more of zh-CN/hi/es/ar. These shipped before the
// 6-locale invariant was enforced; for now non-RU/EN users see an EN
// fallback via `t()`'s `dict[key] ?? en[key]` chain. Translating them out
// is a multi-wave effort (Gift Notes, Group Gift, Gift Showcase, Referral,
// FAQ, paywalls) tracked in docs/I18N_BACKLOG.md.
//
// **This list is the only place historical gaps are allowed.** New keys
// added in a feature PR MUST land in all 6 locales — the parity test
// (which excludes this list) will fail otherwise, blocking the merge.
//
// To resolve a backlog entry:
//   1. Add the missing locale value(s) in `i18n.ts`.
//   2. Remove the key from this set.
//   3. Tests will now require the key to exist in ALL 6 locales.
const KNOWN_BACKLOG = new Set<string>([
  'addon_desc_group_gift_unlock',
  'addon_title_group_gift_unlock',
  'api_hint_tg_unreachable',
  'api_invoice_desc_yearly',
  'api_invoice_label_yearly',
  'api_invoice_title_yearly',
  'bot_cs_invite_msg',
  'bot_cs_open_btn',
  'bot_fallback_forward_template',
  'bot_import_pro_btn',
  'bot_import_pro_required',
  'bot_pro_activated_yearly',
  'bot_pro_renewal_1d',
  'bot_pro_renewal_7d',
  'cat_choose',
  'cat_create',
  'cat_create_title',
  'cat_delete',
  'cat_delete_confirm',
  'cat_duplicate_error',
  'cat_empty',
  'cat_limit_error',
  'cat_manage',
  'cat_move_to',
  'cat_name_placeholder',
  'cat_onboarding_hint',
  'cat_rename',
  'cat_rename_title',
  'cat_reorder',
  'cat_reorder_save',
  'cat_uncategorized',
  'changelog_empty_hint',
  'changelog_empty_title',
  'changelog_subtitle',
  'changelog_title',
  'curated_bulk_btn',
  'curated_configure_subtitle',
  'curated_configure_title',
  'curated_continue',
  'curated_copy_link',
  'curated_default_title',
  'curated_disable_link',
  'curated_done',
  'curated_error_subtitle',
  'curated_error_title',
  'curated_expired_body',
  'curated_expired_title',
  'curated_items_label',
  'curated_items_more',
  'curated_link_copied',
  'curated_nudge_subtitle',
  'curated_nudge_title',
  'curated_open_in_telegram',
  'curated_public_badge',
  'curated_public_info',
  'curated_public_valid_until',
  'curated_retry',
  'curated_saved_section',
  'curated_select_subtitle',
  'curated_select_title',
  'curated_selected_count',
  'curated_send_telegram',
  'curated_share_btn',
  'curated_share_cta',
  'curated_snapshot_notice',
  'curated_subscribe_btn',
  'curated_subscribed_toast',
  'curated_success_subtitle',
  'curated_success_title',
  'curated_title_error',
  'curated_title_label',
  'curated_title_placeholder',
  'curated_ttl_badge',
  'curated_ttl_notice',
  'curated_ttl_subscribe_hint',
  'curated_unsubscribe_btn',
  'curated_unsubscribed_toast',
  'error_import_generic',
  'faq_a_br_disable',
  'faq_a_br_mute_one',
  'faq_a_br_no_wishlist',
  'faq_a_br_received',
  'faq_a_br_source',
  'faq_a_br_visibility',
  'faq_q_br_disable',
  'faq_q_br_mute_one',
  'faq_q_br_no_wishlist',
  'faq_q_br_source',
  'faq_q_br_visibility',
  'faq_q_br_why_received',
  'first_share_prompt_copy_link',
  'first_share_prompt_later',
  'first_share_prompt_share_tg',
  'first_share_prompt_subtitle',
  'first_share_prompt_title',
  'home_hdr_reservations_sub_active',
  'home_hdr_reservations_sub_secret',
  'home_hdr_reservations_title',
  'home_hdr_welcome',
  'home_hdr_welcome_fallback',
  'home_hdr_wishes_noun_few',
  'home_hdr_wishes_noun_many',
  'home_hdr_wishes_noun_one',
  'home_hdr_wishes_sub',
  'home_hdr_wishes_title',
  'home_hdr_wishes_wl_noun_few',
  'home_hdr_wishes_wl_noun_many',
  'home_hdr_wishes_wl_noun_one',
  'locked_cta_unlock',
  'locked_history_sub',
  'locked_history_title',
  'locked_items_sub',
  'locked_items_title',
  'locked_subs_sub',
  'locked_subs_title',
  'locked_wl_sub',
  'locked_wl_title',
  'occasion_type_housewarming',
  'onboarding_manual_page_title',
  'onboarding_manual_placeholder',
  'onboarding_manual_price_placeholder',
  'onboarding_manual_submit',
  'onboarding_path_catalog_badge',
  'onboarding_path_catalog_desc',
  'onboarding_path_catalog_title',
  'onboarding_path_import_hint',
  'onboarding_path_import_link',
  'onboarding_path_subtitle',
  'onboarding_path_title',
  'paywall_chip_unlock',
  'paywall_cta_monthly',
  'paywall_cta_yearly',
  'paywall_hero_sub',
  'paywall_hero_title',
  'paywall_new_badge',
  'paywall_plan_monthly_name',
  'paywall_plan_monthly_per',
  'paywall_plan_yearly_name',
  'paywall_plan_yearly_per',
  'paywall_save_badge',
  'paywall_sec_core',
  'paywall_sec_new',
  'paywall_sec_res',
  'paywall_trust',
  'paywall_trust_yearly',
  'plan_pro_f10',
  'plan_pro_f11',
  'plan_pro_f12',
  'plan_pro_f13',
  'plan_pro_f14',
  'plan_pro_res_section',
  'plan_pro_sub10',
  'plan_pro_sub11',
  'plan_pro_sub12',
  'plan_pro_sub13',
  'plan_pro_sub14',
  'profile_subs_block_profiles',
  'profile_subs_block_wishlists',
  'profile_subs_empty_profiles',
  'profile_subs_empty_profiles_hint',
  'public_profile_subscribe',
  'public_profile_subscribe_closed',
  'public_profile_subscribe_toast',
  'public_profile_subscribed',
  'public_profile_unsubscribe_toast',
  'ready_share_prompt_later',
  'ready_share_prompt_share',
  'ready_share_prompt_subtitle',
  'ready_share_prompt_title',
  'referral_badge_pending',
  'referral_badge_rejected',
  'referral_badge_rewarded',
  'referral_cap_at_limit',
  'referral_cap_label',
  'referral_cap_reset_fmt',
  'referral_celebration_body',
  'referral_celebration_cta',
  'referral_celebration_title',
  'referral_disabled_body',
  'referral_disabled_title',
  'referral_empty_progress',
  'referral_error',
  'referral_error_retry',
  'referral_event_pending',
  'referral_event_rejected',
  'referral_event_rejected_meta',
  'referral_event_rewarded',
  'referral_event_rewarded_meta',
  'referral_hero_subtitle',
  'referral_hero_title_active',
  'referral_hero_title_empty',
  'referral_history_empty',
  'referral_history_full_btn',
  'referral_history_section',
  'referral_home_banner_sub',
  'referral_home_banner_title',
  'referral_how_step_1',
  'referral_how_step_2',
  'referral_how_step_3',
  'referral_how_title',
  'referral_link_copied_toast',
  'referral_link_copy_btn',
  'referral_loading',
  'referral_paywall_alt_divider',
  'referral_paywall_alt_sub',
  'referral_paywall_alt_title',
  'referral_post_share_cta',
  'referral_post_share_sub',
  'referral_post_share_title',
  'referral_profile_tile_cta',
  'referral_profile_tile_desc',
  'referral_profile_tile_title',
  'referral_progress_arrived',
  'referral_progress_expired',
  'referral_progress_expires_in',
  'referral_progress_expires_today',
  'referral_progress_need_item',
  'referral_progress_need_wishlist',
  'referral_progress_section',
  'referral_progress_step_none',
  'referral_progress_step_wl_done',
  'referral_rules_btn',
  'referral_rules_cap_b',
  'referral_rules_cap_t',
  'referral_rules_fraud_b',
  'referral_rules_fraud_t',
  'referral_rules_qualify_b',
  'referral_rules_qualify_t',
  'referral_rules_reward_b',
  'referral_rules_reward_t',
  'referral_rules_title',
  'referral_screen_title',
  'referral_share_other_btn',
  'referral_share_sheet_copy_title',
  'referral_share_sheet_other_sub',
  'referral_share_sheet_other_title',
  'referral_share_sheet_sub',
  'referral_share_sheet_tg_sub',
  'referral_share_sheet_tg_title',
  'referral_share_sheet_title',
  'referral_share_text_template',
  'referral_share_tg_btn',
  'referral_stat_in_progress',
  'referral_stat_invited',
  'referral_stat_reward_days',
  'res_cat_all',
  'res_cat_group',
  'res_cat_purchased',
  'res_cat_secret',
  'res_history_empty_hint',
  'res_history_empty_title',
  'res_pro_full_desc',
  'res_pro_full_title',
  'res_pro_upsell_btn',
  'res_pro_upsell_desc',
  'res_pro_upsell_detail_desc',
  'res_pro_upsell_detail_title',
  'res_pro_upsell_history_desc',
  'res_pro_upsell_history_title',
  'res_pro_upsell_title',
  'res_purchased_confirm_body',
  'res_purchased_confirm_title',
  'res_purchased_confirm_yes',
  'res_sort_activity',
  'res_sort_date',
  'res_sort_price_asc',
  'res_sort_price_desc',
  'res_sort_title',
  'res_stat_active',
  'res_stat_history',
  'res_stat_secret',
  'settings_changelog',
  'showcase_bio_limit',
  'showcase_brand_limit_reached',
  'showcase_cover_remove_confirm',
  'showcase_cover_remove_desc',
  'showcase_cover_remove_title',
  'showcase_editor_heading',
  'showcase_editor_heading_desc',
  'showcase_editor_preview',
  'showcase_editor_preview_cta',
  'showcase_editor_save',
  'showcase_editor_saved',
  'showcase_editor_saving',
  'showcase_editor_title',
  'showcase_entry_desc',
  'showcase_entry_empty_cta',
  'showcase_entry_expired_badge',
  'showcase_entry_expired_note',
  'showcase_entry_full_cta',
  'showcase_entry_locked_cta',
  'showcase_entry_title',
  'showcase_input_clear',
  'showcase_measurements_title',
  'showcase_paywall_antigift',
  'showcase_paywall_cover',
  'showcase_paywall_cta',
  'showcase_paywall_desc',
  'showcase_paywall_pinned',
  'showcase_paywall_pref',
  'showcase_paywall_title',
  'showcase_pref_limit',
  'showcase_preview_back',
  'showcase_preview_title',
  'showcase_progress_hint_empty',
  'showcase_progress_hint_full',
  'showcase_progress_hint_partial',
  'showcase_progress_title_almost',
  'showcase_progress_title_default',
  'showcase_progress_title_full',
  'showcase_public_antigift_title',
  'showcase_public_brands_title',
  'showcase_public_featured_title',
  'showcase_public_open_wishlist',
  'showcase_public_other_title',
  'showcase_public_preferences_title',
  'showcase_public_sizes_title',
  'showcase_public_wishlists_title',
  'showcase_published_desc',
  'showcase_published_later',
  'showcase_published_share',
  'showcase_published_title',
  'showcase_section_antigift',
  'showcase_section_antigift_cta',
  'showcase_section_antigift_desc',
  'showcase_section_bio',
  'showcase_section_bio_desc',
  'showcase_section_bio_placeholder',
  'showcase_section_brands',
  'showcase_section_brands_add',
  'showcase_section_brands_desc',
  'showcase_section_brands_limit',
  'showcase_section_brands_placeholder',
  'showcase_section_configured',
  'showcase_section_cover',
  'showcase_section_cover_desc',
  'showcase_section_cover_remove',
  'showcase_section_cover_replace',
  'showcase_section_cover_upload',
  'showcase_section_cover_uploading',
  'showcase_section_done',
  'showcase_section_empty',
  'showcase_section_not_filled',
  'showcase_section_pinned',
  'showcase_section_pinned_desc',
  'showcase_section_pinned_empty',
  'showcase_section_pinned_limit',
  'showcase_section_preferences',
  'showcase_section_preferences_desc',
  'showcase_section_preferences_placeholder',
  'showcase_section_sizes',
  'showcase_section_sizes_desc',
  'showcase_share_text',
  'showcase_size_chest',
  'showcase_size_clothing',
  'showcase_size_hips',
  'showcase_size_other',
  'showcase_size_placeholder_chest',
  'showcase_size_placeholder_clothing',
  'showcase_size_placeholder_hips',
  'showcase_size_placeholder_other',
  'showcase_size_placeholder_ring',
  'showcase_size_placeholder_shoes',
  'showcase_size_placeholder_waist',
  'showcase_size_ring',
  'showcase_size_shoes',
  'showcase_size_waist',
  'upsell_categories_b1',
  'upsell_categories_b2',
  'upsell_categories_b3',
  'upsell_categories_subtitle',
  'upsell_categories_title',
  'upsell_curated_b1',
  'upsell_curated_b2',
  'upsell_curated_b3',
  'upsell_curated_subtitle',
  'upsell_curated_title',
  'wishes_filter_reserved',
  'wishes_sec_by_priority',
  'wishes_sec_reserved',
  'wl_meta_comments_all',
  'wl_meta_comments_subs',
  'wl_meta_visibility_link',
  'wl_meta_visibility_private',
  'wl_meta_visibility_public',
  'wl_stat_purchased',
  'wl_stat_reserved',
  'wl_stat_wishes',

]);

describe('i18n key parity — every key must exist in every locale', () => {
  // Union of all keys across all locale dicts. The "source of truth" for
  // "this key is part of the i18n surface" — if a key is in ANY dict it
  // must be in ALL dicts.
  const allKeys = new Set<string>();
  for (const loc of SUPPORTED_LOCALES) {
    for (const k of Object.keys(dicts[loc])) allKeys.add(k);
  }

  it('every key from any locale exists in all 6 locale dicts (except KNOWN_BACKLOG)', () => {
    const missingByLocale: Record<string, string[]> = {};
    for (const loc of SUPPORTED_LOCALES) {
      const dict = dicts[loc];
      const missing: string[] = [];
      for (const key of allKeys) {
        if (KNOWN_BACKLOG.has(key)) continue;
        if (!(key in dict)) missing.push(key);
      }
      if (missing.length > 0) missingByLocale[loc] = missing;
    }
    // Empty object = no missing keys anywhere. Assertion shape gives a
    // readable diff when it fails: each locale lists which keys it lacks.
    expect(missingByLocale).toEqual({});
  });

  it('every locale dict has the same set of NON-backlog keys', () => {
    // Build the canonical set: union of keys minus backlog entries.
    const canonical = new Set<string>();
    for (const loc of SUPPORTED_LOCALES) {
      for (const k of Object.keys(dicts[loc])) {
        if (!KNOWN_BACKLOG.has(k)) canonical.add(k);
      }
    }
    // Every locale must have every canonical key.
    for (const loc of SUPPORTED_LOCALES) {
      const missing: string[] = [];
      for (const key of canonical) {
        if (!(key in dicts[loc])) missing.push(key);
      }
      expect(missing, `${loc} missing canonical keys`).toEqual([]);
    }
  });

  it('KNOWN_BACKLOG only references real keys (no stale entries)', () => {
    // Prevent the backlog from rotting: if a key listed here no longer
    // exists in any dict, it should be removed from the list (the original
    // gap has been closed). Stale entries weaken the guard.
    const allDictKeys = new Set<string>();
    for (const loc of SUPPORTED_LOCALES) {
      for (const k of Object.keys(dicts[loc])) allDictKeys.add(k);
    }
    const stale = [...KNOWN_BACKLOG].filter(k => !allDictKeys.has(k));
    expect(stale, 'stale entries in KNOWN_BACKLOG').toEqual([]);
  });

  it('KNOWN_BACKLOG only references keys that are actually missing from some locale', () => {
    // Prevent over-suppression: if a key is in KNOWN_BACKLOG but happens to
    // exist in all 6 locale dicts, the entry is no-op and should be removed.
    const overSuppressed: string[] = [];
    for (const key of KNOWN_BACKLOG) {
      const missingFromSome = SUPPORTED_LOCALES.some(loc => !(key in dicts[loc]));
      if (!missingFromSome) overSuppressed.push(key);
    }
    expect(overSuppressed, 'KNOWN_BACKLOG entries that are no longer missing anywhere').toEqual([]);
  });

  // Keys that are INTENTIONALLY empty in specific locales. Each entry needs
  // a comment explaining the use-case so the next reviewer can audit.
  const INTENTIONAL_EMPTY: Record<string, Set<Locale>> = {
    // The disclaimer renders only when locale !== 'ru' (the doc is in Russian
    // by default and doesn't need the "Russian version prevails" line in its
    // own language). See MiniApp.tsx:21709 — `showDisclaimer = locale !== 'ru'`.
    legal_locale_disclaimer: new Set<Locale>(['ru']),
  };

  it('no empty-string values (with documented exemptions)', () => {
    const emptyByLocale: Record<string, string[]> = {};
    for (const loc of SUPPORTED_LOCALES) {
      const empty: string[] = [];
      for (const [key, value] of Object.entries(dicts[loc])) {
        if (typeof value !== 'string' || value.length === 0) {
          if (INTENTIONAL_EMPTY[key]?.has(loc)) continue;
          empty.push(key);
        }
      }
      if (empty.length > 0) emptyByLocale[loc] = empty;
    }
    expect(emptyByLocale).toEqual({});
  });
});

describe('i18n content audit — no untranslated English in non-EN locales', () => {
  // Per-locale script regex. A value containing at least one character in
  // this range is presumed translated. Values without any local script are
  // suspect — must either contain valid non-script content (markup,
  // placeholder, brand name) or appear in the whitelist.
  const SCRIPT: Record<string, RegExp> = {
    'zh-CN': /[一-鿿㐀-䶿]/,                // CJK Unified Ideographs
    hi: /[ऀ-ॿ]/,                                  // Devanagari
    ar: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/, // Arabic + extensions
  };

  // Keys whose value is INTENTIONALLY kept identical to (or close to) the
  // English form across non-EN locales. Document each with a one-line
  // reason — the reviewer should ask "still true?" on every addition.
  //
  // Categories:
  //   - **Brand names**: product / company names that don't translate.
  //   - **Currency / unit codes**: ISO currency codes, time-unit abbreviations.
  //   - **Promo codes**: literal coupon strings.
  //   - **Pure markup / placeholder-only**: `<b>{{title}}</b>`, `🎂 {date}`.
  //   - **Search-query tokens**: literal search terms the search backend
  //     matches against user-typed text in their items (which may be EN even
  //     when UI is in another locale).
  //   - **Spanish cognates**: words spelled identically in Spanish and English
  //     ("Plan", "Auto", "Error", "Ideas") — true Spanish translations, not
  //     stubs.
  const INTENTIONAL_EN_KEYS = new Set<string>([
    // Brand names + product names
    'bot_menu_btn',                            // Telegram bot menu text — brand-style label
    'catalog_airpods',                         // brand
    'catalog_kindle',                          // brand
    'br_pro_badge',                            // "PRO" label is a brand mark
    'settings_pro_badge',                      // "Pro" label is a brand mark
    'plan_pro_block',                          // Has "Pro" brand prefix in many locales
    'faq_sec_santa',                           // "Secret Santa" is a brand-style feature name (some locales keep)
    // Currency + unit + time codes
    'currency_rub',                            // "₽ RUB" ISO code
    'currency_usd',                            // "$ USD" ISO code
    'addon_stars_price',                       // "{{price}} Stars" — Stars is Telegram brand
    'unit_days_short', 'unit_hours_short',     // "d"/"h" single-char units
    'time_days_short', 'time_hours_short',     // duplicate of unit_* — single-char units
    'gn_days_abbr',                            // "d"
    'link_day_short',                          // "d"
    // Promo codes (literal coupon string)
    'wb_promo_code_label',                     // "WISHPRO"
    // Pure markup / placeholder-only values
    'bot_br_friend_custom_message_wrap',       // "<i>«{message}»</i>"
    'br_badge_date',                           // "🎂 {date}"
    'notif_res_reminder_body',                 // "<b>{{title}}</b>"
    'notif_res_reminder_body_with_price',      // "<b>{{title}}</b> — {{price}}"
    'notif_res_reminder_note',                 // "📝 {{note}}"
    'sr_detail_chip_owner',                    // "👤 {{name}}"
    'profile_username_placeholder',            // "username" — input placeholder kept terse
    // Search-query tokens — must literally match user-typed words (pre-existing,
    // keeps the search keyword in EN regardless of UI locale so an EN item title
    // ("Important book") still matches the "important" tile)
    'search_tile_important_query',
    'search_tile_expiring_query',
    'search_tile_secret_query',
    'search_tile_with_link_hint',              // "url" — marker token
  ]);

  // Spanish-specific: words that are spelled identically in Spanish and
  // English are cognates, not stubs. Don't flag them.
  const ES_COGNATE_KEYS = new Set<string>([
    'settings_card_auto',                       // "Auto" both ES and EN
    'settings_general',                         // "General"
    'settings_plan',                            // "Plan"
    'stats_total',                              // "Total"
    'toast_error_generic',                      // "Error"
    'gn_ideas_label',                           // "Ideas"
    'gn_ideas_count',                           // "Ideas: {{n}}"
    'gn_ideas_count_label',                     // "ideas"
    'catalog_perfume',                          // "Perfume"
    'dont_gift_preset_perfume',                 // "Perfume"
    'dont_gift_preset_alcohol',                 // "Alcohol"
    'dont_gift_preset_souvenirs',               // "Souvenirs"
    // Gift Notes cognates (gn_* — wave 1)
    'gn_demo_ideas_count',                      // "💡 3 ideas"
    'gn_ob_s3_demo_chip',                       // "3 ideas"
    // Group Gift cognates (gg_* — wave 2)
    'gg_chat_title',                            // "Chat" (es == en)
  ]);

  // Item-URL hints: lists of marketplace brand names with locale-specific
  // separators (zh-CN/ar use their punctuation; hi/es use ASCII commas).
  // The values are 95%+ brand names — keep them out of the audit.
  const URL_HINT_KEYS = new Set<string>([
    'item_url_hint_global',
    'item_url_hint_ru',
  ]);

  function valueLooksLikeEnglishStub(
    key: string,
    value: string,
    en: string,
    locale: 'zh-CN' | 'hi' | 'es' | 'ar',
  ): boolean {
    // Skip whitelisted keys outright
    if (INTENTIONAL_EN_KEYS.has(key)) return false;
    if (URL_HINT_KEYS.has(key)) return false;
    // Skip empty / non-letter values
    if (!value || !/[a-zA-Z]/.test(value)) return false;

    if (locale === 'es') {
      // Spanish uses Latin script — heuristic is "value identical to EN
      // value" (suggests author left it untranslated). Allow documented
      // cognates.
      if (ES_COGNATE_KEYS.has(key)) return false;
      return value === en;
    }

    // zh-CN / hi / ar: value must contain at least one character in the
    // locale's script. Lack of script => looks like English stub.
    const re = SCRIPT[locale];
    if (!re) throw new Error(`No script regex for ${locale}`);
    return !re.test(value);
  }

  for (const locale of ['zh-CN', 'hi', 'es', 'ar'] as const) {
    it(`${locale}: no untranslated English stubs (whitelist: brand names + units + codes + cognates)`, () => {
      const stubs: Array<{ key: string; value: string }> = [];
      const dict = dicts[locale];
      const en = dicts.en;
      for (const [key, raw] of Object.entries(dict)) {
        if (typeof raw !== 'string') continue;
        const value: string = raw;
        if (valueLooksLikeEnglishStub(key, value, en[key] ?? '', locale)) {
          stubs.push({ key, value });
        }
      }
      // Empty array = all values look localized. Assertion shape gives a
      // readable list of remaining stubs.
      expect(stubs).toEqual([]);
    });
  }
});
