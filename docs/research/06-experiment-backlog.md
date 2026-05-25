# 06 — Experiment Backlog (WishBoard Telegram Mini App)

> Growth backlog для wishlist-бота. Источники: `docs/CURRENT_PRODUCT_STATE.md`, `docs/USER_FLOWS.md`, `docs/MONETIZATION.md`, `docs/ONBOARDING_AND_ACTIVATION.md`, `docs/design-system/FEATURE_INVENTORY.md`, `packages/shared/src/analyticsEvents.ts`.
> Last updated: 2026-05-19.
> Owner: solo founder (рассматривать сложность реализации с учётом 1 engineer × monolith codebase).

---

## 0. Контекст и допущения

**Где мы сейчас (по дашборду God Mode):**

- Активация = «реальный wish в REGULAR-вишлисте» (см. `ONBOARDING_AND_ACTIVATION.md`).
- Onboarding v2_try выиграл A/B; v1 deprecated. Дальнейшие A/B запускаются **внутри v2** (без отката).
- Sharing завязан на стартовый параметр `share_<token>`; «холодного» web-share без бота нет (всё через `t.me/{BOT_USERNAME}?startapp=`).
- Guest-режим обнаруживает owner-collision (Flow 19) и переключается тихо — поэтому «owner-as-guest» не путает метрики reservation.
- PRO стек: Monthly 100 ⭐ / Yearly 800 ⭐ / Lifetime 2 490 ⭐. Lifetime — anchor (введён 2026-05-09, ещё не успел зарелаксировать конверсию Monthly).
- Add-ons: Group Gift 79 ⭐, Secret Reservation 24 ⭐, Smart Reservations 39 ⭐ / wishlist, Gift Notes 19 ⭐ (PRO incl.).
- Referral — feature-flag off (`ReferralProgramConfig.enabled = false` с 2026-05-25; до этого был случайно ON 38 дней — см. [`referral-decision.md`](./referral-decision.md)); не идёт в backlog как «вкл/выкл», а только как сегмент сравнения, если включится.
- Лайфтайм-данные хранятся в `AnalyticsEvent` (90-day TTL, см. `KNOWN_GAPS_AND_RISKS.md` § 43) — эксперименты с window > 90d требуют отдельной таблицы.

**Что считаем «знаком к пивоту»:**

Если после E01/E03/E04 (снятие фрикций активации) **D1 activation** не сдвигается и одновременно **paywall conversion** на E17–E22 ниже 1.5 % после 14 дней — продукт не в product-market-fit, нужен качественный пивот (узкие use-cases: birthday-only, gift-list-for-couples, etc.).

**Методика:**

- **Primary metric** — то, что меняем. Считаем по cohort, не по событию.
- **Guardrail metrics** — что не должно сломаться (e.g., revenue, churn, error rate).
- **MDE** — минимальный детектируемый эффект (relative). При текущих ~150 новых users / день экспозиция в 14 дней даёт ~2 100 users / arm — достаточно для MDE ≈ 8 %.
- **ICE** = Impact × Confidence × Ease, 1–10 каждый. RICE = Reach × Impact × Confidence / Effort, где Effort — недели.
- **Holdout 5 %** — никогда не входит в экспозицию ни одного активного эксперимента; служит «честным» бейзлайном.

**Технический долг, который мешает экспериментам:**

- `apps/web/app/miniapp/MiniApp.tsx` — монолит 33 k LOC; новые UI-variants дорого выкатывать, нужен `useExperiment(key)` хук + контекст. **Phase 0** (1 неделя) — собрать инфру: `experiment_assigned` событие, серверный sticky-bucket по `userId`, env-флаги `EXP_<NAME>_ENABLED` и `EXP_<NAME>_ROLLOUT`.

---

## 1. Сводная таблица приоритетов (ICE)

| # | Название | Фокус | Сложность | Impact | Confidence | Ease | ICE |
|---|---|---|---|---|---|---|---|
| E01 | Demo-first preview до аккаунта | Activation | medium | 8 | 6 | 5 | 240 |
| E02 | Single-screen onboarding (компрессия) | Activation | medium | 7 | 7 | 5 | 245 |
| E03 | 3 бесплатных URL import в первые 24h | Activation / first item | low | 9 | 8 | 8 | 576 |
| E04 | Auto-created default wishlist | Activation | low | 6 | 7 | 9 | 378 |
| E05 | «Я тут как гость» альт-путь онбординга | Activation / G→O | medium | 7 | 6 | 5 | 210 |
| E06 | Inline URL import без Drafts-крюка | First item | medium | 8 | 8 | 5 | 320 |
| E07 | Smart input (URL **или** title в одном поле) | First item | low | 6 | 7 | 8 | 336 |
| E08 | Force-share gate после 1-го реального wish | Sharing | low | 9 | 7 | 8 | 504 |
| E09 | Rich share preview card (item count + thumbnails) | Sharing | medium | 7 | 7 | 5 | 245 |
| E10 | Share через Telegram contact picker | Sharing | high | 8 | 5 | 3 | 120 |
| E11 | Account-claim CTA сразу после резерва | Guest → Owner | low | 9 | 8 | 8 | 576 |
| E12 | Reciprocity DM «отправь свой вишлист в ответ» | Guest → Owner | medium | 8 | 6 | 6 | 288 |
| E13 | Guest-view banner «Создать свой вишлист» | Guest → Owner | low | 6 | 7 | 9 | 378 |
| E14 | Anonymous reserve (без display name) | Reservations | low | 7 | 7 | 8 | 392 |
| E15 | Display-name prefill из Telegram identity | Reservations | low | 7 | 8 | 9 | 504 |
| E16 | Explicit «Surprise mode» trust copy | No-spoiler trust | low | 5 | 6 | 9 | 270 |
| E17 | Yearly price test 800 → {600, 1000} | Pricing | low | 8 | 6 | 8 | 384 |
| E18 | Loss-aversion paywall copy | Pricing | low | 6 | 6 | 9 | 324 |
| E19 | 7-day PRO free trial | Paywall / WTP | medium | 9 | 6 | 5 | 270 |
| E20 | Choose-your-price probe (one-shot survey) | WTP / Pivot | low | 6 | 7 | 9 | 378 |
| E21 | Event Pass: 30-day PRO за 49 ⭐ | PRO vs event pass | medium | 9 | 7 | 5 | 315 |
| E22 | Birthday Pass: PRO-окно вокруг своего ДР | PRO vs event pass | high | 7 | 5 | 3 | 105 |
| E23 | Santa pre-season teaser DM (Nov 1) | Secret Santa | low | 8 | 7 | 8 | 448 |
| E24 | Group Gift price 79 → 39 ⭐ | Monetization | low | 7 | 7 | 9 | 441 |
| E25 | Reservation purchase reminder для FREE | Reminders | medium | 7 | 6 | 6 | 252 |

**Топ-7 для немедленного запуска (ICE ≥ 400):** E03, E11, E08, E15, E23, E24, E14.

---

## 2. Эксперименты

> Формат: 14 полей. События аналитики записаны как добавление к `packages/shared/src/analyticsEvents.ts` (если не существуют) либо ссылка на существующее.

---

### E01 — Demo-first preview до аккаунта

1. **Название.** Demo-first preview (real wishlist mock before any account action).
2. **Гипотеза.** Если показать пустой «как будто свой» вишлист с тремя демо-карточками *до* первого `POST /tg/onboarding/start`, доля пользователей, дошедших до создания первого реального item, вырастет на 15 % — потому что снижается тревога «нужно ли вообще регистрироваться».
3. **Сегмент.** Все новые пользователи (нет `User` row до момента взаимодействия). Эксперимент по `tg_user.id`, sticky bucket, holdout 5 %.
4. **Что меняем.** `onboarding-entry` заменяется на интерактивный preview-экран: 3 категории желаний (по market segment) уже «лежат» на экране, пользователь может поставить лайк / убрать / добавить четвёртое. После любого действия — fade-in CTA «Сохранить как мой вишлист» → отсюда регистрация. Старый flow остаётся за фича-флагом.
5. **События аналитики.** Новые: `onboarding_preview.shown`, `onboarding_preview.item_added`, `onboarding_preview.item_removed`, `onboarding_preview.cta_clicked`, `onboarding_preview.skipped`. Существующие переиспользуем: `onboarding_completed`, `wish.created`.
6. **Primary metric.** D0 activation rate = `% users c ≥ 1 real wish in REGULAR wishlist within first session`.
7. **Guardrail metrics.** Bootstrap success rate (≥ 99.5 %), `error:*` events (no spike), Time-to-First-Item p50 (не должна вырасти > 2× от текущей).
8. **Ожидаемый эффект.** D0 activation +12…18 % relative; small negative на «onboarding_completed» (часть юзеров уйдёт в режим preview-only без формального завершения).
9. **Сложность.** Medium. Нужен новый компонент + изменение eligibility-check на API (`/tg/onboarding/status` должен пускать без `User` row, но это коллидирует с `getOrCreateTgUser` в bootstrap — потребует guarded refactor).
10. **Риск.** Demo-only users никогда не активируются; «активность без аккаунта» создаёт мусорные `AnalyticsEvent` без `userId`. Mitigation: писать `tgUserId` (Telegram-side, не наш FK) для всех preview-событий.
11. **Приоритет ICE/RICE.** ICE 240. RICE = (12 000 × 8 × 0.6) / 3 = 19 200.
12. **Что считать успехом.** D0 activation +≥ 10 % relative, p < 0.05, без регрессии guardrails в течение 14 дней.
13. **Если успех.** Закатываем preview как default-onboarding entry, переименовываем `onboarding-entry` → `onboarding-preview`, документируем в `USER_FLOWS.md` Flow 1.
14. **Если провал.** Если D0 не двигается > ±3 %: возвращаем v2_try. Если D0 двигается отрицательно: смотрим воронку — наверняка преview-users «уходят довольными» без активации, что = pivot-signal (нужен gift-list-for-couples micro-product).

---

### E02 — Single-screen onboarding (компрессия 6 → 1)

1. **Название.** Single-screen onboarding compression.
2. **Гипотеза.** В v2_try 6 экранов (entry → try → success → catalog → create → share); drop-off между «try» и «catalog» (по `onboarding_*` событиям) > 30 %. Если упаковать пасту URL + catalog grid + создание wishlist в один скроллящийся экран — completion вырастет на 20 %.
3. **Сегмент.** Новые пользователи в `v2_try`. Hash bucket по `User.id`, 50/50.
4. **Что меняем.** Один экран: верх — поле «Вставьте ссылку или скиньте товар» (поддерживает paste & detect), середина — горизонтальный catalog (свайп), низ — фиксированный CTA «Готово» который сам создаёт вишлист с любым (или пустым) набором.
5. **События.** Используем все существующие `onboarding_*`. Добавляем `onboarding_single.scroll_depth`, `onboarding_single.cta_pressed`.
6. **Primary.** Onboarding completion rate (`onboarding_completed` / `onboarding_started`).
7. **Guardrail.** D1 retention (новый юзер должен вернуться через 24h), share rate (если экран потерял first-share-prompt в Flow 1.15 — это убьёт виралку).
8. **Эффект.** Completion +15…25 %; D1 retention ±0; share rate −5…0 % (компенсируем в E08).
9. **Сложность.** Medium. Нужен новый routing exception (single screen vs current multi-screen).
10. **Риск.** Перегруз UI в Telegram-keyboard view (когда клавиатура занимает 50 % высоты, scroll-fit ломается).
11. **ICE.** 245. RICE = (12 000 × 7 × 0.7) / 3 = 19 600.
12. **Успех.** Completion +≥ 15 %, D1 retention −0 %, no regression на activation.
13. **Если успех.** Сделать default. Подчистить deprecated `onboarding-try` / `onboarding-success` / `onboarding-recovery` (6 экранов → 2: single + share-prompt).
14. **Если провал.** Версия с одним экраном слишком плотная — попробовать «2-step compression» (`try+catalog` + `create+share`) как промежуточный вариант (E02b).

---

### E03 — 3 бесплатных URL import в первые 24h

1. **Название.** Free URL import credits for new users (first 24h).
2. **Гипотеза.** URL import — самый ценный фичер для активации в RU-сегменте (Ozon, WB, Yandex Market). Сейчас он PRO-only (см. `MONETIZATION.md`, `features.includes('url_import')`). Если выдать 3 бесплатных импорта в первые 24h после `/start` — D0 activation вырастет на 25 %, а conversion to PRO не упадёт (т.к. дальше пользователь захочет ещё).
3. **Сегмент.** Новые FREE-users, `User.createdAt > now - 24h`. Bucket по `User.id`, 50/50.
4. **Что меняем.** Расширяем `UserCredits.importCredits`: при `getOrCreateTgUser` присваиваем `importCredits = 3` + `importCreditsExpireAt = createdAt + 24h`. Серверный gate `features.includes('url_import')` → расширить: `isPro || importCredits > 0`. Decrement на каждый успешный импорт.
5. **События.** Существующие: `import.started/succeeded/failed`. Новые: `import.free_credit_consumed { remainingCredits }`, `import.free_credit_expired`.
6. **Primary.** D0 activation rate.
7. **Guardrail.** PRO checkout conversion rate (не должна упасть > 5 %), `import.failed` rate, parser stability.
8. **Эффект.** D0 activation +20…30 %; PRO conversion −0…3 % (test arm может тянуть «жадных» юзеров, которые не платят); revenue/user −0…5 %.
9. **Сложность.** Low. Прибавить поле в `UserCredits` (миграция) + расширить gate + backfill для existing users в test arm.
10. **Риск.** Спам-боты могут эксплуатировать (создать аккаунт → 3 импорта → удалить) — но это уже ограничено rate limit 10/60s.
11. **ICE.** 576. RICE = (12 000 × 9 × 0.8) / 1 = 86 400.
12. **Успех.** D0 activation +≥ 20 %, без потери > 5 % PRO conversion, парсер стабилен.
13. **Если успех.** Раскатываем на всех новых users. Рассматриваем pre-paid bundle «start pack» — 3 imports + 1 hint + 1 free wishlist slot.
14. **Если провал (activation не растёт).** Сигнал: барьер активации не в URL import, а в чём-то ещё (display name? share?). Идти к E04, E07, E08.

---

### E04 — Auto-created default wishlist

1. **Название.** Auto-create «Мой первый вишлист» at first launch.
2. **Гипотеза.** Шаг «введите название вишлиста» в Flow 1.14 — лишний фрикшн. Если на момент первого `/start` сразу создавать пустой REGULAR wishlist (название по локали: «Мои желания»), `wish.created` через 24h вырастет на 10 %.
3. **Сегмент.** Новые users; bucket 50/50.
4. **Что меняем.** В `bot /start` handler (или в `getOrCreateTgUser`) — если у пользователя 0 wishlists, создать один REGULAR с дефолтным названием. Скипаем `onboarding-create-wishlist` экран в test arm.
5. **События.** Существующее `wishlist.created` с новым атрибутом `source: 'auto_first_launch'`.
6. **Primary.** % users c ≥ 1 wish создано в первые 24h.
7. **Guardrail.** % users с 0 items в течение 7 дней (если auto-wishlist остаётся пустым — это шум); user satisfaction (нет негативных support tickets «откуда взялся этот вишлист»).
8. **Эффект.** First item creation rate +8…12 %; «пустые» wishlists +30 % (это шум для метрик engagement).
9. **Сложность.** Low. ~30 строк + миграция test bucket.
10. **Риск.** Локализация дефолтного названия (6 locales); пользователи с pre-existing wishlists (returning через clean install) могут получить duplicate.
11. **ICE.** 378. RICE = (12 000 × 6 × 0.7) / 0.5 = 100 800.
12. **Успех.** First-item rate +≥ 8 %, support tickets не растут.
13. **Если успех.** Default-behavior. Удаляем `onboarding-create-wishlist` экран из v2_try (переименовываем в `onboarding-name-it`, опциональный).
14. **Если провал.** Если empty-wishlists растут, но activation не двигается — это подтверждает, что барьер не в «создать вишлист», а в «придумать первое желание». Идти к E07.

---

### E05 — «Я тут как гость» альт-путь онбординга

1. **Название.** Guest-mode onboarding fork.
2. **Гипотеза.** Часть новых пользователей приходит по share-link друга, но текущий guest-flow не даёт им мягко создать свой вишлист — банер появляется только после reservation. Если на `onboarding-entry` дать выбор «Я создаю свой вишлист» / «Я хочу подарок другу» и для второго пути показать гид по reservation flow — guest-to-owner conversion вырастет.
4. **Сегмент.** Новые users, у которых стартовый параметр содержит `share_<token>` (Flow 6). Bucket 50/50.
4. **Что меняем.** Новый экран `onboarding-guest-fork`: 2 карточки. Если выбран «Гость» — после reservation (Flow 7) показываем prompt `guest-fork-create-own` с pre-filled draft items (берём 2 случайных из owner's wishlist как «inspiration»).
5. **События.** Новые: `onboarding_guest_fork.shown`, `onboarding_guest_fork.guest_chosen`, `onboarding_guest_fork.owner_chosen`, `guest_fork.post_reservation_create_clicked`.
6. **Primary.** Guest-to-owner conversion = `% guests with ≥ 1 reservation who create their own wishlist within 7 days`.
7. **Guardrail.** Reservation success rate (не должна упасть > 5 %), `onboarding_completed`.
8. **Эффект.** G→O conversion +10…20 %; reservation success ±0.
9. **Сложность.** Medium. Новый экран + state machine fork + post-reservation hook.
10. **Риск.** Guest-fork может сбить часть пользователей, которые просто пришли подарить и не хотели регистрироваться (но они уже зарегистрированы — Telegram-юзер всегда), — низкий риск.
11. **ICE.** 210. RICE = (3 000 × 7 × 0.6) / 2 = 6 300.
12. **Успех.** G→O +≥ 10 %, reservation success не упал.
13. **Если успех.** Default behaviour, расширяем «inspiration items» до 5.
14. **Если провал.** Сигнал: гости пришли «потратить, не создавать» — это нормально, нужно искать другие конверсионные точки (E11–E13).

---

### E06 — Inline URL import без Drafts-крюка

1. **Название.** Inline URL import (skip Drafts).
2. **Гипотеза.** Сейчас URL import всегда кладёт item в `Drafts` (Flow 4.8) — пользователю надо вручную перемещать. Если разрешить импорт прямо в текущий wishlist, success-confirmation → дальше — `wish.completed` (полное заполнение карточки) вырастет на 15 %.
3. **Сегмент.** PRO users + users с `importCredits > 0` (если E03 раскатан). Bucket 50/50.
4. **Что меняем.** В `import-url` flow: добавить `targetWishlistId` в POST body; если передан и юзер — owner, item создаётся прямо в этом wishlist. UI: кнопка «Импорт сюда» рядом с «+» в wishlist detail.
5. **События.** Существующее `import.succeeded` с атрибутом `placement: 'inline' | 'drafts'`.
6. **Primary.** Per-user import volume (imports в неделю).
7. **Guardrail.** Wishlist item-limit hits (не должны спайкнуть; если люди начнут массово импортить, FREE-cap 20 будет быстро бить — это OK, ведёт к paywall, но мониторим).
8. **Эффект.** Import volume +20 %, paywall_shown:item_limit события +10…15 % (что хорошо для conversion).
9. **Сложность.** Medium. Изменения в импорт-pipeline + UI редизайн action-bar в wishlist detail.
10. **Риск.** Дубликаты (юзер импортит одну ссылку 2× → 2 items). Mitigation: server-side dedup по `sourceDomain + parsedTitle` в окне 60s.
11. **ICE.** 320. RICE = (5 000 × 8 × 0.8) / 2 = 16 000.
12. **Успех.** Import volume +≥ 15 %, dedup работает, no support tickets.
13. **Если успех.** Default. Drafts становится опциональным local-buffer, не основным путём.
14. **Если провал.** Drafts-крюк, возможно, не главный барьер — пользователи и так доходят до wishlist. Откатить.

---

### E07 — Smart input (URL **или** title в одном поле)

1. **Название.** Universal add-item input (auto-detect URL vs title).
2. **Гипотеза.** Сейчас раздельные кнопки «+» (manual) и «link icon» (import) — это decision fatigue. Если одно поле принимает либо URL, либо title — пользователь добавит больше items.
3. **Сегмент.** Все users внутри wishlist detail. Bucket 50/50.
4. **Что меняем.** Поле в action-bar: «Добавьте желание или вставьте ссылку». Regex-detect URL → URL-import path; иначе → manual create.
5. **События.** Новые: `item_add.input_used { type: 'url' | 'title' }`, `item_add.auto_detect_succeeded`, `item_add.auto_detect_failed_fallback_manual`.
6. **Primary.** Items per user per week.
7. **Guardrail.** Import error rate (не должна вырасти, т.к. parser теперь дёргается чаще), URL parse failure → удобный fallback на manual.
8. **Эффект.** Items/user/week +10 %.
9. **Сложность.** Low. UI swap + regex on input change.
10. **Риск.** Юзеры вставляют URL, но не PRO — попадают в paywall context `url_import`. Это даже полезно (увеличит paywall exposure).
11. **ICE.** 336. RICE = (8 000 × 6 × 0.7) / 1 = 33 600.
12. **Успех.** Items/user/week +≥ 8 %.
13. **Если успех.** Default. Убираем link-icon button.
14. **Если провал.** Single-input снижает clarity — оставить раздельно.

---

### E08 — Force-share gate после 1-го реального wish

1. **Название.** Force share modal after first real wish.
2. **Гипотеза.** Sharing — главный viral loop. Сейчас `first-share-prompt` существует, но dismissible. Если сделать share-step «mandatory» (нельзя выйти без share-or-skip-with-friction) — sharing-rate вырастет в 2×.
3. **Сегмент.** Новые users, после `wish.created` с `source: 'manual' | 'catalog' | 'import'` и `wishlist.type == 'REGULAR'`. Bucket 50/50.
4. **Что меняем.** После `wish.created` (первый real wish) — фуллскрин modal `force-share`. Два CTA: «Поделиться сейчас» (open Telegram share dialog) и «Позже» — кнопка «Позже» серая, под полупрозрачным overlay; на 3 сек после открытия становится активной (anti-spam dismiss).
5. **События.** Существующие: `first_share_prompt_shown`, `first_share_prompt_share_telegram`, `first_share_prompt_dismissed`, `share_token_generated`. Новое: `force_share.delayed_dismiss_after_seconds`.
6. **Primary.** Share-token-generation rate within 24h of first wish.
7. **Guardrail.** D1 retention (если пользователи фрустрированы — уйдут), `app_uninstall` proxy (no /start в 7 дней).
8. **Эффект.** Share rate +50…100 %; D1 retention −2…0 %.
9. **Сложность.** Low. Modal уже существует, нужно ужесточить dismiss UX.
10. **Риск.** Negative UX → отток. Mitigation: 3-sec delay before dismiss, не блокирует app.
11. **ICE.** 504. RICE = (15 000 × 9 × 0.7) / 0.5 = 189 000.
12. **Успех.** Share rate +≥ 40 %, D1 retention −≤ 2 %.
13. **Если успех.** Default. Усиливаем «ready-share-prompt» (после 2+ items) аналогичным friction-pattern.
14. **Если провал retention.** Откатываем; вместо forced — пробуем E09 (rich preview как «pull» вместо «push»).

---

### E09 — Rich share preview card

1. **Название.** Rich share message (item count + thumbnails + emoji).
2. **Гипотеза.** Сейчас share-link → плоский `t.me/...?startapp=share_<token>`. Receiver видит generic Telegram preview. Если генерировать rich-preview с 3 thumbnail-картинками + «X желаний от {name}» — click-through rate (share→guest open) вырастет на 30 %.
3. **Сегмент.** Все users, генерирующие share-token. Bucket 50/50.
4. **Что меняем.** Backend: новый endpoint `GET /og/share/:token` — возвращает HTML с OG-meta (title, description, image — collage из top-3 item photos). Telegram при шере подтянет preview. Frontend `share message` → шерим `https://wishlistik.ru/s/<token>` (web-redirect → `t.me/...startapp=share_<token>`).
5. **События.** Существующие: `share_token_generated`, `guest.view_opened`. Новые: `share_preview.og_served`, `share_preview.web_redirect_clicked`.
6. **Primary.** CTR share→guest_view (отношение `share_token_generated` к `guest.view_opened` в окне 7d).
7. **Guardrail.** Server load (collage-image generation — нагрузка на sharp), bot deep-link routing (web-redirect не должен ломаться при `t.me` open).
8. **Эффект.** CTR +25…40 %.
9. **Сложность.** Medium. Нужен OG-renderer (sharp-based collage), web-redirect handler, кэширование (Cache-Control: max-age 600).
10. **Риск.** OG-image content moderation — нельзя показывать NSFW; нужна white-list по domain или manual review queue. Стартуем с фолбэком на дефолтный OG, если items без photos.
11. **ICE.** 245. RICE = (20 000 × 7 × 0.7) / 3 = 32 666.
12. **Успех.** CTR +≥ 20 %, server p99 latency < 500 ms.
13. **Если успех.** Default. Применяем тот же OG-pattern к Curated Selections и Group Gift invites.
14. **Если провал.** OG-картинки игнорятся Telegram-клиентом (бывает на старых iOS). Refocus на text-richness в share message.

---

### E10 — Share через Telegram contact picker

1. **Название.** Direct share to a specific Telegram contact.
2. **Гипотеза.** Telegram WebApp API позволяет открыть chooser контактов (`WebApp.openTelegramLink` с `tg://msg?to=<phone>` или новый `WebApp.shareToChat` — проверить в актуальной версии). Если давать пользователю выбрать конкретного друга и бот шлёт DM с deep-link — guest open rate вырастет в 3× по сравнению с broadcast-share в чате.
3. **Сегмент.** PRO users в test arm (фича опционально под PRO как value-add, либо free — решить в pilot). 50/50.
4. **Что меняем.** В share-sheet добавить опцию «Отправить конкретному другу». Тап → Telegram contact picker → бот шлёт DM с message + WebApp button + deep-link.
5. **События.** Новые: `share_to_contact.opened`, `share_to_contact.recipient_selected`, `share_to_contact.bot_dm_sent`, `share_to_contact.recipient_clicked`.
6. **Primary.** Share-to-Guest CTR.
7. **Guardrail.** Bot rate limits (Telegram API: 30 msg/sec per bot — если пользователь шлёт 50 друзьям, нужно queue); spam reports.
8. **Эффект.** Share→Guest CTR +200 % для contact-picked сегмента; absolute volume может быть низким.
9. **Сложность.** High. WebApp contact picker API нестабилен между Telegram versions; нужен fallback на «paste username manually».
10. **Риск.** Spam complaints от Telegram (если пользователи начнут массово шерить).
11. **ICE.** 120. RICE = (8 000 × 8 × 0.5) / 4 = 8 000.
12. **Успех.** CTR per recipient ≥ 30 %, нет spam-reports.
13. **Если успех.** Default. Раскатываем на FREE с лимитом 5 контактов / день.
14. **Если провал по API stability.** Откладываем до Telegram WebApp 8.0+, переключаемся на E09.

---

### E11 — Account-claim CTA сразу после резерва

1. **Название.** Post-reservation account-claim CTA.
2. **Гипотеза.** Когда гость резервирует item, он уже Telegram-пользователь и уже взаимодействовал с ботом. Если сразу после успешного резерва (Flow 7) показать banner «Создать свой вишлист — друзья смогут сделать тебе подарок» — guest-to-owner conversion D7 вырастет на 25 %.
3. **Сегмент.** Гости с 0 own wishlists, успешно сделавшие первое резервирование. Bucket 50/50.
4. **Что меняем.** На `guest-item-detail` после `reservation.succeeded` — bottom-sheet с CTA «Создать свой вишлист». Тап → переход в onboarding с пометкой `source: 'post_reservation_claim'`.
5. **События.** Новые: `g2o.claim_cta_shown`, `g2o.claim_cta_clicked`, `g2o.claim_cta_dismissed`. Существующее: `wishlist.created` с новым `source: 'g2o_claim'`.
6. **Primary.** Guest-to-owner D7 conversion.
7. **Guardrail.** Reservation flow completion (не должен ломаться); confusion в support («что это за вишлист появился?»).
8. **Эффект.** G→O +20…30 %.
9. **Сложность.** Low. Bottom-sheet вариант существующего паттерна upsell-sheet.
10. **Риск.** «Banner blindness» — пользователи мгновенно дисмиссят. Mitigation: A/B на копи и timing (immediately vs 3 sec delay).
11. **ICE.** 576. RICE = (5 000 × 9 × 0.8) / 0.5 = 72 000.
12. **Успех.** G→O +≥ 20 %, dismiss rate < 80 %.
13. **Если успех.** Default. Расширяем CTA на event-day (когда гость подарил — «у тебя есть друзья, сделай вишлист»).
14. **Если провал.** Гости не хотят «свой вишлист», им важна функция дарения. Это сигнал на E22 (Birthday Pass — отдельный микро-product для гостей).

---

### E12 — Reciprocity DM «отправь свой вишлист в ответ»

1. **Название.** Reciprocity DM after reservation.
2. **Гипотеза.** Через 1 час после `reservation.succeeded` бот шлёт гостю DM: «Ты выбрал подарок для {ownerName}. Хочешь, чтобы {ownerName} тоже знал, что тебе подарить? Создай свой вишлист и пришли ему.» — drive G→O conversion на 15 %.
3. **Сегмент.** Гости после первого резерва, у которых 0 own wishlists. Bucket 50/50.
4. **Что меняем.** Новый scheduler `reciprocity-dm.scheduler` в `apps/api/src/schedulers/`. Каждые 5 мин сканирует свежие reservations с условием guest.wishlistCount == 0 + delay 60 мин с момента резерва.
5. **События.** Новые: `reciprocity.scheduled`, `reciprocity.dm_sent`, `reciprocity.dm_failed`, `reciprocity.dm_clicked`. Существующее `wishlist.created` с `source: 'reciprocity_dm'`.
6. **Primary.** G→O D7 conversion (атрибутировано по `reciprocity.dm_clicked`).
7. **Guardrail.** `bot_message_failed` rate, mute/block rate (Telegram-side blocks бота).
8. **Эффект.** G→O +10…20 %.
9. **Сложность.** Medium. Новый scheduler + bot DM template + lifecycle-marketing cooldown (max 5 marketing touches in 45 days per `MONETIZATION.md`).
10. **Риск.** Spam-perception — мы уже шлём lifecycle DMs. Нужно учесть в `notifyMarketing` toggle (если пользователь его отключил — не шлём reciprocity тоже).
11. **ICE.** 288. RICE = (3 000 × 8 × 0.6) / 2 = 7 200.
12. **Успех.** G→O +≥ 10 %, mute rate < 3 %.
13. **Если успех.** Default; добавляем 2-й touch через 72h если первый кликнули, но wishlist не создан.
14. **Если провал.** Отключаем DM. Сообщение в самом app (E11) — достаточно.

---

### E13 — Guest-view banner «Создать свой вишлист»

1. **Название.** Passive guest-view banner.
2. **Гипотеза.** Лёгкий, не блокирующий banner поверх guest-view (без modal) — даже если G→O рост скромный (+5 %), reach большой (все гости) — это «всегда-на» канал.
3. **Сегмент.** Все гости с 0 own wishlists, просматривающие чужой вишлист. Bucket 50/50.
4. **Что меняем.** Слайдер-banner сверху guest-view: «Понравилось? Создай свой за минуту». Dismiss-once per session.
5. **События.** Новые: `g2o.banner_shown`, `g2o.banner_clicked`, `g2o.banner_dismissed`.
6. **Primary.** G→O D7 conversion.
7. **Guardrail.** Guest-view bounce rate (если banner раздражает — guest уходит до резерва); reservation rate.
8. **Эффект.** G→O +5…10 %; reservation rate ±0.
9. **Сложность.** Low. Один компонент + dismiss state.
10. **Риск.** UI-clutter — особенно если уже виден `dont_gift_banner`. Mitigation: priority queue для banners (показываем максимум 1).
11. **ICE.** 378. RICE = (20 000 × 6 × 0.7) / 0.5 = 168 000.
12. **Успех.** G→O +≥ 5 %, bounce rate +≤ 2 %.
13. **Если успех.** Default; добавить ротацию copy (3 варианта).
14. **Если провал.** Совмещаем с E11 (только post-reservation), отказываемся от passive banner.

---

### E14 — Anonymous reserve (без display name)

1. **Название.** Anonymous reservation (skip display name).
2. **Гипотеза.** Display name prompt в Flow 7.4 — это лишний шаг для гостя, который только что пришёл. Если разрешить «Reserve anonymously» (owner видит «Reserved by someone», как в Secret Reservation, но free), reservation rate вырастет на 20 %.
3. **Сегмент.** Все гости. Bucket 50/50.
4. **Что меняем.** В reserve-flow добавить toggle «Анонимно». В test arm toggle по умолчанию ON; в control — OFF (как сейчас). Backend: при anonymous `reserverDisplayName = null`, для owner UI отображается «Зарезервировано анонимно».
5. **События.** Новое `reservation.succeeded` с атрибутом `anonymous: true | false`.
6. **Primary.** Reservation success rate (= `reservation.succeeded` / `guest-item-detail.open`).
7. **Guardrail.** Comments rate (если гость анонимный, он не сможет комментировать — может быть −X %); secret-reservation purchase rate (anonymous-free может каннибализировать).
8. **Эффект.** Reservation rate +15…25 %; secret-reservation purchases −10 % (важно для revenue).
9. **Сложность.** Low. Toggle + minor backend change.
10. **Риск.** Каннибализация секретного резерва (24 ⭐). Mitigation: anonymous = «owner not see name», но reservers всё ещё видны другим гостям как «Anon»; Secret Reservation = полностью скрытый (даже counters). Разница есть, но субтильная — нужна копи-работа.
11. **ICE.** 392. RICE = (10 000 × 7 × 0.7) / 1 = 49 000.
12. **Успех.** Reservation rate +≥ 15 %, revenue (secret res) −≤ 5 %.
13. **Если успех.** Default toggle ON. Repositionируем Secret Reservation как «invisible even to other guests» (стираем счётчик «N people reserved» на анонимных items для unauthorized).
14. **Если провал.** Display name prompt не главный барьер — пересмотреть E15.

---

### E15 — Display name prefill из Telegram identity

1. **Название.** Display name prefill from Telegram first/last name.
2. **Гипотеза.** В test arm display name предзаполнен `${tg.first_name}` (опционально + `tg.last_name`). Пользователь может изменить, но default-confirm в 1 тап → reservation rate +10 %.
3. **Сегмент.** Все гости. Bucket 50/50.
4. **Что меняем.** В `guest-item-detail` reservation modal — input `defaultValue={tg.first_name}` вместо пустого. Бэк не меняется.
5. **События.** Существующее `reservation.succeeded` с новыми `displayNameSource: 'prefilled' | 'edited' | 'manual'`.
6. **Primary.** Reservation success rate.
7. **Guardrail.** Owner-side confusion (если все гости — «Дмитрий», owner не различит). Comments-thread health.
8. **Эффект.** +8…15 %; owner-side confusion рост — но компенсируется через E14 (анонимные).
9. **Сложность.** Low. 1 строчка changes — `defaultValue` на input.
10. **Риск.** Privacy concern: пользователь может не хотеть давать своё имя без явного действия. Mitigation: маленькая подпись «как вас зовут? Это увидит {ownerName}».
11. **ICE.** 504. RICE = (10 000 × 7 × 0.8) / 0.2 = 280 000.
12. **Успех.** +≥ 10 %, no privacy complaints.
13. **Если успех.** Default; добавляем «использовать ник» (`@username`) как 2-й preset.
14. **Если провал.** Display name — не bottleneck, идти к E14.

---

### E16 — Explicit «Surprise mode» trust copy

1. **Название.** Explicit surprise-mode trust messaging on reserve.
2. **Гипотеза.** Многие гости не понимают, что owner не увидит, кто конкретно резервировал что (surprise mode, Flow 6.9). Если перед reserve явно показать pop-up «{ownerName} увидит, что зарезервировано, но не узнает кто и что — это сюрприз» — reservation rate +10 % (барьер «вдруг увидит» снят).
3. **Сегмент.** Гости при первом reserve. Bucket 50/50.
4. **Что меняем.** Перед reserve confirm — небольшая inline-explanation: «🤫 Сюрприз сохранится — {ownerName} увидит только, что желание занято». Test arm: показывать. Control: без объяснения.
5. **События.** Новое `surprise_mode.copy_shown`. Существующее `reservation.succeeded`.
6. **Primary.** Reservation success rate (first-time guests).
7. **Guardrail.** Reservation cancellations (если гости резервируют под нажимом — отменяют позже).
8. **Эффект.** +5…10 %.
9. **Сложность.** Low. 1 строка локализации × 6 локалей + UI insert.
10. **Риск.** Перегруз копи. Mitigation: 1 строка max.
11. **ICE.** 270. RICE = (10 000 × 5 × 0.6) / 0.2 = 150 000.
12. **Успех.** +≥ 5 %, cancellations не растут.
13. **Если успех.** Default + дублируем messaging в onboarding-share (Flow 1.15) — owner подкрепляет уверенность в шеринге.
14. **Если провал.** Trust — не bottleneck. Откатить, освободить экранное место.

---

### E17 — Yearly price test 800 → {600, 1000}

1. **Название.** Yearly PRO price elasticity test.
2. **Гипотеза.** Цена 800 ⭐ выбрана интуитивно. A/B/C/D на 600 / 800 (control) / 1000 / 1200 покажет эластичность спроса. Гипотеза: revenue/user максимизируется в районе 700–900.
3. **Сегмент.** Все users при открытии paywall (любой context). Bucket 25/25/25/25.
4. **Что меняем.** `PRO_YEARLY_PRICE_XTR` env var → выводится в `/tg/me/plan` per user-bucket. UI отображает цену из bucket. Backend на checkout проверяет соответствие bucket (антифрод).
5. **События.** Существующие: `pro_cta_clicked`, `checkout_started`, `checkout_succeeded`. Новые: `pricing_exp.bucket_assigned { variant }`.
6. **Primary.** Yearly conversion rate (% users в bucket кто купил yearly) × avg revenue per user.
7. **Guardrail.** Total revenue (если 600 даёт ×2 volume, но −25 % per-unit — net выигрыш). Refund rate.
8. **Эффект.** Revenue/user −10 %…+25 % в зависимости от варианта.
9. **Сложность.** Low. Env var → bucket → invoice. Архитектурно поддержано (см. `MONETIZATION.md` § 5).
10. **Риск.** Фрод — пользователь видит 600, но invoice уходит 800 (или наоборот). Mitigation: bucket-ID в invoice payload, server validates на pre_checkout_query.
11. **ICE.** 384. RICE = (15 000 × 8 × 0.6) / 1 = 72 000.
12. **Успех.** Найден price point, который даёт +≥ 15 % revenue/user.
13. **Если успех.** Закрепляем цену globally. Документируем в `MONETIZATION.md`.
14. **Если провал** (все 4 buckets converge). Эластичность низкая → лимитирующий фактор не цена, а value perception. Идти к E18, E19.

---

### E18 — Loss-aversion paywall copy

1. **Название.** Loss-aversion paywall copy.
2. **Гипотеза.** Текущий paywall показывает «13 features you unlock». Если переписать в loss-aversion стиле: «Без PRO ты потеряешь: возможность импорта с Ozon, комментарии под подарками, ...» — conversion +15 % (behavioral economics: loss-aversion ×2 prospect-theory effect).
3. **Сегмент.** Все users открывшие paywall (любой context). Bucket 50/50.
4. **Что меняем.** Перепишем `plan_pro_sub1`–`plan_pro_sub14` × 6 локалей с loss-framing для test arm.
5. **События.** Существующие `pro_cta_clicked`, `checkout_started`, `checkout_succeeded`. Новые: `paywall.framing_variant { 'gain' | 'loss' }`.
6. **Primary.** Paywall→checkout conversion (`checkout_started / paywall_shown`).
7. **Guardrail.** Negative sentiment в support tickets (отслеживаем keywords «навязывают», «жмут»).
8. **Эффект.** +10…20 %.
9. **Сложность.** Low. Только копи × 6 локалей.
10. **Риск.** Tone-tradeoff: можно перегнуть и стать «manipulative». Mitigation: review нативных копирайтеров на тех 6 локалях, которые мы не контролируем (ar, hi, zh).
11. **ICE.** 324. RICE = (15 000 × 6 × 0.6) / 0.5 = 108 000.
12. **Успех.** Conversion +≥ 10 %, sentiment не ухудшилcя.
13. **Если успех.** Default copy globally.
14. **Если провал.** Откатить. Подумать о side-by-side comparison table (FREE vs PRO) как 3-й вариант.

---

### E19 — 7-day PRO free trial

1. **Название.** 7-day PRO free trial (no payment method).
2. **Гипотеза.** Когда пользователь упирается в gate (e.g. `wishlist_limit` или `url_import`), вместо paywall показываем «Начни 7-day PRO trial бесплатно — без подписки и автосписания». После 7 дней — возврат на FREE, paywall с реальным offer. Это даст +30 % к eventual PRO purchase conversion (T+30d).
3. **Сегмент.** FREE users, hit любой paywall context первый раз. Bucket 50/50.
4. **Что меняем.** Новый `TrialGrant` (или reuse `PromoRedemption` с `source='free_trial'`). При нажатии «Начать trial» — записываем `expiresAt = now + 7d`. На 7th день — lifecycle DM «Trial закончился — твои данные сохранены, можно продлить за 100 ⭐ / месяц».
5. **События.** Новые: `trial.offered`, `trial.started`, `trial.expired`, `trial.converted_to_paid`, `trial.lapsed`.
6. **Primary.** Trial-to-paid conversion within 30 days.
7. **Guardrail.** Overall PRO conversion (не должна упасть из-за дилюции «бесплатным»), revenue/user T+30.
8. **Эффект.** Net revenue/user +10…25 % за 30 дней.
9. **Сложность.** Medium. Trial-state не пересекается с уже существующим `PromoRedemption` (тот завязан на campaign codes); нужна аккуратная интеграция с `DegradationState` lifecycle.
10. **Риск.** Cannibalization уже-готовых-платить юзеров. Mitigation: trial offer показывается только тем, кто ХИТНУЛ gate (не на главном paywall).
11. **ICE.** 270. RICE = (12 000 × 9 × 0.6) / 3 = 21 600.
12. **Успех.** T+30 PRO conversion (в test arm) ≥ control + 20 % relative.
13. **Если успех.** Default. Дальше пробуем 14-day trial vs 7-day.
14. **Если провал.** Дилюция доминирует — откатить. Это сигнал, что готовность платить ограничена не «не пробовал PRO», а «не вижу ценности».

---

### E20 — Choose-your-price probe

1. **Название.** Choose-your-price (qualitative WTP probe).
2. **Гипотеза.** На 5 % траффика (small fraction чтобы не повредить revenue) показываем paywall с slider «Сколько вы готовы платить в месяц за PRO?» с шагом 10 ⭐, от 0 до 500. Не покупает в этой ветке (ack screen «спасибо, мы подумаем»), просто собираем данные. Через 14 дней — гистограмма WTP.
3. **Сегмент.** Random 5 % FREE users, открывших paywall.
4. **Что меняем.** Новый paywall variant `choose_price_probe`. После выбора — toast «спасибо», then redirect на обычный paywall (с реальной ценой).
5. **События.** Новые: `wtp_probe.shown`, `wtp_probe.value_chosen { stars }`, `wtp_probe.skipped`.
6. **Primary.** Median WTP в test arm. Distribution (P25, P50, P75, P90).
7. **Guardrail.** Conversion rate в test arm vs control (test arm не должен дать > 5 % падения).
8. **Эффект.** Не conversion-эксперимент. Цель — quantitative input для price strategy.
9. **Сложность.** Low. Один UI variant + сбор события.
10. **Риск.** Self-report bias (юзеры пишут заниженные числа). Mitigation: использовать как baseline, не как abs truth.
11. **ICE.** 378. RICE = (1 500 × 6 × 0.7) / 0.5 = 12 600.
12. **Успех.** Собрано ≥ 1 500 ответов; видна чёткая distribution.
13. **Что делать.** Если P50 < 50 ⭐ — продукт перепрайсен; рассмотреть E22 (Birthday Pass) как entry. Если P50 ≈ текущая цена — рынок воспринимает текущую цену как fair, фокусируемся на conversion (E17, E18, E19).
14. **Если провал** (мало ответов). Делаем повторный заход через 1 месяц.

---

### E21 — Event Pass: 30-day PRO за 49 ⭐

1. **Название.** Event Pass — 30 days of PRO for 49 XTR.
2. **Гипотеза.** Сегмент юзеров платит за событие (birthday, NY, anniversary), не за recurring subscription. Если ввести non-recurring «Event Pass» 49 ⭐ × 30 дней — это создаст ARR-разрушающий, но volume-расширяющий offer. Гипотеза: total revenue +20 % за счёт расширения paying users 3–5×.
3. **Сегмент.** Все users при открытии paywall с context ∈ {`gift_notes`, `birthday_reminders`, `wishlist_limit` (если timing рядом с event)}. Bucket 50/50.
4. **Что меняем.** Новый SKU `pro_event_pass` 49 ⭐, type=`one-time`. Server upserts `Subscription` с `billingPeriod='event_pass'` (новый enum value) + `currentPeriodEnd=now+30d`, `cancelAtPeriodEnd=true`. Не recurring. Paywall sheet: добавляем 3-й tile под Monthly/Yearly: «Событийный пасс — 49 ⭐, 30 дней» (с пометкой «Идеально для одного дня рождения»).
5. **События.** Новые: `event_pass.paywall_shown`, `event_pass.cta_clicked`, `event_pass.purchased`, `event_pass.expired`, `event_pass.repurchased_within_60d`.
6. **Primary.** Total Stars revenue / new paying user (в окне 60 дней).
7. **Guardrail.** Yearly+Monthly cannibalization (если 80 % выбирают event_pass и забивают на recurring — это плохо для unit economics). Repurchase rate: если event_pass не повторяют — это true one-shot, ARR не пострадает.
8. **Эффект.** Paying-users count +50…200 %; revenue/user −20…+10 %.
9. **Сложность.** Medium. Новый `billingPeriod` enum, новая ветка в bot `successful_payment` handler, scheduler `event-pass-expiry` (recycle subscription-expiry sweep), UI добавление tile, downgrade-protection (если ивент-пасс куплен, не апгрейдить Monthly auto-renewal etc.).
10. **Риск.** Cannibalization Monthly (Monthly 100 ⭐ → 30 days; Event Pass 49 ⭐ → 30 days — почему кто-то выберет Monthly?). Mitigation: позиционирование — Event Pass без auto-renew + ограниченные benefits (например, без advanced birthday reminders или без showcase customization).
11. **ICE.** 315. RICE = (10 000 × 9 × 0.7) / 3 = 21 000.
12. **Успех.** Net revenue (60d) +≥ 15 %, paying users +≥ 50 %.
13. **Если успех.** Default. Дальше пробуем differential featuresetting (Event Pass без showcase, без curated selections).
14. **Если провал.** Если total revenue падает > 15 % — откатить. Это сигнал, что субсидирование цены не приносит volume. Идти на E19 (free trial).

---

### E22 — Birthday Pass

1. **Название.** Birthday Pass (PRO для своего ДР + 14 дней до).
2. **Гипотеза.** Под конкретное событие (birthday) пользователь готов разово заплатить — это focused use-case. Если ввести «Birthday Pass» — 39 ⭐ за PRO с −14d до +0 от своего birthday — это privacy-friendly, low-commit purchase.
3. **Сегмент.** Users с заполненным `User.birthday`, hit paywall в окне ±14d от своего ДР. Bucket 50/50.
4. **Что меняем.** Новый SKU `pro_birthday_pass`. Активен с −14d по +0 от birthday. Paywall ветка добавляется только в окне.
5. **События.** Новые: `birthday_pass.eligible_shown`, `birthday_pass.purchased`, `birthday_pass.activated`, `birthday_pass.expired_post_event`.
6. **Primary.** Conversion to paying в окне ±14d (test vs control).
7. **Guardrail.** Repeat purchase year-on-year, Yearly conversion (не должна сильно упасть).
8. **Эффект.** Birthday-window conversion +30…80 %; impact на overall revenue умеренный (~5–10 %).
9. **Сложность.** High. Birthday-aware billing (timezone, leap year), специальная state machine, отдельный paywall UI flow, отдельный copy 6 locales.
10. **Риск.** Сложность тестирования (нужно 2 недели на каждый бакет для статсиг); сильная зависимость от `User.birthday` — если меньше 30 % имеют — sample size мал.
11. **ICE.** 105. RICE = (3 000 × 7 × 0.5) / 4 = 2 625.
12. **Успех.** Birthday-window conversion +≥ 30 %.
13. **Если успех.** Расширяем до Anniversary Pass, NY Pass.
14. **Если провал.** Слишком узкая ниша — focus на E21 (general Event Pass).

---

### E23 — Santa pre-season teaser DM (Nov 1)

1. **Название.** Santa pre-season activation DM.
2. **Гипотеза.** Secret Santa — seasonal traffic spike (Dec-Jan). Если на 1 ноября бот шлёт DM всем users с прошлогодним участием («Скоро Santa — собери компанию заранее») — share of Santa-attributed activations +40 %, и заодно reactivates dormant users.
3. **Сегмент.** Users с `SantaParticipant` row в прошлом сезоне (active in 2025). Holdout 5 % для clean control.
4. **Что меняем.** Новый scheduler `santa-pre-season.scheduler` — fires once on Nov 1 (configurable). DM с CTA «Создать кампанию» / «Получить инвайт-линк». Прошлогодним owners — pre-filled draft campaign.
5. **События.** Новые: `santa.preseason_dm_sent`, `santa.preseason_dm_clicked`, `santa.campaign_created_from_preseason`.
6. **Primary.** Santa campaign creation rate в Nov-Dec 2026 (test vs control).
7. **Guardrail.** Mute/block rate (повторные seasonal DMs могут раздражать). DM delivery success rate.
8. **Эффект.** Santa activation +30…50 %; общий ретеншн +5 % (Nov-Dec window).
9. **Сложность.** Low. Scheduler + template + bot DM.
10. **Риск.** Spam-perception на seasonal cadence. Mitigation: только 1 touch в pre-season; mute = no further touches.
11. **ICE.** 448. RICE = (2 000 × 8 × 0.7) / 1 = 11 200.
12. **Успех.** Santa campaigns в test +≥ 30 % vs control.
13. **Если успех.** Стандартизуем pre-season DM ежегодно; добавляем cross-sell PRO «Multi-wave campaigns» (PRO feature).
14. **Если провал.** Если muted > 15 %, откат. Сигнал, что нужно качество, не cadence.

---

### E24 — Group Gift price 79 → 39 ⭐

1. **Название.** Group Gift unlock price elasticity (79 → 39 ⭐).
2. **Гипотеза.** 79 ⭐ — относительно дорогой gate для одноразовой попытки. Если снизить до 39 ⭐ — unlock-rate ×3, total revenue +50 % (через volume).
3. **Сегмент.** Гости, открывшие `group-gift-paywall` (Flow 25.3). Bucket 50/50.
4. **Что меняем.** Env var `GROUP_GIFT_UNLOCK_PRICE_XTR` → bucket-aware на paywall. На invoice — переменный price согласно bucket.
5. **События.** Существующие `addon_checkout_*` с атрибутом `bucket: 'price_39' | 'price_79'`. Новые: `group_gift.unlock_paywall_variant`.
6. **Primary.** Group Gift unlock revenue per `group-gift-paywall` impression.
7. **Guardrail.** Group Gift completion rate (если 39 ⭐ привлекает «несерьёзных» — кампании будут брошены — не страшно с точки зрения revenue).
8. **Эффект.** Unlock rate +100…200 %; revenue per impression +30…70 %.
9. **Сложность.** Low. Аналогично E17.
10. **Риск.** Те, кто платил 79, увидят 39 в Settings (если у них есть видимость к ценам в Faq) — confusion. Mitigation: цена нигде не отображается публично кроме paywall.
11. **ICE.** 441. RICE = (3 000 × 7 × 0.7) / 0.5 = 29 400.
12. **Успех.** Revenue per impression +≥ 30 %.
13. **Если успех.** Фиксируем новый price point. Документируем в `MONETIZATION.md`.
14. **Если провал.** 79 — ОК price point. Идти к E25 (free first).

---

### E25 — Reservation purchase reminder для FREE

1. **Название.** Reservation reminder for FREE reservers.
2. **Гипотеза.** Сейчас reminders — PRO-feature (Reservation PRO, Flow 4.12). Если давать всем reservers одно reminder DM (24h до Smart Reservation TTL expiry, или 14d / 7d до occasion из Gift Notes у owner) — engagement reservers ↑ → completion ↑ → repeat-reservation ↑.
3. **Сегмент.** FREE reservers с активной reservation. Bucket 50/50.
4. **Что меняем.** Новый scheduler `free-reservation-reminder.scheduler`. Каждые 2 часа — find reservations expiring в 24h на wishlists с Smart Reservations, OR reservations связанные с `GiftOccasion` через `wishlistId` (if owner поставил event date). DM в bot.
5. **События.** Новые: `reminder.free_reservation_dm_sent`, `reminder.free_reservation_dm_clicked`, `reminder.purchase_marked_after_reminder`.
6. **Primary.** Reservation→purchase mark rate (`reservation.completed` events).
7. **Guardrail.** Mute rate, bot delivery success.
8. **Эффект.** Reservation completion rate +15 %; cross-sell PRO (reserver видит «PRO даёт настройку reminder window») +5 %.
9. **Сложность.** Medium. Новый scheduler + reuse существующего PRO reminder infrastructure.
10. **Риск.** Cannibalization PRO Reservation features. Mitigation: 1 reminder/reservation; PRO даёт несколько + customization.
11. **ICE.** 252. RICE = (5 000 × 7 × 0.6) / 3 = 7 000.
12. **Успех.** Completion +≥ 10 %.
13. **Если успех.** Default. Делаем «teaser» в DM: «PRO даёт 3 reminders + кастомные интервалы».
14. **Если провал.** Reminder-fatigue + spam complaints доминируют. Откат.

---

## 3. Пилотный план запуска (первые 8 недель)

| Неделя | Эксперименты | Why first |
|---|---|---|
| Phase 0 | Infra: `useExperiment` hook + sticky bucket + `experiment_assigned` event | Без этого все остальные эксперименты — ad-hoc |
| 1–2 | E03, E04 | Высокий ICE, low effort, activation impact |
| 2–3 | E08, E11 | Sharing + G→O — viral loop |
| 3–4 | E15, E14 | Reservation friction — quick wins |
| 4–5 | E23 (sequenced для Nov 1, готовим заранее), E24 | Santa-window prep + addon revenue |
| 5–6 | E17, E18 | Pricing — нужны 4 недели данных для stat sig |
| 6–7 | E20 | WTP probe |
| 7–8 | E21 | Event Pass — большой системный эксперимент |

**Что НЕ запускать одновременно:**
- E14 + E15 (overlapping changes к reservation flow — interaction effects).
- E17 + E21 (оба меняют paywall structure).
- E08 + E11 (оба создают post-creation friction — confound).

---

## 4. Метрики верхнего уровня (трекаем weekly)

| Метрика | Definition | Baseline (apx) | Target by Q3 2026 |
|---|---|---|---|
| D0 Activation | % new users → ≥ 1 real wish in REGULAR wishlist | 35 % (на основе onboarding A/B) | 55 % |
| Share rate D7 | % activated users c ≥ 1 share_token_generated в 7 дней | 25 % | 45 % |
| Guest → Owner D7 | % guests c reservation → ≥ 1 own wishlist в 7 дней | 8 % | 20 % |
| Reservation rate | reservations / guest_view_opened | 18 % | 30 % |
| Paywall conversion | checkout_succeeded / paywall_shown (по сегментам) | ~2 % | 4 % |
| Revenue per new user (60d) | Sum(Stars) / new users | ~12 ⭐ | 30 ⭐ |
| Pivot-signal score | Composite: (D0 + share + G→O + paywall) | — | если < target ×0.5 за Q3 — пивот |

---

## 5. Чего этот backlog **не** покрывает (и почему)

- **Pure UI polish** (визуальные изменения без funnel hypothesis) — не эксперимент, это полировка.
- **Server perf / infra** — растут только из guardrail-нарушений (capacity issues).
- **B2B / agency tooling** — отдельная стратегия, если возникнет необходимость pivot.
- **Web public landing** (`/w/:slug` SSR pages) — на текущем traffic mix < 5 % от Mini App; см. `KNOWN_GAPS_AND_RISKS.md` § 21.
- **Referral program ON/OFF** — пока feature-flag off (флипнут обратно 2026-05-25); включение — отдельный launch event, не A/B. Prerequisites + 7 re-enable gates: [`referral-decision.md § 7`](./referral-decision.md#7-re-enable-gates-что-закрыть-до-следующего-флипа).
- **AI-powered wish suggestions** — слишком далеко от текущей feature surface, требует отдельной discovery.

---

## 6. Дальнейшие шаги

1. **Phase 0 infra (1 неделя):** реализовать `useExperiment(key)` хук + `experiment_assigned` event в `analyticsEvents.ts`; sticky bucket по `User.id` через server-side hash.
2. **Запуск Wave 1 (E03 + E04):** обе low-effort, неконфликтующие; 2 недели экспозиции.
3. **Ревью по итогам каждой Wave:** мини-doc `docs/research/experiments/<id>-<name>-readout.md` с decision rule = принято/откат/итерация.
4. **Обновление этого backlog** ежемесячно: новые гипотезы из support tickets, lifecycle DMs metrics, и WTP-probe результатов.
