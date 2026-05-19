# Survey PMF v1 — Source of Truth

**Slug.** `pmf-discovery`
**Version.** `1` (frozen at release; bump to `2` for any optionId change)
**Status field model.** `DRAFT` → `ACTIVE` → `CLOSED`
**Status (2026-05-19).** DRAFT — `ResearchSurvey` row not yet created in prod.
**Wave 1 locales.** `ru`, `en` only. `zh-CN` / `hi` / `es` / `ar` skipped for
this wave; keys are reserved but not populated.

This document mirrors the code constant
[`SURVEY_PMF_V1`](../../apps/api/src/services/research-survey/survey-pmf-v1.ts).
If they ever drift, **the code wins** — never the doc. Update doc and code in
the same commit.

---

## Survey design intent

Short PMF-discovery survey targeting 6 user segments (S1/S2/S3/S5/S7/S8) to
answer:

- *why* people tried WishBoard,
- *what was useful*,
- *what blocked them*,
- *whether they shared*,
- *what's missing*,
- *what they'd pay for*,
- *Sean Ellis PMF signal* + *NPS*,
- *open-ended "what would you change"*.

Volume cap: ≤275 invites for Wave 1 (S1..S7 unbounded but small; S8 capped
at 150 with behavioral stratification). Expected response rate 15–25 %.

---

## Questions

### Q1 — Why did you try WishBoard? (single)

| optionId | ru | en |
|----------|-----|-----|
| `curiosity` | Просто посмотреть | Just curious |
| `gift_planning` | Искал что подарить кому-то | Looking for a gift idea |
| `birthday_self` | Мой день рождения близко | My birthday is coming up |
| `holiday` | Новый год или другой праздник | New Year or another holiday |
| `wedding` | Свадьба или крупное событие | Wedding or a major event |
| `baby_registry` | Рождение ребёнка | New baby |
| `friend_invite` | Друг прислал ссылку | A friend sent me a link |
| `replace_other_tool` | Хотел заменить заметки/Excel | Wanted to replace notes/Excel |
| `other` | Другое | Other |

### Q2 — Occasion (single)

`own_birthday` · `partner_birthday` · `kid_birthday` · `friend_birthday` ·
`new_year_christmas` · `wedding` · `baby_shower` · `housewarming` ·
`self_treat` · `no_specific_occasion` · `other`

### Q3 — Most useful (multi, max 2)

`adding_items` · `url_import` · `share_link` · `reservations_anonymous` ·
`multiple_wishlists` · `birthday_calendar` · `categories` · `hints` ·
`pro_features` · `mini_app_in_telegram` · `nothing_special` · `other`

### Q4 — What blocked you (single)

`ui_confusing` · `url_import_broken` · `friends_not_in_telegram` ·
`nobody_to_share_with` · `forgot_to_use` · `not_enough_features` ·
`bugs_or_crashes` · `not_relevant_now` · `nothing_blocked` · `other`

### Q5 — Did you share (single)

`yes_friends_family` · `yes_partner_only` · `yes_link_no_response` ·
`no_didnt_want` · `no_didnt_know_how` · `no_nothing_to_share` ·
`no_too_early`

### Q6 — What would help you use it more (multi, max 2)

`reminders_birthdays` · `reminders_my_own` · `url_import_better` ·
`shopping_assistant` · `group_gifting` · `price_drop_alerts` ·
`friends_already_inside` · `web_version` · `nothing_would_help` ·
`other`

### Q7 — What's fair to charge for (multi, max 2)

`unlimited_wishlists` · `unlimited_items` · `ai_suggestions` ·
`group_gifting` · `private_wishlists` · `secret_santa` · `price_tracking` ·
`premium_calendar` · `gift_history` · `nothing_worth_paying` · `other`

### Q8 — Sean Ellis PMF (single)

`very_disappointed` · `somewhat_disappointed` · `not_disappointed` ·
`not_using_anyway`

The standard PMF threshold ≥ 40 % `very_disappointed` is the bar we're
benchmarking against.

### Q9 — NPS 0–10 (nps)

Options `score_0` … `score_10`. UI renders as 11 buttons in a 6-column grid
(score_0..score_5 wraps to a second row score_6..score_10 + filler).

### Q10 — Open text (open, optional)

Single optionId `__text__`, `answerText` up to 500 chars (server-side trim,
control-char reject). Question is skippable.

---

## Answer storage shape

```
ResearchSurveyAnswer
  responseId       — FK
  questionId       — 'q1'..'q10'
  optionId         — frozen ID (see above) OR 'score_0'..'score_10' OR '__text__'
  answerText       — populated ONLY when optionId IN ('__text__', 'other'), max 500
  @@unique (responseId, questionId, optionId)
```

Re-answering a question on the client triggers a transactional
`deleteMany(responseId, questionId) → createMany(new rows)` — no upserts, no
residual rows. See [`submitAnswer`](../../apps/api/src/services/research-survey/index.ts).

---

## Locale gating

Code: [`resolveSurveyLocale`](../../apps/api/src/services/research-survey/locale.ts).

```
1. manualLanguage (if languageMode='manual') — respect explicit choice
   manual ∈ {ru, en} → that locale
   manual ∈ {zh-CN, hi, es, ar} → null (skip Wave 1)
2. resolver chain (live Telegram → normalizedLocale → legacy language → default en)
3. If resolver=ru → ru
4. ru-like BCP-47 prefix override (uk, be, kk, ky, uz, tg, ka, hy from
   live_telegram or legacy.language) OR marketBucket='ru' → ru
5. resolver=en → en
6. resolver ∈ {zh-CN, hi, es, ar} → null (skip Wave 1)
```

---

## Reward semantics

On `/complete` (inside one transaction):

| pre-state | post-state | rewardKind |
|-----------|------------|------------|
| No active Subscription | new Subscription, +30 days, `source='survey_reward:pmf-discovery'`, `billingPeriod='one_time'`, `cancelAtPeriodEnd=true` | `pro_30d` |
| Active monthly/yearly | `currentPeriodEnd += 30 days` | `pro_30d` |
| `billingPeriod='lifetime'` | **no Subscription mutation** | `pro_30d_lifetime_noop` |

`response.rewardGrantedAt` is set in all three branches. Repeat `/complete`
short-circuits on `rewardGrantedAt != null` (no double-grant, no second
emit of `survey.completed`).

---

## Decision log

- **2026-05-19** — design v1.2 approved. Multi-choice via composite
  `UNIQUE(responseId, questionId, optionId)`; lifetime users get a no-op
  reward bookkeeping row; Wave 1 ru/en only; S8 stratified across 5
  behavioral substrata; new-user grace 7 days; lifecycle-survey grace 24 h.
- **2026-05-19** — Q3 / Q6 / Q7 cardinality cap set to 2 (multi). UI shows
  hint "Выбери до 2 вариантов" / "Choose up to 2".
- **2026-05-19** — Q10 optional; explicit Skip button. Abandonment
  (close-tab without `/dismiss`) leaves `STARTED` so analytics can
  distinguish "explicit refusal" from "left mid-flow".

---

## Future waves

- **v2 locale expansion** — add hand-translated copy for `zh-CN`, `hi`,
  `es`, `ar` before sending to those audiences. Bump `i18n.parity.test.ts`
  `KNOWN_BACKLOG` once entries close.
- **v2 question changes** — if any optionId changes meaning, bump
  `ResearchSurvey.version = 2` and ship a new `SURVEY_PMF_V2` const.
  Existing v1 responses remain queryable; new invites attach to v2.
- **Per-segment invite copy** — pre-approved variants for S2 ("created
  but not shared") and S5 ("guest reservers"). Hook is in place
  (`research_survey_invite_message` is keyed by slug; can ship
  `_s2`/`_s5` variants without code change).
