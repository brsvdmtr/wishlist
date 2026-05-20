# Аналитика WishBoard — аудит PII в `AnalyticsEvent.props`

**Дата:** 2026-05-20
**Автор:** PII-аудит аналитики (Claude)
**Статус:** аудит + фикс (`sanitizeAnalyticsProps`) в одном PR
**Триггер:** [02-analytics-audit.md](./02-analytics-audit.md) § 6.3.3 и § 11.6 —
«`item_created.props.title` — пользовательский контент в analytics».
**Связанные доки:** [analytics-events.md](../analytics-events.md),
[ANALYTICS_AND_GODMODE.md](../ANALYTICS_AND_GODMODE.md)

---

## 0. TL;DR

- **Хорошая новость:** ни один действующий call-site **не пишет** сырой
  пользовательский контент в `AnalyticsEvent.props`. `item_created` пишет
  только `itemId / wishlistId / source / platform / isFirstItem` — **без
  `title` и `description`**. Утверждение в `02-analytics-audit.md` § 2.5,
  что `item_created.props` содержит `title, description`, — **неактуально**
  (вероятно, описывает прежнюю версию кода).
- **Плохая новость:** дисциплина держится **только на договорённости**.
  Структурно ничто не мешает:
  1. новому call-site дописать `title` в props;
  2. модифицированному клиенту прислать `{title: "..."}` на `POST /tg/telemetry`
     — эндпоинт принимает `props: z.record(z.unknown())`, т.е. **любые** ключи;
  3. legacy-функции `trackEvent` писать строку любой длины — она **не
     truncate'ила** props вообще.
- **Дублирование:** логика truncate (300 символов/строка + 1024 байта суммарно)
  была **скопирована в 4 местах** и могла разойтись.
- **Фикс:** единый помощник `sanitizeAnalyticsProps()` в `@wishlist/shared`
  — он (а) **выкидывает ключи с пользовательским контентом** по denylist'у имён,
  (б) truncate'ит. Вызывается на **каждом** write-пути в `AnalyticsEvent`.
  Договорённость становится **принудительной границей**.

---

## 1. Что считаем PII (scope аудита)

Под «пользовательским контентом» в этом аудите понимаем свободный текст,
введённый пользователем:

| Категория | Источник | Пример ключа props |
|---|---|---|
| Item title | название желания | `title` |
| Item description | описание желания | `description` |
| Comment text | текст комментария / реплая | `commentText` |
| Hint text | текст подсказки дарителю | `hintText` |
| Search text | поисковый запрос | `query`, `searchText` |
| Freeform input | заметки, кастом-сообщения, ответы опросов, bio | `note`, `message`, `answerText`, `bio` |

**Вне scope** (но отмечено в § 7): `username` (Telegram-хэндл —
идентификатор, а не контент) и тексты ошибок (`reason`).

`AnalyticsEvent` — таблица **без шифрования**, с **90-дневным TTL**, читается
ad-hoc в god-mode. Контент пользователя там не нужен аналитике (нужны счётчики
и «формы» событий) и является комплаенс-риском. Поэтому правильная цель —
**контент туда не попадает вообще**.

---

## 2. Все write-пути в `AnalyticsEvent`

| # | Путь | Файл | Truncate до фикса | PII-strip до фикса |
|---|---|---|---|---|
| 1 | `trackEvent` (legacy, prefix-allowlist) | [services/analytics.ts](../../apps/api/src/services/analytics.ts) | ❌ нет | ❌ нет |
| 2 | `trackAnalyticsEvent` (`ANALYTICS_EVENTS` allowlist) | services/analytics.ts | ✅ inline | ❌ нет |
| 3 | `trackProductEvent` (`PRODUCT_EVENTS` typed) | services/analytics.ts | ✅ inline | ❌ нет |
| 4 | `POST /tg/telemetry` (клиентский батч) | [routes/telemetry.routes.ts](../../apps/api/src/routes/telemetry.routes.ts) | ✅ inline | ❌ нет |
| 5 | `trackProductEvent` / `_rawEmit` (бот) | [apps/bot/src/analytics.ts](../../apps/bot/src/analytics.ts) | ✅ inline / ❌ | ❌ нет |
| 6 | прямые `prisma.analyticsEvent.create` (бот `/start`) | [apps/bot/src/index.ts](../../apps/bot/src/index.ts) | ❌ нет | ❌ нет |

Фронтенд (`MiniApp.tsx:5650` `trackEvent` → `telemetryBufferRef` → flush) сам
**ничего не персистит** — он лишь буферизует и шлёт на путь #4. Поэтому
серверная санитизация на `/tg/telemetry` — это **авторитетная граница**: она
покрывает любые версии Mini App, закешированные в Telegram-клиентах.

---

## 3. Посайтовый разбор — где мог бы быть контент

| Событие | Где | Props | Контент? |
|---|---|---|---|
| `item_created` | wishlists.routes.ts:1828, url-import.ts:226, MiniApp.tsx:10686 | `itemId, wishlistId, wishlistType, source, platform, isFirstItem` | ✅ чисто |
| `wish.created` / `wish.edited` / `wish.deleted` | items.routes.ts:783/888/960, wishlists.routes.ts:1885 | `itemId`, `hasUrl`, `hasPrice` | ✅ чисто |
| `comment_reply_*`, `comment_deleted_with_replies` | comments.routes.ts | `itemId, commentId, parentCommentId, role, reason` | ✅ только id/enum |
| `hint_created` | hints.routes.ts:318 | `itemId, hintId` | ✅ чисто |
| `search.query_completed` | search.routes.ts:140 | `queryLength, normalizedQueryHash, resultCount` | ✅ хэш + длина, raw query **никогда** не пишется |
| `survey.question_answered` | research-survey.routes.ts:150 | `questionId, optionIds, hasText` | ✅ `hasText` — boolean, не текст |
| `gift_occasion_created` | gift-notes.routes.ts:223 | `type, source` | ✅ чисто |
| `birthday.custom_message_saved` | me.routes.ts:674 | `{}` | ✅ пустые props |
| `onboarding_manual_submitted` | MiniApp.tsx:6394 | `title_length`, `has_price` | ✅ длина, не title |
| `dont_gift_saved` | MiniApp.tsx:10215 | `presets, custom, hasComment` | ✅ `hasComment` — boolean |
| `bot.start_received` | apps/bot/src/index.ts:655 | `telegramId, hasStartParam, startParam` | ✅ deeplink-параметр, не контент |

**Вывод:** кодовая база уже дисциплинирована — везде пишутся **производные
сигналы** (длина, boolean, хэш, id), а не сырой текст. `search.*` явно
проектировался privacy-first (комментарий в `analyticsEvents.ts:202`).

Но эта дисциплина **нигде не проверяется**. Один невнимательный
`trackEvent('item_created', uid, { title })` — и контент в таблице. Именно эту
дыру закрывает фикс.

---

## 4. Решение — `sanitizeAnalyticsProps()`

Новый помощник:
[`packages/shared/src/sanitizeAnalyticsProps.ts`](../../packages/shared/src/sanitizeAnalyticsProps.ts).

```ts
sanitizeAnalyticsProps(props): Record<string, unknown> | undefined
```

Делает два дела:

1. **Выкидывает PII-ключи.** `ANALYTICS_PII_PROP_KEYS` — denylist имён
   (case-insensitive, сравнение по `key.toLowerCase()`): `title`,
   `description`, `comment*`, `hint*`, `query`/`searchText`/…, `text`, `body`,
   `message`, `note(s)`, `answerText`, `bio`, `caption`, `feedback`, `name` /
   `firstName` / `lastName` / … Значение такого ключа **не пишется вообще**
   (drop, не хэш — хэш названия желания аналитике бесполезен; если нужен
   хэшированный сигнал — он считается явно на call-site, как
   `normalizedQueryHash` в `search.routes.ts`).
2. **Truncate.** Строки > 300 символов режутся до `300 + '...'`; если весь
   объект сериализуется > 1024 символов — заменяется на `{ _truncated: true }`.
   Эта логика раньше дублировалась в 4 местах — теперь одна.

Помощник **чистая функция**, не мутирует вход, лежит в `@wishlist/shared`
(доступен API, боту и — при желании — фронту; бот не может импортировать из
`apps/api`).

### Почему denylist, а не allowlist

Allowlist ключей был бы строже, но потребовал бы перечислить **все** props
всех ~340 событий и ломал бы каждое добавление безобидного ключа. Denylist
имён контента — прагматичный баланс: ловит известные категории, а новый
контент-ключ добавляется в один `Set`. Контракт зафиксирован тестом
[`sanitizeAnalyticsProps.test.ts`](../../packages/shared/src/sanitizeAnalyticsProps.test.ts).

---

## 5. Что изменено в коде

| Файл | Изменение |
|---|---|
| `packages/shared/src/sanitizeAnalyticsProps.ts` | **новый** — помощник + `ANALYTICS_PII_PROP_KEYS` + константы лимитов |
| `packages/shared/src/index.ts` | `export * from './sanitizeAnalyticsProps'` |
| `apps/api/src/services/analytics.ts` | `trackEvent` / `trackAnalyticsEvent` / `trackProductEvent` — inline-truncate заменён на `sanitizeAnalyticsProps`; `trackEvent` теперь санитизирует и **лог-строку** (pino-файл тоже не должен нести контент) |
| `apps/api/src/routes/telemetry.routes.ts` | inline-truncate в `/tg/telemetry` заменён на `sanitizeAnalyticsProps` — граница для клиентских props |
| `apps/bot/src/analytics.ts` | `trackProductEvent` + `_rawEmit` переведены на общий помощник |
| `*.test.ts` | юнит-тесты помощника + wiring-тесты в `analytics.test.ts` и `telemetry.routes.test.ts` |

Прямые `prisma.analyticsEvent.create` в `apps/bot/src/index.ts` (#6) **не
тронуты намеренно**: они пишут только `telegramId / hasStartParam / startParam /
refCode / inviterUserId / kind` — короткие контролируемые поля без свободного
текста; протаскивать туда помощник = непропорциональный диф в 20k-строчном
файле. Зафиксировано здесь как осознанное исключение.

---

## 6. Backward compatibility

- **Имена событий и три allowlist'а не тронуты** — дашборды не ломаются.
- Сигнатуры `trackEvent` / `trackAnalyticsEvent` / `trackProductEvent` **не
  изменились** — call-sites не правятся.
- Для любого события без контент-ключей помощник **прозрачен**: все
  разрешённые props проходят как раньше (та же truncate-логика, тот же
  `{ _truncated: true }`).
- Старое событие, которое исторически могло нести контент-ключ, **по-прежнему
  персистится** — теряется только сам контент-ключ, остальные props на месте.
  Бизнес-логика не зависит от значений props (они — только для аналитики).
- Мелкое поведенческое изменение: на `/tg/telemetry` маркер переполнения был
  `{ _truncated: true, event }`, стал `{ _truncated: true }`. `event` и так
  есть в колонке `AnalyticsEvent.event` — потери нет.

---

## 7. Известные ограничения / открытые вопросы

1. **Только верхний уровень.** Помощник смотрит ключи верхнего уровня;
   вложенный объект (`{ meta: { title } }`) проходит насквозь. Props по
   соглашению плоские — не вкладывайте контент.
2. **`username` не выкидывается.** Telegram-username — идентификатор, не
   «контент»; вне scope этого аудита. Он активно используется в
   `profile_open_from_*`, `profile_subscribe`, `birthday.public_profile_opened`
   — молчаливое удаление сломало бы воронку профилей. Решение по `username` —
   **отдельный продуктовый вопрос**, не молчаливый strip.
3. **Тексты ошибок** (`checkout_failed.reason = tg.description`,
   `import.failed.reason = err.message`) — это сообщения Telegram API /
   рантайма, не пользовательский ввод; оставлены (и так обрезаны на call-site).
4. **GIN-индекс на `props`** (рекомендация `02-analytics-audit.md` § 11.3) —
   вне scope, отдельный PR.

---

## 8. Правило для новых событий

> Любой новый ключ props со свободным пользовательским текстом — **не пишется**.
> Пишите производный сигнал: длину (`titleLength`), boolean (`hasText`) или
> хэш (`normalizedQueryHash`).
>
> Если контент-ключ всё же передан в `trackEvent` / `trackAnalyticsEvent` /
> `trackProductEvent` / `/tg/telemetry` — `sanitizeAnalyticsProps` его выкинет.
> Чтобы защита сработала на ключ с новым именем — добавьте имя в
> `ANALYTICS_PII_PROP_KEYS` и обновите тест.
