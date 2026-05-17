# i18n translation backlog

Status: **552 keys** exist in RU/EN but are missing from one or more of
zh-CN/hi/es/ar locale blocks in `packages/shared/src/i18n.ts`. These shipped
before the 6-locale invariant was enforced; non-RU/EN users currently see an
EN fallback via `t()`'s `dict[key] ?? en[key]` chain.

## CI guard

The parity test at [`packages/shared/src/i18n.parity.test.ts`](../packages/shared/src/i18n.parity.test.ts) **blocks
any new key** added in a feature PR from missing any of the 6 locales.
Historical gaps are explicitly listed in `KNOWN_BACKLOG`; the test asserts
that this list only contains real gaps (no stale entries) and that no
backlog entry is over-suppressed (key actually present in all locales).

**This is the only place historical gaps are allowed.** Once a key is
translated across all 6 locales, remove it from the backlog list — the test
will then require it to remain in all 6 forever.

## Resolution waves

Translate by feature area, one wave per PR, easier to review than a single
mega-commit:

| Wave | Feature area               | Key prefix        | Count |
|------|----------------------------|-------------------|-------|
| 1    | Gift Notes onboarding/UI   | `gn_*`            | ~90   |
| 2    | Group Gift                 | `gg_*`            | ~73   |
| 3    | Gift Showcase              | `showcase_*`, `public_profile_*`, `profile_subs_*` | ~70 |
| 4    | Curated Selections         | `curated_*`       | ~42   |
| 5    | Referral system            | `referral_*`, `ready_share_*`, `first_share_*` | ~35 |
| 6    | Home / Onboarding / Locked | `home_*`, `onboarding_*`, `locked_*` | ~33 |
| 7    | FAQ (questions + answers)  | `faq_q_*`, `faq_a_*`, `faq_sec_*` | ~12 |
| 8    | Categories                 | `cat_*`           | ~17 |
| 9    | Paywalls / plan_pro tail   | `paywall_*`, `plan_pro_f20+`, `upsell_*` | ~30 |
| 10   | Misc — wishes section, stats, wl meta, changelog, error_*, occasion_*, etc. | various | ~50 |

Each wave PR pattern:
1. Translate ~30-90 keys × 4 locales = 120-360 strings.
2. Remove translated keys from `KNOWN_BACKLOG` in
   `packages/shared/src/i18n.parity.test.ts`.
3. Verify: `pnpm -C packages/shared test` — parity tests now require these
   keys in all 6 locales.
4. Run iterative code-review (`/anthropic-skills:code-review`) targeting
   translation quality.

## How to discover what's still missing

```bash
# List all backlog keys
grep -oE "'[a-zA-Z_][a-zA-Z_0-9]+'" \
  packages/shared/src/i18n.parity.test.ts | sort -u | wc -l

# Group backlog by prefix to plan next wave
grep -oE "'[a-zA-Z_]+_" packages/shared/src/i18n.parity.test.ts \
  | sort | uniq -c | sort -rn | head -20
```

## Why these gaps existed

The Mini App started as a RU-first product (2026-03). EN was added 2026-04
as a side-by-side translation. The 4 additional locales (zh-CN, hi, es, ar)
were added 2026-05 with a partial first pass — primary product flows
(home, item details, paywall, search) were translated, but secondary
feature areas (Gift Notes, Group Gift, Gift Showcase, etc.) were left as
EN-fallback "to ship the localized MVP fast". This backlog completes that
work.

Going forward, every new feature MUST ship with all 6 locales in the same
PR (the parity test enforces this).
