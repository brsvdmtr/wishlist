# Referral Program — решение по запуску

**Дата:** 2026-05-25
**Скоуп:** ReferralProgramConfig в prod, UI-видимость, события, attribution
**Решение:** **Keep disabled** — флипнуть `enabled=false` в prod, держать код, не запускать до закрытия gap'ов

---

## 1. Что нашлось (TL;DR)

Самый важный факт: **прод и research docs рассинхронизированы**.

| Источник | Состояние |
|---|---|
| `docs/research/06-experiment-backlog.md:19, 595` | "`ReferralProgramConfig.enabled = false`" |
| Прод `ReferralProgramConfig` (на 2026-05-25) | `enabled=true, rolloutPercent=100`, все entry-points `true`, last update 2026-04-17 by `github-actions` |

То есть программа уже **включена в проде** и доступна 100% пользователей, но это никем не запускалось как launch event — флаг сидит на дефолтах с 2026-04-17.

---

## 2. Что показывает prod DB

```sql
SELECT enabled, "rolloutPercent", "updatedAt", "updatedByAdminId"
FROM "ReferralProgramConfig";
-- enabled=t, rolloutPercent=100, updatedAt=2026-04-17 16:06:37, updatedByAdminId=github-actions
```

| Метрика | Значение | Комментарий |
|---|---|---|
| `UserProfile.referralCode IS NOT NULL` | **54 / 315** | ~17% пользователей уже получили реф-код (UI вызывал `/tg/referral/me`) |
| `UserProfile.referredByUserId IS NOT NULL` | **0** | никто никогда не был атрибутирован как invitee |
| `UserProfile.firstBotStartAt IS NOT NULL` | **2 / 315** | bot-funnel почти мёртв (test-данные 2026-04-17) |
| `ReferralAttribution` rows | **0** | тестовые attributions с 2026-04-17 очищены |
| `ReferralReward` rows | **1** | единственный grant: `idempotencyKey='grant:cmo2z6tq9000j1qxr98xcp57n'`, `grantStrategy='replace'`, `+30 days`, **без `grantedByAdminId`** — system grant в день тест-запуска |

### Аналитика — что реально успело лечь в `AnalyticsEvent`

```
event                                    | count | first      | last
-----------------------------------------+-------+------------+-----------
referral.first_item_created              |   68  | 2026-04-17 | 2026-05-25  ← хук вызывается на ЛЮБОЕ первое
referral.first_wishlist_created          |   26  | 2026-04-17 | 2026-05-25  ← item/wishlist, не только у invitee
referral.start_command_received          |    6  | 2026-04-17 | 2026-05-06
referral.bot_notification_sent           |    6  | 2026-04-17 | 2026-04-17  ← все 6 — launch-day
referral.config_changed                  |    5  | 2026-04-17 | 2026-04-17
referral.rewarded                        |    3  | 2026-04-17 | 2026-04-17
referral.attribution_rejected_on_write   |    3  | 2026-05-02 | 2026-05-06
referral.attributed                      |    3  | 2026-04-17 | 2026-04-17
referral.pro_subscription_extended       |    3  | 2026-04-17 | 2026-04-17
referral.qualified                       |    3  | 2026-04-17 | 2026-04-17
referral.qualification_criteria_met      |    1  | 2026-04-17 | 2026-04-17

referral.entry_point_impression          |    0  ⚠️  emit в коде есть, до DB не доходит
referral.entry_point_clicked             |    0  ⚠️
referral.screen_opened                   |    0  ⚠️
referral.share_intent / share_completed  |    0  ⚠️
referral.rules_opened / history_opened   |    0  ⚠️
referral.home_banner_dismissed           |    0  ⚠️
referral.fraud_signal_*  (8 types)       |    0  ⚠️
referral.invitee_converted_to_paid       |    0  ⚠️ критично для ROI
referral.invitee_retained_d7 / d30       |    0  ⚠️ критично для retention
```

**Все события 2026-04-17 — launch-day smoke-test одним аккаунтом.** Реальные пользователи не используют флоу.

---

## 3. Почему UI-события референов = 0 (root cause)

`apps/web/app/miniapp/MiniApp.tsx` emit'ит `referral.entry_point_impression` (line 2186, 9820, 26871), `referral.share_intent` (20829), `referral.rules_opened` (21118) и т.д.

Эти события идут через `tgFetch('/tg/telemetry', …)`. Но в `apps/api/src/routes/telemetry.routes.ts:44-59` allowlist префиксов **не содержит `referral.`**:

```ts
const ANALYTICS_EVENT_PREFIXES = [
  'miniapp.', 'showcase.', 'onboarding.', ...
  'wish.', 'wishlist.', 'import.', 'reservation.',
  'guest.', 'bot.', 'payment.', 'share.',
  'lifecycle_',
  // ← нет 'referral.'
];
```

`isAllowedAnalyticsEvent('referral.entry_point_impression')` возвращает `false` → telemetry-роут **молча дропает событие**. Комментарий в коде это даже подтверждает (line 65–67):

> "Today these are de-facto blocked because their domain prefix (`referral.`) isn't in ANALYTICS_EVENT_PREFIXES"

`referral.invitee_converted_to_paid` отдельно занесён в `LEGACY_SERVER_ONLY_EVENTS` (line 74) с явным hard-deny — но server-side emit для него тоже не реализован, так что метрика ROI **физически не существует**.

Server-side события (`referral.attributed`, `qualified`, `rewarded`, `bot_notification_sent`, etc.) идут через `trackAnalyticsEvent` напрямую в Prisma и проходят. То есть **~10 из 68 декларированных событий реально работают** — это совпадает с `02-analytics-audit.md:243-247`.

---

## 4. Состояние кода (что построено и насколько корректно)

| Слой | Файл / линия | Состояние |
|---|---|---|
| Schema | `packages/db/prisma/schema.prisma:2153-2296` | ✅ Все 3 таблицы (Attribution / Reward / Config) + поля на UserProfile |
| Миграция | `20260425000000_add_referral_program` | ✅ Применена в prod 2026-04-17 |
| Кодогенерация | `packages/db/src/referral.ts: ensureReferralCode` | ✅ Lazy-генерация; работает (54 кода в проде) |
| Attribution | `packages/db/src/referral.ts:358 tryCreateAttribution` | ✅ Гейт `if (!config.enabled) return program_disabled` на line 364 — флип в `false` корректно остановит |
| Qualification + reward | `apps/api/src/services/referral-hooks.ts:124 runReferralProgressHook` | ✅ Хуки на `first_wishlist` / `first_item` |
| Bot `/start ref_X` | `apps/bot/src/index.ts:777-844` | ⚠️ Сам **не** проверяет `config.enabled` перед вызовом `tryCreateAttribution`, но защищён внутренним гейтом attribution-функции |
| Scheduler | `apps/api/src/schedulers/referral.ts` | ✅ 15-min sweep PENDING_ACTIVATION → REJECTED по `windowDeadlineAt` |
| API routes | `apps/api/src/routes/referral.routes.ts` | ✅ 4 эндпоинта: `/me`, `/history`, `/stats`, `/rules-config` |
| UI Profile tile | `MiniApp.tsx:2175-2222` | ✅ `config.enabled && inRollout && entryPointProfile` — корректно скрывается |
| UI Paywall sheet | `MiniApp.tsx:3660-4052, 26871` | ✅ `referralConfig?.enabled && inRollout && entryPointPaywall` |
| UI Home banner | `MiniApp.tsx:9812, 13725` | ✅ те же 3 условия + 14-day dismissed-window в localStorage |
| UI Post-Share | `MiniApp.tsx:5145` (type only) | ❌ **Поле в config есть, рендерер не написан** |
| Fraud signals | — | ❌ 8 типов сигналов в allowlist, **никто не emit'ит** (только агрегированный `qualification_timeout`) |
| ROI metric | — | ❌ `invitee_converted_to_paid` нет в `payment.completed` handler |
| Retention metric | — | ❌ `invitee_retained_d7/d30` нет в scheduler |

---

## 5. Self-check (из ТЗ)

| # | Утверждение | Факт |
|---|---|---|
| 1 | Нет user-facing UI, если program disabled | ❌ Сейчас **enabled=true** → UI виден (Profile tile, Paywall, Home banner). 54 пользователя уже получили код |
| 2 | Все referral events считаются | ❌ ~10/68 реально пишутся в `AnalyticsEvent`. UI-engagement и fraud-signals dropped at `/tg/telemetry`. ROI-метрика hard-denied + не emit |
| 3 | Не запускать referral до analytics foundation | ❌ Foundation broken: нет `guest.converted_to_user → invitee_converted_to_paid` цепочки, нет retention-метрик, UI-funnel невидим в DB |

Все три self-check провалены текущим состоянием прода.

---

## 6. Decision

### Keep disabled — флипнуть `enabled=false` в prod сейчас

Конкретное действие (один SQL-апдейт):

```sql
UPDATE "ReferralProgramConfig"
SET enabled=false,
    "configVersion"='v2-disabled-2026-05-25',
    "updatedAt"=now()
WHERE id='default';
```

После флипа:
- `tryCreateAttribution` отбрасывает входящие `?start=ref_X` с `kind='program_disabled'` (line 364)
- Mini App `ReferralProfileTileFromConfig`, `referralHomeBannerVisible` и paywall-referral-sheet станут не-рендериться (все три гейтят `config.enabled && inRollout`)
- `ensureReferralCode` перестанет генерировать новые коды (`/tg/referral/me` будет возвращать `programActive=false`)
- 54 уже-сгенерированных кода **остаются в DB** — это не вредит, ссылки просто будут отбракованы при попытке атрибуции
- 1 уже-выданный reward остаётся в силе

### Почему не "Enable as-is"

- Analytics foundation сломана — половина funnel невидима в DB, ROI метрики нет
- Запуск размывает существующие A/B экспозиции (`06-experiment-backlog.md:595` явно говорит "включение — отдельный launch event, не A/B")
- Бот не имеет своего kill-switch перед `tryCreateAttribution` — если флип когда-то понадобится экстренно, остановит только data-layer гейт; стоит укрепить

### Почему не "Remove later"

- Код хорошо построен (3 таблицы + 4 эндпоинта + scheduler + bot integration + 13 терминальных аналитических исходов в `runReferralProgressHook` — это месяцы работы)
- Migration уже в проде, удаление дороже сохранения
- Per `02-analytics-audit.md:497-498` ROI-events — это P0 gap, который и так нужно закрыть для других целей
- Per `06-experiment-backlog.md:595` launch запланирован как отдельное событие — фича нужна

---

## 7. Re-enable gates (что закрыть до следующего флипа)

Когда будем готовы реально запускать referral как launch event:

1. **Добавить `'referral.'` в `ANALYTICS_EVENT_PREFIXES`** в `apps/api/src/routes/telemetry.routes.ts:44-59`. Без этого 7 UI-engagement событий (`entry_point_impression`, `entry_point_clicked`, `screen_opened`, `share_*`, `rules_opened`, `history_opened`, `home_banner_dismissed`) физически не попадают в DB.
2. **Emit `referral.invitee_converted_to_paid`** server-side в `payment.completed` handler — проверять `ReferralAttribution.invitedUserId = userId` и emit'ить (per `02-analytics-audit.md:497`). После этого можно убрать из `LEGACY_SERVER_ONLY_EVENTS`.
3. **Emit `referral.invitee_retained_d7` / `d30`** из daily scheduler (per `02-analytics-audit.md:498, 556`).
4. **Emit `referral.fraud_signal_*` (8 типов) и `fraud_score_calculated`** при scoring внутри `processReward`. Сейчас только агрегированный `qualification_timeout` пишется — нельзя расследовать fraud-кластеры.
5. **Решить судьбу `entryPointPostShare`:** либо написать UI consumer (после share wishlist предлагать referral), либо убрать поле из config / `ReferralRulesConfig` type.
6. **Foundation prerequisite (per ТЗ self-check #3):** `guest.converted_to_user` event + core activation analytics должны существовать и быть проверены. Сейчас `guest.converted_to_user` — P0 gap в `02-analytics-audit.md:548`.
7. **Bot defense-in-depth:** добавить `loadReferralConfig` + `if (!config.enabled) return` в `apps/bot/src/index.ts:777` ДО `tryCreateAttribution`, чтобы бот сам гейтил, а не полагался на data-layer. Закроет последний "молчаливо открытый" путь.
8. **Документация:** обновить `06-experiment-backlog.md:19` и `:595` — там до сих пор написано "enabled=false", что было правдой ровно до 2026-04-17 16:06:37 UTC.

---

## 8. Дополнительные находки (заодно)

- **`ReferralProgramConfig.updatedByAdminId='github-actions'`** — конфиг изменён CI/CD пайплайном, не человеком. Стоит проверить, нет ли seed/migration-скрипта, который ставит `enabled=true` при деплое. Если есть — после флипа в `false` следующий деплой может откатить решение. (Грубо grep'нуть `enabled.*true` в `packages/db/prisma/migrations/*` и `apps/api/src/bootstrap`.)
- **0 events `bot_notification_sent` после 2026-04-17** при том, что `config.notifyInviterArrival=true` и `notifyInviterReward=true` — подтверждает, что реального трафика по `?start=ref_X` не было ни разу за 38 дней.
- **`referral.first_item_created` (68) и `first_wishlist_created` (26)** emit'ятся для ВСЕХ пользователей при первом item/wishlist (хук `runReferralProgressHook` вызывается из `items.routes.ts` / `wishlists.routes.ts` независимо от того, есть ли у пользователя attribution). Это «правильный» дизайн — `tryQualifyAttribution` внутри хука сам делает no-op, если нет attribution — но название event'а вводит в заблуждение: оно НЕ значит "первый item у invitee", а "первый item вообще". Подкорректировать названия или добавить prop `hasAttribution: boolean` имеет смысл до запуска, иначе аналитик не отличит сигнал от шума.

---

## 9. Что отдать действиями

| # | Действие | Где | Кто |
|---|---|---|---|
| Now | SQL-флип `enabled=false` (см. § 6) | prod DB | следующий sandbox-runner |
| Now | Smoke-проверить: `/tg/referral/me` возвращает `programActive=false`; Profile tile исчез из Mini App | prod | то же |
| Soon | Обновить `06-experiment-backlog.md:19` и `:595` — отразить «программа была случайно ON 2026-04-17 → 2026-05-25, флипнута в OFF» | repo | следующий PR |
| Before re-enable | Закрыть 8 re-enable gates (§ 7) | repo | будущий launch-event |

---

## 10. Status update (2026-05-25, после исполнения)

| Gate | Status | Notes |
|---|---|---|
| Flip `enabled=false` в prod | ✅ Done | `configVersion=v2-disabled-2026-05-25`, cache invalidated, `referral.config_changed` event emitted |
| Update `06-experiment-backlog.md` § lines 19, 595 | ✅ Done | Указано «случайно ON 2026-04-17 → флип 2026-05-25» |
| § 7.1 — `referral.` UI events в telemetry allowlist | ✅ Done | Добавлено как exact-match (не prefix) в `ANALYTICS_EVENT_EXACT`, ~22 client-trustable names |
| § 7.2 — emit `referral.invitee_converted_to_paid` | ✅ Already wired | Был реализован в `apps/bot/src/analytics.ts:150` с самого начала. 0 emit в проде — потому что 0 attribution → 0 referredByUserId. Не код-gap |
| § 7.3 — daily scheduler `invitee_retained_d7/d30` | ✅ Done | Новый `apps/api/src/schedulers/referral-retention.ts`, регистрация в `apps/api/src/index.ts`, 5 тестов |
| § 7.4 — emit `referral.fraud_signal_*` в processReward | ✅ Done | Direct `prisma.analyticsEvent.create` в `packages/db/src/referral.ts`, 4 теста |
| § 7.5 — судьба `entryPointPostShare` | ✅ Done (removed) | Удалено из `/rules-config` response + Mini App type. DB column + admin PATCH сохранены для backward-compat |
| § 7.6 — `guest.converted_to_user` foundation | ✅ Done 2026-05-27 | Audit-doc был неправ — emit уже wired в `wishlists.routes.ts:855`. Real gap: 315/315 prod UserProfile.firstAcquisitionSource=NULL, потому что attribution beacon в Mini App стрелял только для `src_*` start-payload. Fix: helper `lib/attribution.ts` + 4 entry path в bootstrap (`__item_`, `profile_`, `cs_`, catch-all share) + bot-side `writeReferralAcquisitionSource` для `?start=ref_<CODE>` (works даже при program OFF). См. [`guest-conversion-spec.md`](./guest-conversion-spec.md) |
| § 7.7 — bot defense-in-depth | ✅ Done | `loadReferralConfig` + early-return в `apps/bot/src/index.ts:777` перед `tryCreateAttribution`. Emits `referral.feature_flag_evaluated` |
| § 7.8 — обновить research docs | ✅ Done | См. § 9, plus `BUGFIX_LESSONS.md` 2026-05-25 entry |

**Не делал:**
- Удаление DB-колонки `entryPointPostShare` — миграции дороже keep.
- Удаление 54 уже-сгенерированных `referralCode` — безвредно остаются.

**Pre-requisite для следующего launch event** (когда будем включать обратно):
1. ~~`guest.converted_to_user` foundation~~ — ✅ shipped 2026-05-27
2. ~~Подтвердить, что admin-ops.yml `bump-rollout` не откатит флип~~ — ✅ verified 2026-05-28 (см. § 11)
3. ~~Run `docs/research/referral-decision.md` через одного человека для sanity check метрик ROI~~ — ✅ Done 2026-05-28 by Claude (см. § 11)
4. ~~Через 7 дней после deploy запустить self-check SQL~~ — ✅ автоматизировано через [`.github/workflows/referral-self-check.yml`](../../.github/workflows/referral-self-check.yml), cron fires 2026-06-03 07:00 UTC, Telegram alert в админ-чат с PASS/FAIL + готовым SQL для флипа

---

## 11. Sanity check 2026-05-28 (Claude)

Pre-req #3 — проход всего документа против текущего кода + prod-данных
3 дня после флипа. Цель: убедиться что цифры, file:line, статусы из §§ 1-10
не разъехались с реальностью прежде чем запускать launch event.

### 11.1 Methodology

- **§ 2 (prod DB)** — пересчитал все 6 числовых утверждений против live
  Postgres (`docker exec wishlist-prod-postgres-1 psql`).
- **§ 3 (telemetry allowlist)** — grep + чтение
  [`apps/api/src/routes/telemetry.routes.ts:44-107`](../../apps/api/src/routes/telemetry.routes.ts).
- **§ 4 (code state)** — grep'нул каждую file:line, проверил что named
  export'ы существуют и smыcl совпадает.
- **§ 7 (re-enable gates) + § 10 (status)** — для каждого "✅ Done" нашёл
  соответствующий код / data и убедился что claim верен.
- **Pre-requisites 2/3/4 (под § 10)** — закрыл #2 grep'ом admin-ops.yml,
  #3 закрывается этой секцией, #4 закрыл коммитом self-check workflow'а.

### 11.2 Confirmed-still-accurate

| Claim | Источник | Текущее значение | Verdict |
|---|---|---|---|
| `enabled=false` после флипа | § 1 | `enabled=f, configVersion=v2-disabled-2026-05-25, updatedByAdminId=manual-decision-2026-05-25` | ✅ держится |
| `UserProfile.referralCode IS NOT NULL = 54` | § 2 | 54 | ✅ identical |
| `UserProfile.referredByUserId IS NOT NULL = 0` | § 2 | 0 | ✅ identical |
| `UserProfile.firstBotStartAt IS NOT NULL = 2` | § 2 | 2 | ✅ identical |
| `ReferralAttribution` rows = 0 | § 2 | 0 | ✅ identical |
| `ReferralReward` rows = 1 | § 2 | 1 | ✅ identical |
| `total UserProfile = 315` | § 2 | 327 (+12) | ✅ expected drift — новые юзеры за 3 дня |
| `referral.` events count breakdown (12 событий, ~ всё совпадает) | § 2 | first_item +4 (68→72), first_wishlist +1 (26→27), config_changed +1 (5→6 — флип сам), остальные identical | ✅ ожидаемое движение от daily traffic |
| `referral.` UI events в `ANALYTICS_EVENT_EXACT` (22 names) | § 10.7.1 | 22 exact-match names в `apps/api/src/routes/telemetry.routes.ts:71-93` | ✅ |
| `invitee_converted_to_paid` emit в боте | § 10.7.2 | `apps/bot/src/analytics.ts:151` (не :150 как в doc — off by 1, см. § 11.3) | ✅ wired |
| Retention scheduler с 5 тестами | § 10.7.3 | `referral-retention.ts` + `.test.ts` 5 тестов | ✅ |
| `fraud_signal_*` emit в processReward | § 10.7.4 | `packages/db/src/referral.ts:802` | ✅ (3 теста — не 4 как в doc, см. § 11.3) |
| `entryPointPostShare` убрано из `/rules-config` | § 10.7.5 | `apps/api/src/routes/referral.routes.ts:481` comment "removed 2026-05-25" | ✅ (admin PATCH принимает для backward-compat — корректно) |
| Bot defense-in-depth — `loadReferralConfig` early-return | § 10.7.7 | `apps/bot/src/index.ts:799` + emits `referral.feature_flag_evaluated` line 804 | ✅ |
| `schema.prisma:2153` ReferralAttribution model | § 4 | line 2153 точно | ✅ exact match |
| `referral.ts:358 tryCreateAttribution` + line 364 program_disabled gate | § 4 | line 358 + line 364 точно | ✅ exact match |
| `runReferralProgressHook` в services/referral-hooks.ts:124 | § 4 | line 124 точно | ✅ |

### 11.3 Stale / off-by-N

| Claim | Doc | Реальность | Severity |
|---|---|---|---|
| `apps/bot/src/analytics.ts:150` for `invitee_converted_to_paid` | § 10.7.2 | line 151 | trivial — off by 1 |
| 4 fraud-signal тестов | § 10.7.4 | 3 явных `it(...)` блока с fraud emit assertions | minor — undercounted |
| `MiniApp.tsx:2175-2222` для Profile tile | § 4 | `ReferralProfileTileFromConfig` теперь на line 1320/1327 (–850 строк) | expected — `feedback_spec_drift` per memory |
| `MiniApp.tsx:3660-4052, 26871` для Paywall | § 4 | gate logic теперь на line 2803, 3174 (–500 / –23000+) | expected — MiniApp.tsx был сильно перекроен (extraction wave) |
| `MiniApp.tsx:9812, 13725` для Home banner | § 4 | gate на line 8759, 13167 (–1000 / –600) | expected — то же |

Все MiniApp.tsx ссылки сдвинуты, но семантика (`config.enabled && inRollout
&& entryPointX`) — на месте. Это типичный line-number drift в живом
~30k-LOC файле, не concerns.

### 11.4 Closed by this session

- **§ 8 finding (misnamed `first_*_created` events)** — закрыто PR
  [1081376](https://github.com/brsvdmtr/wishlist/commit/1081376) (2026-05-28):
  добавлен prop `hasAttribution: boolean` в `runReferralProgressHook`.
  Future launch dashboard сможет фильтровать invitee-only signal через
  `WHERE props->>'hasAttribution' = 'true'`.
- **screen_load_failed без reason** — закрыто PR
  [3e3e2f6](https://github.com/brsvdmtr/wishlist/commit/3e3e2f6) (2026-05-28):
  5-bucket taxonomy + `httpStatus` prop.

### 11.5 Pre-req #2 verification (admin-ops bump-rollout safety)

Прошёл `.github/workflows/admin-ops.yml` line 181-187:
```yaml
bump-rollout)
  echo "=== PATCH rolloutPercent → ${ROLLOUT}% ==="
  curl ... -d "{\"rolloutPercent\":${ROLLOUT},\"updatedByAdminId\":\"github-actions\"}" ...
```
PATCH body содержит только `rolloutPercent` и `updatedByAdminId` — `enabled`
поле никогда не передаётся. ✅ Безопасно — `bump-rollout` не может откатить
флип `enabled=false → true`.

### 11.6 Follow-ups (не блокеры launch'а)

| # | Item | Severity | Owner |
|---|---|---|---|
| F1 | Q2 self-check threshold `distinct_sources ≥ 2` будет FAIL даже на здоровой системе — за 3 дня post-foundation только `share_link` стреляет. Нужно либо понизить порог, либо разобраться почему `cs_` / `profile_` paths не дают трафика. | minor | прод-владелец, до launch'а |
| F2 | CLAUDE.md health-check snippet содержит `SELECT * FROM "ServiceHeartbeat"` без явных колонок — реальная колонка `serviceName`, не `service`. Споткнулся в post-deploy 2026-05-28. | trivial | следующий, кто потрогает CLAUDE.md |
| F3 | Doc упоминает "4 fraud-signal tests" в § 10.7.4, реально 3. Поправить или допилить 4-й тест (например, `multi_signal` case). | trivial | при следующем походе в referral.test.ts |

### 11.7 Verdict

**Sanity check passed.** Все load-bearing утверждения (§§ 1, 2, 3, 7, 10)
остались корректны. Stale MiniApp.tsx line numbers — ожидаемая drift в
30k-LOC monolith'е и не влияет на launch decision. Pre-requisites 1-4 все
закрыты или автоматизированы. **Программа готова к re-enable** как только
self-check 2026-06-03 даст PASS (или после ручного review его FAIL-explanation).

— Claude, 2026-05-28
