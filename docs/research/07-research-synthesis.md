# 07 — Research Synthesis & Decision Log (WishBoard)

> **Дата:** 2026-05-28
> **Owner:** product (solo founder)
> **Статус:** v1 — снимок состояния после research-волны 01–06.
> **Корпус источников:**
> [01-product-feature-map.md](./01-product-feature-map.md) ·
> [02-analytics-audit.md](./02-analytics-audit.md) ·
> [03-monetization-paywall-audit.md](./03-monetization-paywall-audit.md) ·
> [04-user-research-plan.md](./04-user-research-plan.md) ·
> [05-research-segmentation-queries.md](./05-research-segmentation-queries.md) ·
> [06-experiment-backlog.md](./06-experiment-backlog.md) ·
> [segment-sizes-2026-05.md](./segment-sizes-2026-05.md) (snapshot 2026-05-19, **401** recruitable users) ·
> [core-loop-dashboard.md](./core-loop-dashboard.md) ·
> [public-web-usage.md](./public-web-usage.md) ·
> [referral-decision.md](./referral-decision.md) ·
> [event-pass-spec.md](./event-pass-spec.md) ·
> [guest-conversion-spec.md](./guest-conversion-spec.md) ·
> [survey-pmf-v1.md](./survey-pmf-v1.md) (DRAFT, not yet ACTIVE)

---

## 0. Глобальные оговорки (читать до выводов)

**База очень маленькая.** На 2026-05-19 в проде 401 recruitable user. 49 активированных, 3 платящих когда-либо, 1 активный PRO прямо сейчас, 0 group-gift, 0 URL-import, 2 Santa-юзера, 5 paywall-viewers. **Большинство сегментов N < 5** и статистически непригодны для «решений», только для case-study наблюдения.

**Interviews и survey ещё НЕ проводились.** План сформирован в [04-user-research-plan.md](./04-user-research-plan.md), survey собрана в [survey-pmf-v1.md](./survey-pmf-v1.md), но `ResearchSurvey` row не создан в проде (статус **DRAFT**), интервью не нарезаны и не транскрибированы. Поэтому каждый вывод ниже опирается **в первую очередь на analytics + code/audit**, и помечен `[interview: PLANNED]` / `[survey: PLANNED]`, где этот сигнал ещё нужно получить.

**Аналитические события сами по себе дырявые.**
- `payment.completed` / `pro.activated` / `paywall.viewed` (унифицированный) / `guest.converted_to_user` (по-настоящему живой) — событий нет или они почти не emit'ятся ([02-analytics-audit.md § 7](./02-analytics-audit.md)).
- Три параллельных allowlist'а расходятся → часть событий молча дропается.
- `AnalyticsEvent` имеет 90-day TTL; long-term когорты живут только в `UserDailyActivity` ([core-loop-dashboard.md](./core-loop-dashboard.md)).

Поэтому числа из § 1–6 ниже надо читать как **direction, not magnitude**.

**Confidence rubric:**
- **high** — три источника или один очень прочный (живой код + БД-факт), сходимость.
- **medium** — два источника, либо один сильный плюс согласующаяся гипотеза.
- **low** — гипотеза или одиночный сигнал; ждём interview/survey-проверки.

**Источник в подписи:** `[analytics]` = events / DB query, `[audit]` = code/architecture audit, `[interview]` = глубинное интервью, `[survey]` = PMF-опрос. `PLANNED` = ещё не запущено.

---

## 1. Что мы сделали правильно

| # | Утверждение | Источники | Confidence |
|---|---|---|---|
| 1.1 | **Core loop (wishlist → item → share → reserve → notify) — production-grade.** Reserve в surprise-mode безопасен (actorHash SHA-256, timing-safe compare), share-link безусловно FREE, guest не упирается ни в один paywall при первом резерве. | `[audit]` [01 § 1, § 2.3](./01-product-feature-map.md), [03 § 9.3](./03-monetization-paywall-audit.md) + `[analytics]` 20 reservation.succeeded / 30 d при 401 base | high |
| 1.2 | **Server-enforced monetization без bypass.** Один источник правды (`PLANS` + `ONE_TIME_SKUS` в `entitlement.ts`), lifetime/downgrade-guard работает, нет ни одного frontend-only gate с финансовым риском (только `sort_recommended`, neutral). | `[audit]` [03 § 1, § 6](./03-monetization-paywall-audit.md) | high |
| 1.3 | **Security baseline затянут.** Helmet, idempotency на критических endpoints, rate-limit categories, DNS-pin + magic-byte guard, HTML-escape в bot, Serializable txn на item create/restore. | `[audit]` git log (commits 22c9ff3, 547f74b, 39fe627), [CLAUDE.md § Security layer] | high |
| 1.4 | **Onboarding v2_try выиграл A/B; v1 deprecated.** Дальнейшие итерации — внутри v2. Активация определена жёстко («real wish in REGULAR wishlist»), `becameRealAt` stamp на demo→real конверсии. | `[audit]` [06 § 0](./06-experiment-backlog.md) + `[analytics]` 49 activated owners | high |
| 1.5 | **Architecture cleanup отработала.** `apps/api/src/index.ts` — composition root (1 789 LOC, 0 inline handlers), 13 services + 9 schedulers как реальные слои. | `[audit]` [CLAUDE.md § API architecture] | high |
| 1.6 | **Guest auto-recovery (Flow 19) работает.** Owner-as-guest collision detection → silent switch. Метрики reservation не загрязняются «своими» бронями. | `[audit]` [06 § 0](./06-experiment-backlog.md) | high |
| 1.7 | **Recently shipped, отложенный risk:** `cancel_feat_*` sheet с 9 фичами и pro_cancel.* telemetry; idempotency-flag для критических ручек; client-side hash-IP/key — anti-churn UX больше не «выпавший». | `[audit]` [03 § 8.6](./03-monetization-paywall-audit.md) + commits | high |
| 1.8 | **Design system формализован.** 7 primitives canonical/provisional, mockup approval pipeline, audit-метрика raw-styles, governance log. | `[audit]` [CLAUDE.md § Design system] | high |

**Что эта таблица НЕ говорит:** что пользователи это всё ценят. Внутреннее качество ≠ внешняя ценность. См. § 2.

---

## 2. Где пользователи ломаются

> Все цифры — snapshot [segment-sizes-2026-05.md](./segment-sizes-2026-05.md) (база 401), либо [public-web-usage.md](./public-web-usage.md) (30 дней), либо [referral-decision.md § 2](./referral-decision.md).

| # | Точка слома | Цифра | Источники | Confidence |
|---|---|---:|---|---|
| 2.1 | **Не доходят до активации.** ~310 / 401 ≈ **77 %** churned-never-activated (зашёл, не создал реальный item, ушёл). | 359 inactive 14d − 49 activated ≈ 310 | `[analytics]` [segment-sizes § 1, § 8](./segment-sizes-2026-05.md) | high |
| 2.2 | **Создал вишлист, но не нажал "Поделиться".** | **44 / 401 ≈ 11 %** — активный wishlist без `shareToken`. | `[analytics]` [segment-sizes § 2](./segment-sizes-2026-05.md) | high |
| 2.3 | **Сгенерировал share-token, но никто не открыл.** **Главный разрыв воронки шеринга.** 37 owners получили токен → только 15 wishlist'ов реально получили хоть один клик (`shareOpenCount > 0`). **60 % выпустивших ссылку никому её не отправили.** | 37 → 15 | `[analytics]` [segment-sizes § 3](./segment-sizes-2026-05.md) | high |
| 2.4 | **URL-import не используется НИКЕМ.** 0 items с `originType='IMPORTED'`. 0 hits на `feature_gate_hit_url_import`. Это не «гейт ломает activation» (как боялись в audit), а «фича невидима». | 0 / 401 | `[analytics]` [segment-sizes § 11](./segment-sizes-2026-05.md) | high |
| 2.5 | **Group Gift не используется НИКЕМ.** 0 организаторов, 0 участников. | 0 / 401 | `[analytics]` [segment-sizes § 10](./segment-sizes-2026-05.md) | high |
| 2.6 | **Public web `/w/<slug>` мертвее, чем кажется.** 30 дней: 49 view-events, из них 41 (84 %) — `/w/demo` с homepage; реальные пользователи — 8 событий на 3 wishlist'ов; **0 reservations через web channel.** | 0 conv / 30d | `[analytics]` [public-web-usage § 2](./public-web-usage.md) | high |
| 2.7 | **Guest-attribution silent broken.** 162 `guest.view_opened` за 30 дней → 1 `guest.converted_to_user` total, 0 / 315 `firstAcquisitionSource`. Mini App bootstrap не emit'ит beacon для 4 share-путей (item-link, profile, curated, raw-share-token). | 1 / 162 | `[analytics]` + `[audit]` [guest-conversion-spec § 1](./guest-conversion-spec.md) | high |
| 2.8 | **`appearance` upsell context — захардкоженный русский** во всех 6 локалях. Не блокер активации, но immediate trust-killer для en/zh/hi/es/ar когорт. | n/a | `[audit]` [03 § 8.8](./03-monetization-paywall-audit.md) | high |
| 2.9 | **3 Santa PRO-гейта (`multi_wave`, `exclusions`, `exclusion_groups`) недокументированы.** Юзер узнаёт о 402 только в момент создания multi-wave кампании. | n/a | `[audit]` [03 § 4.3](./03-monetization-paywall-audit.md) | high |
| 2.10 | **`bot_import` context — orphan.** Зарегистрирован в `MiniApp.tsx:2222`, но `setUpsellSheet({ context: 'bot_import' })` — 0 вызовов. Mёртвая ветка copy + i18n. | 0 calls | `[audit]` [03 § 5.2](./03-monetization-paywall-audit.md) | high |
| 2.11 | **Cancel-sheet «8 фичей что вы теряете»**, описанный в `MONETIZATION.md` — был silent-broken до 2026-05-27 (сейчас исправлен, sheet рендерит 9 фич). Это бывшая точка слома, фикс уже есть, оставлено в синтезе как memo. | resolved | `[audit]` [03 § 8.6](./03-monetization-paywall-audit.md) | high |
| 2.12 | **Referral program случайно был включён 2026-04-17 → 2026-05-25 (38 дней).** 54 / 315 юзеров получили реф-код, 0 attribution rows, 0 paid conversions. UI-engagement events дропались allowlist'ом. Сейчас выключен. | 54→0 attr | `[analytics]` + `[audit]` [referral-decision § 2–3](./referral-decision.md) | high |
| 2.13 | **Локальная гипотеза:** non-RU локали тонут быстрее RU из-за неполных переводов + культурного контекста. **Не валидировано** — wave 1 PMF survey стартует только в `ru/en`, остальные четыре локали отложены. | TBD | `[audit]` [survey-pmf-v1 § Locale gating](./survey-pmf-v1.md) `[survey: PLANNED]` | low |

**Главный read:** "ломается" не **внутри** продукта (пользователь нажал — пользователь увидел ошибку), а **на стыке "продукт ↔ внешний мир"**. Воронка обрывается там, где надо что-то сделать руками владельца: написать "вот моя ссылка, посмотри"; найти ссылку чтобы импортировать; собрать друзей в группу. Все три — социальные, не технические действия.

---

## 3. Реальный aha-moment

**Гипотеза (рабочая):** aha — момент **«я отправил ссылку → кто-то её открыл»**, не «я создал первый item».

| Подтверждения | Источники | Confidence |
|---|---|---|
| 60 % сгенерировавших share-token так его и не отправили — это поведение людей, у которых «кнопка нажата, но импульса завершить нет». Те 15 / 37, кто реально отправил, и есть фактический aha-cohort продукта. | `[analytics]` [segment-sizes § 3](./segment-sizes-2026-05.md) | medium |
| Reservation-rate среди тех, чью ссылку открыли — высокий: 14 guest-reservers на ~152 open-events, ≈ 9 %. Это нормальный gift-coordination conversion для лёгкого share. | `[analytics]` [segment-sizes § 4–5](./segment-sizes-2026-05.md) | medium |
| Hypothesis H1 (research-plan): «aha = первая увиденная reservation, не создание item». Совпадает с тем, что мы видим в данных. | `[audit]` [04 § H1](./04-user-research-plan.md) `[interview: PLANNED]` | low |
| Альтернативная aha-гипотеза — URL-import («ого, оно само заполнило карточку из Озона») — **falsified by data**: 0 URL-imports за всё время, никто не пробовал и в gate не упирался. | `[analytics]` [segment-sizes § 11](./segment-sizes-2026-05.md) | high (по эксклюзии) |

**Net:** до того, как survey Q3 даст quantitative ответ, рабочая модель — **«owner шерит → видит signal от другого человека (open или reserve) → возвращается»**. План эксперимента → E08 (force-share gate после первого wish) + E11 (post-reservation CTA, **уже shipped 2026-05-27**) проверят эту модель напрямую.

**Что не aha (с высокой уверенностью):** сам факт создания вишлиста (44 wishlist'а без следующего шага — это **больше**, чем активированных-и-поделившихся, 37 / 401), сам факт добавления item'а (310 churned пытались, не зацепились).

**Confidence sloрта (общая):** **medium-leaning-high.** Подтверждение через E08/E11 readout + survey Q3 ожидается в окне +30 дней.

---

## 4. Главный барьер sharing

**Гипотеза (рабочая):** барьер не технический и не эмоциональный сам по себе — он **отсутствие триггера / повода**.

| Сигнал | Источник | Confidence |
|---|---|---|
| 44 owners создали wishlist без шер-токена + 22 (= 37 − 15) сгенерили токен и не отправили. Это значит: технически дойти до share-кнопки **не сложно** (44 + 22 = 66 человек прошли создание), но **запустить разговор с другом** — сложно. | `[analytics]` [segment-sizes § 2, § 3](./segment-sizes-2026-05.md) | medium-high |
| H4–H5 (research-plan): «share-rate низкий + барьер = смущение / нет повода». Не валидирован, но подкрепляется данными (см. выше) — `wishlist.created` без `share.token_generated` = 44, что больше, чем activated-and-shared (37). | `[audit]` [04 § H4–H5](./04-user-research-plan.md) `[interview: PLANNED]` | low (по interview) / medium (по analytics) |
| `first_share_prompt_*` events: dismissible, в проде ставка на pull не push. E08 (force-share gate) специально проверит, что произойдёт с D1 retention если push. | `[audit]` [06 § E08](./06-experiment-backlog.md) | medium |
| Public web — нулевые конверсии через `/w/:slug` за 30 дней. Это значит — даже если ссылку и расшарили вне Telegram, дальше неё путь не идёт. | `[analytics]` [public-web-usage § 2.3](./public-web-usage.md) | high |

**Подтипы барьера, которые надо разделить (для interview-волны):**

1. **«Не было повода»** — нет события (день рождения через 4 месяца). Pivot-signal: event-first onboarding.
2. **«Неловко»** — выглядит как попрошайничество. Pivot-signal: rephrase copy, "увидят, что подарить" вместо "попроси подарки".
3. **«Нечего показывать»** — 1–2 items, чувствую что мало. Pivot-signal: автозаполнение catalog'ом и URL-импорт в первый сеанс (E03).
4. **«Кому?»** — нет естественной аудитории в Telegram. Pivot-signal: либо contact picker (E10), либо ограниченный positioning «вишлист для семьи/пары».

Разделение этих четырёх — **главный приоритет первого раунда interview-сегментов B (44 чел.) + C (37 чел.)**.

**Confidence общая:** **medium.** Нужен interview-цикл сегмента B для качественного разделения подтипов.

---

## 5. Главный paid trigger

⚠️ **N = 3 платящих когда-либо. Любой вывод о paid trigger — case study, не статистика.**

| Что мы знаем | Источник | Confidence |
|---|---|---|
| 3 unique payers (any successful payment); 2 — paid PRO ever; 1 — active PRO now. | `[analytics]` [segment-sizes § 7](./segment-sizes-2026-05.md) | high (фактически) |
| Только 2 `feature_gate_hit_*` events distinct users: 1 comments, 1 wishlist_limit. **Все остальные gate-типы (item_limit, hints, url_import, categories, secret_reservations, group_gift, gift_notes) — 0 hits.** Это значит — лимиты на текущем масштабе **никем не достигнуты**, и paywall optimization сейчас бессмыслен. | `[analytics]` [segment-sizes § 12](./segment-sizes-2026-05.md) | high |
| Audit описывает URL-import как **главный killer activation** и предлагает credit-fallback. Но в данных URL-import не используется в принципе → переводить его в credits мы будем без real-user сигнала, по принципу «если попробуют — пусть смогут». | `[audit]` [03 § 9.1](./03-monetization-paywall-audit.md) + `[analytics]` § 11 | medium |
| Hypothesis H10 (research-plan): «Hints — самая эмоционально продающая фича». **Не валидирована.** На 401 база можно interview двух Santa-participants и 14 guest-reservers — но это не PRO-payers. | `[audit]` [04 § H10](./04-user-research-plan.md) `[interview: PLANNED]` | low |
| Lifetime 2 490 ⭐ — anchor (введён 2026-05-09). H8: «event-кейс ДР раз в год → Lifetime лучший value-perception». Wholly hypothesis, нужны interview сегмента D (3 человек, делать all-case-study, не sample). | `[audit]` [04 § H8](./04-user-research-plan.md) + [03 § 1.1](./03-monetization-paywall-audit.md) `[interview: PLANNED]` | low |

**N<5 disclaimer.** На сегодняшнем масштабе **главный paid trigger мы статистически определить не можем.** Можно только:
1. Опросить 3 платящих как case study.
2. Запустить E20 (choose-your-price probe, target N = 1 500 ответов за 14 дней — на текущем traffic mix 150 new/day → реально только при cumulative волне).
3. Запустить E21 (Event Pass 49 ⭐ / 30 d) и смотреть paying-user count, а не conversion %.

**Working hypothesis (низкая confidence):** Lifetime > Yearly > Monthly по value perception, потому что usage у wishlist'а событийный (ДР раз в год), и пользователи не возвращаются monthly чтобы оправдать recurring. **К проверке E17 + E21 + interview D.**

**Confidence общая:** **low.** Это та область, где interview/survey-волна обязательна перед инвестицией в pricing strategy.

---

## 6. FREE vs PRO

> Источник: [03 § 10–11](./03-monetization-paywall-audit.md) + анализ analytics § 5 выше. Идея — снять frictions, которые мешают **активации и virality**, а на PRO оставить то, что монетизирует **глубину использования**.

### 6.1 Оставить бесплатным (либо с FREE-квотой)

| Фича | Сейчас | Предлагается | Обоснование | Confidence |
|---|---|---|---|---|
| **URL import** | Hard 402 для FREE | 5 импортов/мес FREE, потом credit/PRO | Главный onboarding-step, не должен ломаться. **Caveat:** в данных URL-import не используется (§ 2.4), но это не значит "не нужен" — может, gate **слишком невидим** (`feature_gate_hit_url_import` = 0). Open это в FREE = эмиссия события у живых пользователей и измеримость. | medium |
| **Hints** | ✅ 3 hints/мес FREE — **shipped 2026-05-21** | — | Soft-virality, любое использование тянет к диалогу. | high (shipped) |
| **Comments (either-or)** | ✅ PRO у любой стороны разблокирует | Оставить как есть | Гениальная механика — гость и owner делят cost. Любая PR-сторона разблокирует другую. | high |
| **Participants per list** | FREE = 5 | **FREE = 10** | ДР с 6+ гостями — типовой кейс; 5 ломает primary use case. | high `[audit]` |
| **Categories** | Hard 402 | 3 категории FREE на вишлист, дальше PRO | Помогает NUX второго вишлиста; сейчас полностью closed (FREE юзер не видит ценности). | medium |
| **Curated Selections** | Hard 402 | 1 selection/квартал FREE | Lite-share — потенциально вирусный канал. | medium |
| **Santa hint requests** | Hard 403 (был 403, должно быть 402) | **1 hint / кампания FREE** — **shipped 2026-05-28** | Поднимет engagement сезонного продукта. | high (shipped, см. commit 5b9e8f8) |
| **Secret Reservation** | Hard add-on 24 ⭐ | **1 free secret res / user / год** | Wow-feature, попробовать → захотеть ещё. | medium |
| **Don't-gift (global)** | FREE | Оставить FREE | Personalization, удержание. | high |
| **Wishlist count** | FREE = 2 | Оставить FREE = 2 | Создаёт явный upgrade trigger без ломания UX (никто пока не упёрся, gate = 1 unique user). | high |
| **Anonymous reserve (display name = null)** | Сейчас prompt обязателен | **Toggle "анонимно" FREE** (E14) — to test | Снижает friction для guest reservation rate. ⚠️ Может каннибализировать Secret Reservation add-on, см. § 8 audit. | medium |

### 6.2 Оставить платным (PRO / add-on)

| Фича | Подтверждённо платная, потому что |
|---|---|
| Showcase + Curated Selections + Public Profile | Always-on, требует continuity — Showcase Annual SKU кандидат на отдельный год-пасс. |
| Comments PRO-side trigger | Любая PR-сторона разблокирует — паттерн стоит сохранить. |
| Birthday advanced (audience EXTENDED, primaryWishlist, customMessage, advanced windows) | Power-user-фича, базовые reminders уже FREE. |
| Smart Reservations (per-list, 15 ⭐) | Per-wishlist permanent unlock — ок, узкая utility владельца. |
| Reservation PRO cluster (history, notes, reminders, purchased flag, filters) | Power-user-фича гостя; 50 ⭐ unlock уместен. |
| Group Gift (79 ⭐ permanent OR в Event Pass) | Event-based, разовая боль, отдельный SKU работает. **Caveat:** 0 usage в проде — может быть не понятно как достать. |
| Santa multi-wave / exclusions / exclusion groups | **Документировать** в `MONETIZATION.md` § 7 (сейчас silent-PRO, см. § 2.9). После документации — оставить PRO. |
| Wishlist visibility = `PUBLIC_PROFILE` / `PRIVATE` | Привязано к public-profile фиче, ок. |
| `allowSubscriptions=NOBODY` / `commentPolicy=SUBSCRIBERS` | Privacy power-features, ок. |
| Hard 402 на bulk URL-import (после free quota) | Если квота заработает — это естественный upsell trigger. |

### 6.3 Что **продавать как add-on / event-pass**, не как фичу PRO

См. [event-pass-spec.md](./event-pass-spec.md) — Event Pass 49 ⭐ / 30 d с full PRO бандлом + Group Gift, **исключения**: Showcase, Smart Reservations, Secret Reservation, renewal reminders. Это **первый шаг** — спека готова, имплементация в E21. Birthday Pass / Santa Pass / NY Pass — follow-up если E21 green.

**Принципы для будущих add-on:**
- **Сезонные / event-based** — Santa, NY, anniversary → time-bound.
- **Wow + low-recurring** — Secret Reservation, Group Gift → permanent unlock OK.
- **Always-on** — Showcase, Curated Selections → annual / monthly OK.
- **Per-list continuity** — Smart Reservations → permanent per-list OK.

**Confidence общая:** **medium.** Подсегменты `featureset` гипотез не валидированы interview/survey; решения исходят из «снять friction до активации + сохранить headline-value на PRO». E21 + survey Q7 (что fair заплатить за) — следующий gate.

---

## 7. Pivot signals

> Pivot-signal = сигнал, что **текущее позиционирование** ("wishlist для подарков от друзей в Telegram") неоптимально, и часть пользователей нужна другая упаковка.

### 7.1 Personal wishlist (юзер ведёт список для себя)

| Сигнал | Источник | Confidence |
|---|---|---|
| H11 (research-plan): «WishBoard как to-do для покупок себе». Качественная гипотеза, валидируется через Q1 survey + interview сегмента A. | `[audit]` [04 § H11](./04-user-research-plan.md) `[survey: PLANNED]` `[interview: PLANNED]` | low |
| Косвенно: 22 owners сгенерили токен и **никому не отправили** (§ 2.3). Может быть — потому что вишлист **для себя**, не для друзей. | `[analytics]` [segment-sizes § 3](./segment-sizes-2026-05.md) | low |
| Q1 «`replace_other_tool`» (заметки/Excel) в survey-формате есть. | `[audit]` [survey-pmf-v1 Q1](./survey-pmf-v1.md) `[survey: PLANNED]` | low |

**Decision:** **Watch.** Если survey Q1 даст ≥ 25 % `replace_other_tool` + Q2 `self_treat` + не-event Q6, добавить "Mode for self" в onboarding (категории "Купить себе / Получить в подарок").

### 7.2 Gift coordination (пара / семья координирует подарки)

| Сигнал | Источник | Confidence |
|---|---|---|
| H13 (research-plan): «gift coordination между парой/семьёй — глубже job, чем wishlist». Не валидирован. | `[audit]` [04 § H13](./04-user-research-plan.md) `[interview: PLANNED]` | low |
| Косвенно: 14 guest-reservers на 152 view-events. Высокий conversion на guest side. | `[analytics]` [segment-sizes § 5](./segment-sizes-2026-05.md) | medium |
| Group Gift = 0 usage. Если коллективные подарки = центральный job, то **либо** UI entry-point не находится, **либо** job не central. | `[analytics]` [segment-sizes § 10](./segment-sizes-2026-05.md) | medium |

**Decision:** **Watch + interview-priority.** Спрашивать в сегменте A (activated) и H (Santa) явно — «координируете ли вы подарки в семье/паре, и как?». Если ≥ 40 % всплывает — расширить позиционирование (групповые расходы / разделение бюджета). E27 (Group Gift) и E21 (Event Pass с Group Gift) — естественные первые тесты.

### 7.3 Event product (Santa / Birthday / NY как самостоятельный микро-product)

| Сигнал | Источник | Confidence |
|---|---|---|
| H12 (research-plan): Santa & Group Gift — отдельный продукт с другой аудиторией. **Не валидирован.** На сейчас Santa = 2 человек (1 на participant role, 0 organizers вне сезона), Group Gift = 0. | `[audit]` [04 § H12](./04-user-research-plan.md) `[interview: PLANNED]` | low |
| Sezonality: Santa-сезон = 15 ноя – 15 фев. Май — заведомо вне-сезон. **Любые выводы по Santa уместны только после Q4 2026.** | `[audit]` [01 § 2.9](./01-product-feature-map.md) | high |
| Birthday Pass + Santa Pass + NY Pass — три кандидата на time-bound SKU после успешного E21 Event Pass. | `[audit]` [03 § 11, event-pass-spec § 1](./03-monetization-paywall-audit.md) | medium |

**Decision:** **Test (E21 / E23 / E24).** Запускать generic Event Pass осенью 2026 как pre-Santa probe. Если paying-users count растёт ≥ 50 % vs Monthly arm — продукт **частично** event-driven. Размышлять о sub-product только после двух сезонов данных.

### 7.4 Self-shopping list (купить себе, не подарок)

| Сигнал | Источник | Confidence |
|---|---|---|
| Q6 «`shopping_assistant`» в survey-формате. | `[audit]` [survey-pmf-v1 Q6](./survey-pmf-v1.md) `[survey: PLANNED]` | low |
| Технически отличается от 7.1 — там вишлист **на потом**, тут — список **активных покупок** (price drop alerts, deals). | — | — |
| Не пересекается с current loop (нет reservation, нет sharing) → если этот use-case всплывает, требует **отдельного продукта** или surface (deal-feed). | conceptual | low |

**Decision:** **Hide** (не строить, не упоминать). Если Q6 даст ≥ 30 % `shopping_assistant` — записать в Q3 2026 backlog, но не реагировать сейчас.

### 7.5 Сводка decision по pivot-signals

| Сигнал | Decision |
|---|---|
| Personal wishlist | **Watch** — survey Q1 / Q2 ≥ 25 % → добавить mode for self |
| Gift coordination | **Watch + interview-priority** — interview A/H, E27 + E21 как probes |
| Event product (Santa/NY/Birthday) | **Test** — E21 + E23 + Birthday Pass spec |
| Self-shopping list | **Hide** — Q3 2026 backlog |

**Confidence общая по pivot:** **low.** Pivot — самое slow-moving решение; ждём interview-волны (planned weeks 1–2 после Phase 0 infra) и first survey response wave (~80 ответов целевые).

---

## 8. Decisions (Build / Test / Hide / Remove)

### 8.1 BUILD (немедленно, без gating)

| ID | Что | Источники / Confidence | Owner / Status |
|---|---|---|---|
| B1 | **Документировать 3 Santa PRO-гейта в `MONETIZATION.md` § 7** (multi_wave, exclusions, exclusion_groups). | `[audit]` § 2.9 / high | not started |
| B2 | **Починить `appearance` upsell-context i18n** для 6 локалей (~1 час). | `[audit]` § 2.8 / high | not started |
| B3 | **Унифицировать paywall envelope формат** (одно из 6 текущих) — 402 + `{ error: 'pro_required', feature, context }`. | `[audit]` [03 § 4.6](./03-monetization-paywall-audit.md) / medium | not started |
| B4 | **`guest.converted_to_user` beacon** на 4 share-путях (item-link, profile, curated, raw-share-token) — foundation для referral re-enable и attribution overall. | `[audit]` + `[analytics]` [guest-conversion-spec § 3](./guest-conversion-spec.md) / high | spec ready, pickup pending |
| B5 | **Server-side `payment.completed` + `pro.activated`** events (P0 analytics gap). Без них корректный funnel невозможен. | `[audit]` [02 § 7](./02-analytics-audit.md) / high | not started |
| B6 | **Унифицировать allowlists** для `AnalyticsEvent` (3 расходящихся) в один источник. Сначала генерация prefix-listа в `telemetry.routes.ts` из `ANALYTICS_EVENTS`. | `[audit]` [02 § 1.7](./02-analytics-audit.md) / high | not started |
| B7 | **Participant limit FREE 5 → 10** (см. § 6). Не trigger'ит ARR risk (текущий cap никем не достигнут), но устраняет primary-use-case-killer. | `[audit]` § 6.1 / high | not started |
| B8 | **Phase 0 эксперимент-инфра.** `useExperiment(key)` хук + sticky bucket + `experiment_assigned` event. Блокирует E03..E25. | `[audit]` [06 § 0](./06-experiment-backlog.md) / high | not started |
| B9 | **Cancel-sheet pro_cancel.* funnel telemetry** — **shipped 2026-05-27**, оставлено в карте для completeness. | `[audit]` § 2.11 / high | done |
| B10 | **Hint quota — 1 free / Santa campaign** — **shipped 2026-05-28** (commit 5b9e8f8). | `[analytics]` / high | done |

### 8.2 TEST (после Phase 0)

| ID | Что | Wave | Confidence |
|---|---|---|---|
| T1 | **E03 — 3 free URL-import credits в первые 24 h.** Проверит, оживает ли URL-import path вообще (сейчас 0 usage). | Wave 1 (week 1–2) | medium |
| T2 | **E04 — Auto-created default wishlist при `/start`.** Снимает шаг "введи название". | Wave 1 (week 1–2) | medium |
| T3 | **E08 — Force-share gate после первого реального wish.** Главная проверка aha-гипотезы § 3. | Wave 2 (week 2–3) | medium-high |
| T4 | **E11 — Post-reservation account-claim CTA — shipped 2026-05-27.** Readout через 14 дней после ship (target ~2026-06-10). | Wave 2 (running) | shipped |
| T5 | **E14 — Anonymous reserve toggle** (без display name). | Wave 3 (week 3–4) | medium |
| T6 | **E15 — Display name prefill из Telegram identity.** ⚠️ Не запускать одновременно с E14. | Wave 3 (week 3–4) | medium |
| T7 | **E17 — Yearly price test 800 → {600, 1000, 1200}.** Нужно ≥ 4 недели для stat-sig. | Wave 4 (week 4–8) | medium |
| T8 | **E20 — Choose-your-price probe.** Quantitative WTP. | Wave 4 (week 5–6) | medium |
| T9 | **E21 — Event Pass 49 ⭐ / 30 d.** Большой системный эксперимент; spec готов. | Wave 5 (week 6–10) | medium |
| T10 | **E23 — Santa pre-season teaser DM (Nov 1).** Prepare заранее, run при season. | Wave-Santa (Q4 2026) | medium |
| T11 | **E24 — Group Gift price elasticity 79 → 39 ⭐.** Сейчас 0 usage; может, цена не главное; пробовать в паре с UI entry-point fix. | Wave 4 | low (medium при UI fix) |
| T12 | **Interview-волна (S1, S2, S3, S5, S8 stratified) + Survey wave-1 ru/en.** **Главный T**. | Weeks 1–4 параллельно | high |

### 8.3 HIDE (убрать из visibility, но не удалять код)

| ID | Что | Источник |
|---|---|---|
| H1 | **Public web reservation flow** (`/w/<slug>` POST endpoints). 0 conv за 30 d. Заменить страницу на минимальный landing с "Open in Telegram" CTA. | [public-web-usage § 4](./public-web-usage.md) |
| H2 | **`seasonal_decoration` SKU** — не дискриминирован в audit как core gap, но 0 usage и узкая utility. Hide → не показывать в pricing surface, оставить эндпоинт для тех, кто уже купил. (P1, low) | `[audit]` [03 § 2.1](./03-monetization-paywall-audit.md) |
| H3 | **Showcase entry CTA в Settings для FREE** — сейчас locked card. Hide до момента активации (≥ 3 real items) — снимает "wall of locks" в первом сеансе. | `[audit]` [03 § 9.1, § 5.3](./03-monetization-paywall-audit.md) |
| H4 | **Tags в Mini App** — model + admin-CRUD есть, UI отсутствует. Decision: либо build (если survey даст признаки), либо явно hide / remove. **Watch**. | `[audit]` [01 § 1.4](./01-product-feature-map.md) |

### 8.4 REMOVE (выпилить код)

| ID | Что | Источник |
|---|---|---|
| R1 | **`bot_import` upsell context** — orphan, 0 calls. Удалить `MiniApp.tsx:2222` ветку + связанные i18n ключи. | `[audit]` § 2.10 |
| R2 | **`/w/<slug>` POST reserve / unreserve / purchase endpoints** — 0 calls / 13 d (nginx логи). После 14 дней мониторинга 410/404 после landing rewrite — удалять. | `[audit]` [public-web-usage § 4](./public-web-usage.md) |
| R3 | **`RESERVATION_PRO_BETA_IDS` env reference в `MONETIZATION.md`** — в коде `isReservationBeta(u) => true` для всех. Это документация устарела, оставлять путаницу нельзя. | `[audit]` [03 § 3.4](./03-monetization-paywall-audit.md) |
| R4 | **Дубликаты event-имён** (`wishlist_created` vs `wishlist.created`, `share.token_generated` vs `share_token_generated`). Зафиксировать один формат, остальные ремап'ить в backfill. | `[audit]` [02 § 1.7](./02-analytics-audit.md) |
| R5 | **`payment.pre_checkout_rejected`** — заявлено в allowlist, но 0 emit'ов. Либо emit'ить (если ценное), либо удалить. | `[audit]` [02 § 2.7](./02-analytics-audit.md) |

---

## 9. Next 30 days roadmap

> Объединяет B (build), T (test), H (hide), R (remove) из § 8 в timeline. Cherry-pick через worktree → main.

### Week 1 (2026-05-28 → 2026-06-04) — Foundation

- **B5 + B6** — `payment.completed` / `pro.activated` events + allowlist unification. **Critical path** — без этого все pricing-эксперименты в Wave 4 невалидны.
- **B4** — `guest.converted_to_user` beacon на 4 share-путях.
- **B8** — Phase 0 эксперимент-инфра.
- **B1 + B2 + B3** — три быстрых хыки (Santa PRO docs, appearance i18n, paywall envelope unification).
- **T12 (kick-off)** — `ResearchSurvey` row создать в проде (статус DRAFT → ACTIVE), wave-1 invites (≤275 invites, S1/S2/S3/S5/S8 stratified). Interview recruit-pipeline (см. [04 § 2](./04-user-research-plan.md)) — рассылка приглашений сегментам A/B/C/D/E/G.
- **B7** — Participant limit FREE 5 → 10. Один commit, низкий риск.
- **R3 + R5** — документационные cleanup'ы (mockup status, dead event).
- **H1 step 1** — `/w/<slug>` landing rewrite (keep OG, drop client reservation UI).

**Post-deploy** для каждого PR — health-check по чек-листу [CLAUDE.md § Post-deploy](#).

### Week 2 (2026-06-05 → 2026-06-11) — Wave 1 + Listen

- **T1 (E03)** — 3 free URL-import credits 24h. Launch + monitor.
- **T2 (E04)** — Auto-created default wishlist. Launch.
- **T4 readout** — E11 post-reservation CTA, 14d marker (2026-06-10).
- **Interview-волна 1**: 5–8 интервью в сегменте B (44 чел., не делились) — **главный insight цикла для § 4**.
- **Survey ≥ 30 ответов целевые** (по 30 на каждую критичную локаль).
- **R1** — bot_import cleanup.

### Week 3 (2026-06-12 → 2026-06-18) — Wave 2

- **T3 (E08)** — Force-share gate. Главный тест aha-гипотезы § 3.
- **Interview-волна 2**: 5–8 в сегменте C (37, делились), 4 + 4 в E (guest-reservers, делим opened-not-reserved vs reserved).
- **Survey результаты** wave-1: targeted N ≥ 80. Закрыть hypothesis H8 (Lifetime perception) + H10 (хинты как trigger).
- **T1 + T2 readout** — оценка D0 activation. Если +20 % — keep; если −5 % — откат.

### Week 4 (2026-06-19 → 2026-06-25) — Wave 3 + Decision Gate

- **T5 (E14) или T6 (E15)** — выбрать один из anonymous-reserve / displayName-prefill (не оба одновременно). Probable выбор T6 (E15) — низкий risk, no cannibalization.
- **Interview-волна 3**: сегмент D (3 платящих as case study) + сегмент G stratified (G2/G3 churned).
- **T3 readout** (E08): share-rate +50 % target. Если D1 retention падает > 2 % — откат.

### Decision gate at week 4 (≈ 2026-06-25)

**Pivot check (per [06 § 0](./06-experiment-backlog.md) и § 7 этого doc'а):**

> Если после E03/E04 + E11 D0 activation не сдвигается **и** интервью сегмента B не дают единого dominant барьера sharing **и** survey Q5 (Sean Ellis) < 40 % "very disappointed" — это **pivot signal**.

В этом случае:
- **Personal wishlist mode** добавить через Q1 / Q2 survey-evidence.
- **Gift coordination expansion** — interview-evidence из A/H волны 2 / Santa.
- Не запускать Wave 4 (pricing experiments) до решения по pivot. Pricing на не-PMF продукте — потеря времени.

В обратном случае (метрики +) — переход к Wave 4 (T7 / T8 / T9 — pricing).

### Не входит в 30-day roadmap (но в очереди)

- **T7–T9 (E17 / E20 / E21)** — pricing & Event Pass, Wave 4 (weeks 5–10).
- **T10 (E23)** — Santa pre-season DM, готовится к 2026-11-01.
- **Referral re-enable** — заблокирован 7 re-enable gates ([referral-decision § 7](./referral-decision.md#7-re-enable-gates-что-закрыть-до-следующего-флипа)).
- **i18n parity wave 2** (zh-CN, hi, es, ar в survey + appearance) — Q3 2026.

---

## 10. Самопроверка

### 10.1 Каждый вывод имеет 2 из 3 источников (interview / survey / analytics)

⚠️ **Не выполнено для большинства выводов.** Причина — interview + survey waves запускаются только Week 1 (см. § 9). На момент v1 этого синтеза:

- **Выводы § 1 (что сделали правильно)** — основаны на **`[audit]` + `[analytics]`** (2/3). OK.
- **Выводы § 2 (где ломаются)** — **`[analytics]` + `[audit]`** (2/3). Сильнее всего поддержаны § 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.12. OK.
- **Вывод § 3 (aha-moment)** — `[analytics]` + `[audit-as-hypothesis]` (1.5/3). **Нужен interview сегмента A + survey Q3** для подтверждения. Помечен `medium-leaning-high`.
- **Вывод § 4 (sharing-барьер)** — `[analytics]` (1/3, плюс audit-гипотеза). **Нужен interview сегмента B**. Помечен `medium`.
- **Вывод § 5 (paid trigger)** — `[analytics N=3]` + `[audit]` (1/3 + hypothesis). **Не reliable**. Помечен `low`.
- **Вывод § 6 (FREE vs PRO)** — `[analytics]` + `[audit]` (2/3). OK. Конкретные числа квот (5 импортов/мес, 3 категории) — gut-feel, нужна валидация в первых 30 днях.
- **Вывод § 7 (pivot signals)** — `[audit-hypotheses]` only (0.5/3). **Целиком зависит от survey Q1 / Q2 / Q6 + interview A/B/G**.

**Net:** до запуска interview/survey волны (Week 1–2 § 9) каждый вывод § 3–§ 7 должен читаться как **direction**, не final decision. Документ предусматривает refresh версии v2 после первого insights-readout (≈ 2026-06-25).

### 10.2 Confidence per insight

✅ Указан в каждой таблице. Глобально:
- **high** — 14 выводов (§ 1.1–1.8, § 2.1–2.10, § 2.12, § 2.13 disclaimer).
- **medium** — 12 выводов (§ 2.13, § 3 aha, § 4 sharing, § 6.1 большая часть, § 7.2 gift coordination, § 7.3 event product, § 8.1–§ 8.4 build/test).
- **low** — 8 выводов (§ 5 paid trigger, § 7.1 personal, § 7.4 self-shopping, big part of § 7).

### 10.3 N < 5 disclaimer

✅ Применён для:
- **Paid users (N = 3)** — § 5 явно помечен ⚠️.
- **Santa users (N = 2)** — § 7.3.
- **Group Gift (N = 0)** — § 2.5, § 7.2.
- **URL Import (N = 0)** — § 2.4.
- **Paywall viewed (N = 5)** — borderline, отмечен в § 5.
- **Limit-hit users (N = 2)** — § 5.

### 10.4 Decision log

✅ Создан в § 8 (Build / Test / Hide / Remove × ID). Дополнительный chronological log:

| Дата | Decision | Источник | Status |
|---|---|---|---|
| 2026-05-19 | Snapshot segment sizes — большинство сегментов N<5; main story = 89.6 % inactive. | `[analytics]` snapshot | logged |
| 2026-05-21 | Hints — 3 free / месяц для FREE. **Shipped.** | `[audit]` § 6.1 | done |
| 2026-05-22 | Next.js 15.5 + React 19 migration. **Shipped + verified.** | `[audit]` git log | done |
| 2026-05-25 | Referral program flip OFF (был случайно ON 38 дней). 7 re-enable gates. | `[analytics]` + `[audit]` [referral-decision](./referral-decision.md) | done (flipped OFF) |
| 2026-05-25 | Public web `/w/<slug>` — retire reservation flow, оставить OG landing. | `[analytics]` [public-web-usage](./public-web-usage.md) | spec, pickup pending |
| 2026-05-25 | Event Pass spec — single SKU 49 ⭐ / 30 d, E21. | `[audit]` [event-pass-spec](./event-pass-spec.md) | spec ready |
| 2026-05-25 | `guest.converted_to_user` spec — 4 Mini App paths, beacon helper. | `[audit]` [guest-conversion-spec](./guest-conversion-spec.md) | spec ready |
| 2026-05-27 | E11 post-reservation CTA. **Shipped** (A/B, 50/50, kill-switch). Readout ≈ 2026-06-10. | git log (`0268fe2`, `561afc4`) | running |
| 2026-05-27 | Cancel sheet 9 features + telemetry. **Shipped.** | `[audit]` § 2.11 | done |
| 2026-05-28 | Conservative pricing: Santa hint 1/campaign FREE; PRO unlimited categories; hide seasonal_decoration. **Shipped** (commit 5b9e8f8). | git log | done |
| 2026-05-28 | **THIS DOC** — synthesis v1. Roadmap weeks 1–4 фиксирован, refresh v2 ≈ 2026-06-25 после interview/survey wave-1. | `[audit]` all sources | draft → review |

---

## 11. Что НЕ покрывает этот синтез (явно out-of-scope)

- **B2B / agency tooling** — отсутствует use-case, ни в одном сегменте.
- **AI-powered wish suggestions** — слишком далеко от current feature surface, отдельная discovery.
- **Server perf / infra** — растёт только из guardrail-violations; на текущей нагрузке не критично.
- **Long-term churn analysis** — продукт ~2 месяца, «churned» = люди с очень коротким опытом. Любые retention-выводы > D30 — premature.
- **Locale segmentation выводы** (за пределами raw-data факта по локалям) — wave-1 survey ru/en only; wave 2 (Q3 2026) для zh-CN/hi/es/ar.
- **Bot-channel optimization** (DM cadence, lifecycle touches outside winback) — отдельный audit, не в этой волне.
- **Telegram Stars vs. fiat pricing strategy** — Stars обязательны (TG Mini App constraint), fiat не in scope.

---

## 12. Refresh trigger для v2

v2 этого doc'а нужен когда выполнится **любое** из:

1. ≥ 50 % completion первой interview-волны (≈ 20 интервью).
2. Survey wave-1 ≥ 80 ответов (Sean Ellis stat-sig threshold).
3. E03 + E04 + E11 readouts (3 эксперимента закрыты).
4. **2026-06-25** (calendar deadline для week-4 decision gate).

Раньше всего, что наступит. Refresh ставит **v2 confidence-rubric** заново — interviews + survey должны конвертировать `low` → `medium-high` для § 3 / § 4 / § 5 / § 7.

---

**End of document.**
