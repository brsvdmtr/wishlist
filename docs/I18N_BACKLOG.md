# i18n translation backlog

**STATUS: COMPLETE as of 2026-05-17 (waves 1-10).** All 552 historical
backlog keys have been translated to all 6 locales. KNOWN_BACKLOG in
`packages/shared/src/i18n.parity.test.ts` is now empty.

## CI guard

The parity test at [`packages/shared/src/i18n.parity.test.ts`](../packages/shared/src/i18n.parity.test.ts) **blocks
any new key** added in a feature PR from missing any of the 6 locales.
Going forward, every new feature ships with all 6 locale translations
in the same PR — the test will fail otherwise.

## Wave history (closed)

| Wave | Feature area               | Key prefix        | Count | Commit |
|------|----------------------------|-------------------|-------|--------|
| 1    | Gift Notes onboarding/UI   | `gn_*`            | 91    | 377432e |
| 2    | Group Gift                 | `gg_*`            | 73    | 4833384 |
| 3    | Gift Showcase + profiles   | `showcase_*`, `public_profile_*`, `profile_subs_*` | 104 | 6a2e43e |
| 4    | Curated Selections         | `curated_*`       | 42    | 0441b3d |
| 5    | Referral + share prompts   | `referral_*`, `ready_share_*`, `first_share_*` | 85 | 06e568d |
| 6    | Home / Onboarding / Locked | `home_*`, `onboarding_*`, `locked_*` | 33 | b20c865 |
| 7    | FAQ                        | `faq_q_*`, `faq_a_*` | 12 | 9fc79c3 |
| 8    | Categories                 | `cat_*`           | 17    | daa0479 |
| 9    | Paywalls tail              | `paywall_*`, `plan_pro_*`, `upsell_*` | 37 | 7fb64bd |
| 10   | Misc (res_*, wishes_*, wl_*, addon_*, api_*, bot_*, error_*, changelog_*, occasion_*, settings_changelog) | various | 58 | this commit |

**Total**: 552 keys × 4 locales = ~2,208 translations + ~10 ES cognate
whitelists.

## Going forward

When adding a new key to `packages/shared/src/i18n.ts`:
1. Add the key to ALL 6 locale dicts (ru, en, zh-CN, hi, es, ar).
2. Run `pnpm -C packages/shared test` to verify parity.
3. If a value should remain identical to EN (brand name, unit code,
   pure-markup placeholder), add it to `INTENTIONAL_EN_KEYS` or
   `ES_COGNATE_KEYS` in the parity test with an inline comment
   explaining why.

When in doubt, run the test — it tells you exactly what's missing.
