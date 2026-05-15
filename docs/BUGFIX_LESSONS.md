# Bug-fix Lessons

Structured log of bug fixes — symptom + root cause, lesson, rule, better code.
New entries go at the top.

---

## 2026-05-15 — Календарь «СЕГОДНЯ»/«ЗАВТРА»: original fix пропустил третий callsite (detail-endpoint жил с багом ~2 недели после patch'а list-endpoint)

### Ошибка
В рамках Phase 1 testing-roadmap (extraction `daysUntilFromUtcMidnight` в
`services/calendar.ts` + unit-тесты) обнаружено, что fix `05df77f`
(2026-04-30) пропатчил только **один** из трёх callsite'ов в
`apps/api/src/routes/gift-notes.routes.ts`:

- `line 122` — `GET /gift-occasions` (list): ✅ исправлено в `05df77f`
- `line 241` — `GET /gift-occasions/:id` (detail): ❌ продолжало
  использовать старую формулу `(nextDate.getTime() - Date.now()) /
  (24 * 3600 * 1000)` ~2 недели после фикса
- `line 724` — soonest pick (calendar widget): ✅ исправлено в `05df77f`

Тот же баг, что был задокументирован в [BUGFIX_LESSONS 2026-04-30](#2026-04-30-—-календарь-бейдж-сегодня-вместо-завтра-вечером-накануне-события)
— просто на другом маршруте. Юзер, открывший detail-экран вечером накануне
события, видел «СЕГОДНЯ» вместо «ЗАВТРА», пока на listing-экране и в
soonest-карточке всё показывалось корректно. Это та самая «непоследовательность
внутри одной фичи», которую сложно отрепортить без специально подобранного
сценария.

### Root cause
Изначальный фикс делался поиском `Date.now()` в **одном** релевантном
файле + ручным правкой найденных мест. У `gift-notes.routes.ts` 3
callsite'а одной и той же формулы; найдены были 2 из 3 (визуально
пропущенный middle-callsite между ними).

Корень — **multi-callsite фикс без extraction**. Когда одна и та же
формула живёт в 3 местах файла, любой ручной фикс гарантирован пропустить
≥1. Lesson 2026-04-30 уже зафиксировал правило «daysUntil считается как
разница UTC-midnights», но не зафиксировал второе обязательное правило:
**если формула повторяется ≥3 раз, она выносится в helper в первом же
фиксе**, а не после второго инцидента.

### Урок
- **Multi-callsite фиксы без extraction почти всегда неполные.** Не
  «найди-и-замени» руками два-три раза подряд — extract в helper, замени все
  callsite'ы через import, тогда tsc + поиск unused имени гарантирует
  100% покрытие.
- **Test-driven discovery работает.** Этот баг проявил себя не в проде, а
  в момент написания regression-теста для уже-задокументированного класса.
  Если бы Phase 1 testing-roadmap не стартовал, баг прожил бы до
  следующего жалобу-репорта.
- **Когда формула повторяется ≥2 раза в одном файле или в ≥2 файлах
  одного app, останавливайся и выноси.** Это правило ровно про этот файл:
  `gift-notes.routes.ts` имел 3 копии identical-формулы — теперь все три
  зовут `daysUntilFromUtcMidnight(target, now)` из `services/calendar.ts`.

### Правило
- **Любая формула / магическое число, встречающаяся ≥2 раза в одном файле
  или в ≥2 файлах одного app, выносится в named helper при первом
  касании.** Не «когда будет рефакторинг» — в том же PR.
- **Bug-fix PR обязан включать grep-проверку.** Перед коммитом — `grep
  -rn` по симптомной формуле / магическому числу по всему apps/. Если
  результатов >1, фикс неполный, пока все не заменены на helper.
- **Regression-тесты для каждого lesson — обязательны** (правило из
  feedback_bugfix_lessons.md). Если бы тест существовал на L5 с
  2026-04-30, dormant-bug на line 241 проявился бы при первом запуске.

### Лучший код
```ts
// services/calendar.ts — единственный источник истины
export function daysUntilFromUtcMidnight(target: Date, now: Date): number {
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target.getTime() - todayUtcMs) / 86400_000);
}
```

```ts
// gift-notes.routes.ts — все 3 callsite'а импортируют ровно один helper
import { daysUntilFromUtcMidnight } from '../services/calendar';
// ...
const daysUntil = nextDate ? daysUntilFromUtcMidnight(nextDate, new Date()) : null;
```

### Discovery-метаданные
- Найдено: 2026-05-15 при extraction для Phase 1 testing-roadmap.
- Жил в проде: 2026-04-30 (после `05df77f`) → 2026-05-15 = ~15 дней.
- Симптом: detail-экран события показывает badge «СЕГОДНЯ» вечером
  накануне; список и soonest-карточка корректны.
- Тестов на момент исходного фикса: 0 (что и позволило dormant-bug
  прожить незамеченным).

---

## 2026-05-10 — Бот периодически говорит на английском с русскоязычным юзером (lifecycle / pro-renewal / events / birthday / subscriber notifications) — резолвер локали без персистентного фоллбэка + захардкоженный `'ru'` в части путей

### Ошибка
Юзер с Telegram RU + телефоном RU + `Язык = «Определяется автоматически»`
получает в боте странный коктейль: уведомления подписчику о новом
желании приходят по-русски, а lifecycle-сообщение «Add 2 more wishes
and your wishlist is ready to share… code WISHPRO» — внезапно по-английски.
Симптом наблюдался у `Dmitriy` 2026-05-10 в S3 lifecycle wave (touch 1,
key `wb_s3_t1_promo`). Воспроизводится у любого auto-mode юзера, который
никогда не открывал Mini App либо чьё `UserProfile.normalizedLocale` не
было прочитано на пути отправки.

### Root cause
**Архитектурный, а не точечный.** `resolveEffectiveLocale` в
`packages/shared/src/i18n.ts` поддерживал только два источника:

1. ручной `manualLanguage` (если `languageMode='manual'`)
2. live `telegramLanguageCode` из текущего HTTP-запроса (`req.tgUser.language_code`)

В **`auto`-режиме без живого запроса** (любой cron / proactive bot send)
второй источник был `undefined`, и резолвер фоллбэчил в
`normalizeLocale(undefined)` → возвращал `'en'`. То есть **все фоновые
отправки шли на английском всем auto-юзерам.**

При этом `UserProfile.normalizedLocale` уже писался middleware в
`apps/api/src/index.ts:355-377` на каждом аутентифицированном запросе
Mini App (через `persistResolvedBucket`) — но резолвер этих полей не
читал. Persisted источник существовал, но был отключён.

Дополнительные смежные дефекты, маскировавшие или усугублявшие баг:

- `apps/api/src/services/items.ts:84` — `const notifLocale: Locale = 'ru'`
  захардкожен → подписчики всегда получают сообщения по-русски,
  независимо от своей локали (английский подписчик видит «🎁 Dmitriy
  добавил(а) "X" в "Y"»). Это маскировало основной баг — RU-сообщения
  «работали», поэтому проблему долго не замечали.
- `apps/api/src/routes/items.routes.ts:846, 909, 974`,
  `apps/api/src/routes/reservations.routes.ts:954, 1239`,
  `apps/api/src/routes/comments.routes.ts:362`,
  `apps/api/src/notifications/commentNotificationQueue.ts:68` — тот же
  паттерн: `const notifLocale: Locale = 'ru'`, get-recipient → send.
- `apps/api/src/services/referral-hooks.ts:71-92` и
  `apps/bot/src/index.ts:857-870` — обходной маневр: на каждый proactive
  send звали `Telegram getChat` чтобы вытащить live `language_code` —
  лишний round-trip, который вообще не нужен, если уже есть persisted
  `normalizedLocale`. Запасной фоллбэк там же — `return 'ru'`.
- `apps/api/src/services/lifecycle.ts:54` — кнопка inline-keyboard
  `'Открыть WishBoard ✨'` захардкожена внутри `sendLifecycleDM`. Для
  не-русского сообщения шапка была локализована, кнопка — нет.

Структурно: cron-планировщики (`lifecycle`, `pro-renewal`, `events`,
`birthday-reminders`) все вызывали резолвер без второго аргумента —
байт-идентично, и все они теряли локаль одинаково. Это не одна
случайная ошибка в одной точке, а единый дизайн-промах в API
shared-резолвера, размноженный на 11+ callsite'ах.

### Урок
- **Резолвер локали обязан иметь persisted-фоллбэк.** Live request
  context — самый точный сигнал, но он есть только на синхронном пути
  (роуты Mini App). Любой cron / задержанный send / bot ticket reply /
  fanout по подписчикам резолвится **через persisted поля** профиля
  получателя, иначе вся пуш-коммуникация ломается для всех auto-юзеров.
- **Persisted-state должен быть в `LanguageSettings`-интерфейсе,
  а не в обходных хелперах.** Когда у каждого scheduler своя локальная
  логика выбора локали (referral-hooks: getChat, lifecycle: ничего,
  birthday: cast-as-LanguageSettings с игнорируемыми полями), баг
  становится 11-копий-один-и-тот-же. Единственный источник истины —
  shared `resolveLocaleWithSource(settings, telegramLanguageCode)`.
- **Захардкоженный `Locale = 'ru'` для notif-получателей — anti-pattern.**
  Каждое уведомление получает **другой** пользователь со своими
  настройками. Локаль автора запроса (`req.tgUser.language_code` инициатора)
  никак не релевантна локали получателя.
- **Логировать source локали, не только итог.** Без этого «почему бот
  заговорил на английском» — это перекапывание кода на час. С
  `localeSource: 'default_en' | 'persisted_normalized' | 'live_telegram'
  | 'manual' | 'legacy_language'` это grep на 30 секунд.

### Правило
- **Каждый новый proactive / cron / fanout send-сайт обязан**:
  1. селектить из БД `{ languageMode, manualLanguage, normalizedLocale,
     language }` для **получателя** (а не инициатора, если они разные);
  2. вызывать `resolveLocaleWithSource(settings, undefined)` (или с
     live `telegramLanguageCode` если он есть в bot ctx);
  3. логировать `{ locale, localeSource }` в строке отправки.
- **Никаких новых `const notifLocale: Locale = 'ru' | 'en'`** в
  кодовой базе. Любая такая строка — отказ от per-recipient resolution.
- **Никакого `getChat` для recovery языка.** Вся информация уже есть в
  `UserProfile` благодаря middleware, который пишет `normalizedLocale`
  на каждом аутентифицированном touch.
- **Любая inline-keyboard кнопка в bot-сообщении** должна быть в i18n,
  а её локаль — из того же резолвера, что и тело сообщения.
  Захардкоженная RU-кнопка под локализованным текстом = баг.

### Лучший код
- `packages/shared/src/i18n.ts` — `LanguageSettings` расширен полями
  `normalizedLocale?` / `legacyLanguage?`; новый
  `resolveLocaleWithSource(settings, telegramLanguageCode?) →
  { locale, source }` реализует chain manual → live → persisted_normalized
  → legacy_language → default_en. `resolveEffectiveLocale` стал тонкой
  обёрткой (обратно совместим: новые поля опциональны).
- `packages/shared/src/i18n.resolver.test.ts` — 16 unit-тестов на
  приоритеты + edge cases (manual-без-pick, unsupported normalizedLocale,
  unknown legacy code).
- Все 4 cron-планировщика (`lifecycle`, `pro-renewal`, `events`,
  `birthday-reminders`) теперь селектят полный набор полей и логируют
  `localeSource`.
- `services/items.ts` — per-recipient resolve, кнопка через i18n key
  `sub_notification_open_item_btn`.
- `services/lifecycle.ts` — `sendLifecycleDM` принимает `locale?`,
  кнопка через i18n key `lifecycle_dm_open_app_btn`.
- `services/referral-hooks.ts` — `resolveProactiveUserLocale` теперь
  тонкая обёртка над shared-резолвером, без `getChat`.
- `apps/bot/src/index.ts` — три точки в support-flow + inviter-arrival
  переведены на shared-резолвер; `getChat`-данс выкинут.
- `notifications/commentNotificationQueue.ts` — принимает
  `recipientLocale` и использует его для batch-summary, чтобы immediate
  и follow-up notif были на одном языке.
- `routes/items.routes.ts` (×3), `routes/reservations.routes.ts` (×2),
  `routes/comments.routes.ts` (×3 ветки + parent-author) — все
  переписаны на per-recipient resolve.

### Не сделано в этом фиксе (follow-ups)
Все три добитых **2026-05-11** в этой же ветке (см. дельту ниже):

- ✅ `apps/api/src/schedulers/reservations.ts` (lines 89-91, 194, 199,
  236) — добавлены 7 i18n-ключей (`notif_res_reminder_*`) × 6 локалей,
  все 4 хардкода переписаны на per-recipient resolve через
  `resolveLocaleWithSource`. Smart-res auto-release / reminder /
  reservation reminder теперь идут на языке получателя.
- ✅ `apps/api/src/services/locale.ts:20` — default-параметр `locale:
  Locale = 'ru'` удалён, параметр сделан обязательным. TS теперь
  поймает любой будущий вызов без явной локали. Все 6 callers в
  `routes/reservations.routes.ts` уже передают её — компилируется без
  правок.
- ✅ `apps/bot/src/index.ts:2477` — `deliverPendingWelcomes` теперь
  селектит полный набор полей и резолвит через
  `resolveLocaleWithSource`. Manual override уважается даже на
  welcome-пути (юзер мог открыть Mini App → выбрать manual EN, потом
  выйти и вернуться к welcome via /start).

### Дельта 2026-05-11 — закрытие 3 follow-ups
- `packages/shared/src/i18n.ts` — +7 ключей (`notif_res_reminder_header`,
  `_body`, `_body_with_price`, `_from`, `_note`, `_btn_open`,
  `_btn_purchased`) × 6 локалей.
- `apps/api/src/schedulers/reservations.ts` — все 4 send-сайта
  (reservation reminder, smart-res auto-release gifter+owner,
  smart-res reminder) теперь селектят `{ languageMode, manualLanguage,
  normalizedLocale, language }` для получателя и логируют `localeSource`.
- `apps/api/src/services/locale.ts` — `resolveUserFirstName(user,
  locale: Locale)` без default; контракт явный, ошибки контракта ловит TS.
- `apps/bot/src/index.ts` — `deliverPendingWelcomes` через
  `resolveLocaleWithSource`, лог содержит `localeSource`.

### Известные оставшиеся (другие классы багов, не закрыты в этой ветке)
- `apps/api/src/schedulers/reservations.ts:206` —
  `t('api_system_auto_released', 'ru')` пишется в `Comment.text`
  столбец БД. Это **stored** локализация, не ephemeral notification:
  одна запись показывается всем зрителям независимо от их локали.
  Чтобы починить — хранить `i18nKey + params` в Comment-row и
  переводить на render. Бóльший рефактор; вне scope.
- `apps/web/app/miniapp/MiniApp.tsx:210` — `fmtPrice` default
  'ru'. Frontend-форматтер, не часть пуш-коммуникации; Mini App
  держит локаль в React state и переопределяет на каждом вызове.
  Низкорисково, оставить как есть.
- `apps/bot/src/index.ts:2331-2333` — `setMyCommands` подаёт описание
  команд бота **только на одном языке**. Telegram поддерживает
  `setMyCommands` с `language_code` параметром (отдельные списки на
  ru / en / etc). Это feature-добавление, а не баг-фикс резолвера —
  отдельная задача.
- `apps/api/src/lib/locale.ts:10` — `getRequestLocale(req)` использует
  только `req.tgUser?.language_code` через `detectLocale`, не уважает
  manual override. Пользователь с `manual='en'` и Telegram `ru` получит
  RU на синхронных API-ответах вопреки своему явному выбору. На
  proactive путях (cron / fanout / bot proactive sends) это уже починено
  через `resolveLocaleWithSource`, но синхронный путь остаётся
  непоследовательным: `me.routes.ts:934/1137` использует полный chain,
  все остальные роуты — старый `getRequestLocale`. Чтобы починить —
  переписать `getRequestLocale` как обёртку, которая дотягивает
  профиль из БД (один extra query per request) или прокидывает
  middleware-собранный профиль в `req.tgUserProfile`. Отдельная задача;
  blast radius — все синхронные API-ответы.
- `apps/api/src/schedulers/events.ts:73-110` — title/body event-reminder
  строки остались inline в `switch (locale)` для 6 локалей (~36
  языко-зависимых литералов). Кнопка перенесена в `notif_res_reminder_btn_open`
  в Round 3, title/body — нет. Все 6 локалей покрыты функционально
  (никто не получает чужой язык), но архитектурно — anti-pattern
  относительно других proactive сайтов. Follow-up: 6 i18n-ключей с
  `{{title}}`/`{{days}}` плейсхолдерами × 6 локалей.

### Round 2 (2026-05-11) — закрытие code-review feedback (7.5 → 9+/10)
Code-review subagent дал 7.5/10 с пятью should-fix замечаниями + nits.
Закрыто в той же ветке:

- ✅ **Helper `profileToLanguageSettings` + `LocaleProfileSlice` type** в
  `packages/shared/src/i18n.ts`. Лифтит Prisma-`UserProfile` slice в
  `LanguageSettings`-shape. Re-exported из `apps/api/src/services/locale.ts`
  для consistency. Заменил 14 повторяющихся inline-объектов на
  `resolveLocaleWithSource(profileToLanguageSettings(X.profile))` —
  ~150 строк убрано, плюс `as any` cast'ы централизованы.
- ✅ **Defensive guard на manualLanguage**: добавлен `isSupportedLocale`
  check в manual-ветке резолвера. Если dirty data ('pt-BR' и т.п.)
  попадёт в `manualLanguage`, резолвер не упадёт в `t()` — провалится
  на следующий signal. Тест `falls through when manualLanguage is dirty`
  добавлен.
- ✅ **`apps/api/src/routes/group-gifts.routes.ts` × 3 hardcoded RU**:
  добавлены 3 i18n keys (`notif_group_gift_joined`, `_completed`,
  `_cancelled`) × 6 локалей; все 3 send-сайта (organizer-on-join,
  participants-on-complete, participants-on-cancel) переписаны на
  per-recipient resolve.
- ✅ **`apps/bot/src/index.ts:1812` hint fanout**: `Locale = 'en'` убран,
  recipient теперь резолвится через профиль, fallback `'en'` —
  legitimate cold-start.
- ✅ **`apps/api/src/routes/internal.routes.ts:343`** — recovery
  notification: priority = current resolver chain → snapshot
  `MaintenanceExposure.locale` → 'en'. Снапшот используется только когда
  юзер cold-start (default_en); иначе текущая локаль приоритетнее.
- ✅ **`sendLifecycleDM` локаль обязательна**: dropped optional default;
  параметр перемещён в `(chatId, text, locale, webAppUrl?)` чтобы
  required-required-required-optional порядок был естественный. TS
  поймает регрессии.
- ✅ **`commentNotificationQueue` плюрали → i18n**: 6 hardcoded
  `*_COMMENT_FORMS` массивов выкинуты, добавлены 3 keys
  (`notif_batch_comments_word_one/few/many`) × 6 локалей. Локализация
  теперь полностью в dict, никакой TS-side утечки.
- ✅ **`birthday-reminders` restructure**: `as LanguageSettings` cast
  с лишними полями убран; теперь идёт через канонический
  `profileToLanguageSettings(...)` — код читается одинаково с 13
  другими callsites.
- ✅ **Hindi reservation reminder header** заменён на безопасный
  loanword `आरक्षण रिमाइंडर` (от диалектной формы `याद दिलावन`).
- ✅ **Meta-test покрытия ключей**: новый блок в `i18n.resolver.test.ts`,
  который итерирует по 15 локали-фикс ключам × 6 локалям и проверяет,
  что `t()` возвращает не-пустую строку, отличную от raw key. Ловит
  drift при добавлении новой локали или удалении ключа.
- ✅ **`isSupportedLocale` exported** — теперь публичный, используется
  в `internal.routes.ts` для валидации snapshot-локали.

Не сделано (nit / out of scope):
- `apps/api/src/lib/locale.ts:10` `getRequestLocale` — добавлено в
  follow-up список выше.
- Hindi/Arabic переводы новых ключей — не верифицированы native speakers.
  Текущие — best-effort. При жалобе от пользователя — поправить.

### Round 3 (2026-05-15) — закрытие code-review iter 2 (8/10)
Свежий sub-agent ревью на ту же ветку нашёл один MAJOR + минорные.
Закрыто:

- ✅ **`apps/api/src/services/santa-season.ts:325-360`** — broadcast
  пайплайн перестал слать `textRu + textEn` блобом всем юзерам
  (zh-CN/hi/es/ar получали два чужих языка одновременно).
  Per-recipient resolve через
  `resolveLocaleWithSource(profileToLanguageSettings(...))`; добавлены
  ключи `santa_broadcast_promo` и `santa_broadcast_closing_soon` × 6
  локалей. Триггерится Nov 1 PROMO / Feb 1 CLOSING_SOON — не активен
  прямо сейчас (следующий запуск Nov 1, 2026), починен превентивно
  пока контекст свежий.
- ✅ **`apps/api/src/schedulers/events.ts:118`** — bilingual button
  `locale === 'ru' ? '📱 Открыть' : 'Open'` заменён на
  `t('notif_res_reminder_btn_open', locale)` (переиспользует
  существующий 6-локальный ключ). zh-CN/hi/es/ar теперь получают
  кнопку на своём языке. Inline title/body switches остались —
  scope-deferred, см. «Известные оставшиеся».
- ✅ **`apps/api/src/schedulers/birthday-reminders.ts:990-995`** —
  схлопнут dead `if (isOwner) { fetch X } else { fetch X }` с
  byte-identical selects на единичный fetch. Privacy / opt-out
  branching ниже не меняется.
- ✅ **`apps/api/src/schedulers/pro-renewal.ts:88-94`** — `dateFmtLocale`
  расширен с `ru | en-US` до маппинга все 6 локалей (`ru-RU | zh-CN |
  hi-IN | es-ES | ar | en-US`). Дата в pro-renewal reminder теперь в
  локали получателя.
- ✅ **Defensive test на empty-string `manualLanguage`** добавлен в
  `i18n.resolver.test.ts` — закрывает оставшийся dirty-data класс
  (раньше покрывался только `'pt-BR'` тестом).
- ✅ **`packages/shared/src/i18n.ts:166` cast-safety комментарий**
  переписан точнее: не "auto path", а «any non-'manual' value falls
  through identically» — отражает реальную семантику резолвера.
- ✅ **`apps/api/src/schedulers/reservations.ts:199-204` SYSTEM-комментарий**
  обновлён: убрана претензия на «project canonical persisted-text
  locale» (формальной политики нет) — заменено на «match existing
  SYSTEM comments in this table».

Отклонено (с обоснованием):
- ❌ **MINOR: `group-gifts.routes.ts` localeSource не логируется.** Все
  роуты (items / comments / reservations / internal / me) тоже не
  логируют `source` — это консистентный паттерн для роутов (request-id
  + trackEvent дают diagnostics). Source capture — паттерн scheduler'ов,
  где нет request-id. Group-gifts матчит роут-паттерн.
- ❌ **NIT: uppercase `manualLanguage` тест** — поведенчески уже
  покрыт `'pt-BR'` тестом (оба фейлят `isSupportedLocale`); добавлять
  второй тест с тем же эффектом — duplication.

### Acceptance — после деплоя
- Юзер с Telegram RU + auto-mode получает RU lifecycle / promo /
  reminder / pro-renewal / event / birthday сообщения.
- Юзер с manual=English получает EN даже при Telegram RU.
- Юзер с manual=Russian получает RU даже при Telegram EN.
- Подписчики получают уведомления на **своём** языке, не на языке
  владельца вишлиста.
- В логах видно `localeSource` для каждой proactive отправки.
- Если `localeSource` массово = `default_en` для существующих юзеров,
  это означает что middleware-захват `normalizedLocale` где-то отвалился —
  алерт.

---

## 2026-05-08 — Bulk-select bottom bar: «каша из кнопок» (translucent token на fixed-position баре + сетка не подогнана под кол-во кнопок)

### Ошибка
Пользователь жмёт «Выбрать несколько» в вишлисте → внизу появляется
панель с действиями (Удалить / В архив / Перенести / Копировать /
Выберите категорию / Часть вишлиста), но визуально это выглядит как
каша: кнопки разной ширины, прыгают на третью строку, наезжают на
карточки желаний и счётчик «N из M желаний», поверх ещё торчит
floating «+» FAB. Не понятно, что нажимать.

### Root cause
Два независимых дефекта в одной области:

1. **Сетка не была подогнана под актуальное количество кнопок.**
   `gridTemplateColumns` второй строки = `'1fr 1fr'`, но кнопок там 3
   (Copy / ChooseCategory / Curated) — третья сваливалась на третью
   строку и занимала ровно половину ширины. Без категорий первая
   строка `'1fr 1fr 1fr 1fr'` (4 колонки) принимала 5 кнопок — пятая
   тоже сваливалась вниз на 1/4 ширины. Когда добавляли кнопку
   `curated_bulk_btn` в коммите `f0c5dac` (апрель), сетку забыли
   обновить.

2. **Контейнер бара использовал `C.surface` как `background`.**
   `C.surface` = `var(--wb-surface, rgba(255,255,255,0.035))` — это
   elevation-токен, ~3.5–4% white поверх `bg`. Для карточек он
   создаёт subtle-lift, но для **fixed-position bottom bar** даёт
   почти прозрачный фон: items, FAB и счётчик «29 из 70 желаний»
   просвечивают сквозь панель. Соседний curated-selection bar
   использует `C.bg` (solid `#0F0F12`) — правильный паттерн уже
   существовал в файле, просто bulk-bar его не использовал.

3. **FAB не скрывался во время bulk/curated режимов.** Условия
   рендера FAB (`!itemReorderMode && !catReorderMode && !showItemForm
   && !keyboardOpen`) не включали selection-режимы. FAB при
   `zIndex: 50` и баре при `zIndex: 60` — формально был перекрыт, но
   из-за прозрачного фона бара виден. Семантически тоже неправильно:
   «добавить новое желание» в режиме выбора уже существующих не имеет
   смысла.

### Урок
- **Translucent токены — для elevation, не для occlusion.** Любой
  `position: fixed` контейнер, который должен скрывать прокручиваемый
  контент под собой, MUST использовать **solid** background-токен
  (`C.bg` / `C.card`), не `C.surface` / `C.surfaceHover`. Это видно
  сразу при тестировании на длинном списке — но если тестируешь на
  пустом, баг не проявляется.
- **Когда добавляешь кнопку в существующую grid — всегда проверяй
  `gridTemplateColumns`.** В CSS Grid лишняя кнопка молча wraps на
  следующую строку и занимает column-fraction ширины родителя, что
  визуально выглядит «как-то почти ок» в превью на десктопе.
- **Selection-режимы должны отключать FAB и любые add-actions.**
  Любой mode, где пользователь выбирает существующие сущности, скрывает
  CTA на создание новых: иначе click-conflict, потеря состояния выбора
  при переходе на форму, или просто визуальная каша.
- **Один скриншот может содержать два разных бага.** Первый раунд
  фикса исправил только сетку — пользователь прислал тот же скриншот:
  «баг на месте». Второй раунд нашёл прозрачность. Урок: при
  визуальных багах нужно перечислить все аномалии (overlap, размеры,
  прозрачность, z-order), а не лечить первое заметное.

### Правило
- **Любой fixed bottom bar / sheet header / persistent overlay** =
  solid фон. Грепать `position: 'fixed'` + `background: C.surface` в
  кодовой базе и заводить follow-up на каждое попадание (текущие
  кандидаты: Santa exit-request sheet at `MiniApp.tsx:28149` —
  смягчён затемняющим overlay, но pattern неправильный).
- **При добавлении новой кнопки в bulk/action bar** — проверить
  все ветки `gridTemplateColumns` в обоих case'ах (`hasUserCategories`
  true/false и любые другие условные ветки), что число колонок
  соответствует числу детей.
- **При вводе нового selection mode** (curated, bulk, multi-pick) —
  добавить флаг в условие рендера FAB и любых других CTA на создание.

### Лучший код
- `apps/web/app/miniapp/MiniApp.tsx` — bulk action bar:
  - `background: C.surface` → `background: C.bg` (precedent взят у
    curated-selection bar 95 строк ниже).
  - `gridTemplateColumns` второй строки: `'1fr 1fr'` → ternary
    `hasUserCategories ? '1fr 1fr 1fr' : '1fr 1fr'`. Сетка теперь
    автоматически совпадает с числом детей в каждой ветке.
  - Кнопка `ChooseCategory` рендерится между Copy и Curated через
    `{hasUserCategories && <button>...</button>}` — порядок Copy →
    ChooseCategory → Curated читается как «копия в другую вишку →
    тег в текущей → внешний share», логичная последовательность.
- `apps/web/app/miniapp/MiniApp.tsx` — Add-Wish FAB условие
  расширено: `!bulkSelectionMode && !curatedSelectionMode`.
  Старый z-order (FAB z:50, bar z:60) больше не load-bearing —
  семантически чище и устойчиво к будущим z-index изменениям.

```jsx
// ❌ До: 3 кнопки в 2-колоночную сетку → перенос на 3-ю строку 1/2 ширины
<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
  <Copy /> <ChooseCategory /> <Curated />
</div>

// ✅ После: число колонок матчит число детей в каждой ветке
<div style={{ display: 'grid',
  gridTemplateColumns: hasUserCategories ? '1fr 1fr 1fr' : '1fr 1fr' }}>
  <Copy />
  {hasUserCategories && <ChooseCategory />}
  <Curated />
</div>
```

```jsx
// ❌ До: translucent elevation token для fixed bottom bar
<div style={{
  position: 'fixed', bottom: '76px', zIndex: 60,
  background: C.surface, // rgba(255,255,255,0.035) — items видны сквозь
}}>...</div>

// ✅ После: solid bg-токен (соседний curated-bar так и делает)
<div style={{
  position: 'fixed', bottom: '76px', zIndex: 60,
  background: C.bg, // #0F0F12 solid — полностью перекрывает контент
}}>...</div>
```

```jsx
// ❌ До: FAB рендерится во время selection mode → перекрывает action bar
{!keyboardOpen && <FAB />}

// ✅ После: selection-режимы отключают add-actions
{!keyboardOpen && !bulkSelectionMode && !curatedSelectionMode && <FAB />}
```

**Commit:** `7cfc983` — fix(miniapp): opaque bulk action bar + hide FAB during selection modes
**Предыдущая попытка:** `f98c247` (только сетка, прозрачность не заметил — урок: визуальные баги требуют перечисления всех аномалий)

### Follow-up — последний item обрезан баром (не было «воздуха»)

После того как бар стал непрозрачным, выяснилось, что последний item
вишлиста наполовину прячется за ним: контейнер вишлист-детейла имел
`paddingBottom: 'calc(90px + safe-area)'` — этого достаточно только для
floating bottom-nav (~52 + 14 offset + 24 breathing). Bulk-bar на 76 px
выше нижнего края + ~115 px высоты = верхний край бара в ~190 px от
низа, и последний item «уезжал» под бар.

**Урок:** любой fixed-position бар, который показывается поверх
скроллируемого контента, должен **парно** с собой увеличивать
`padding-bottom` контента, чтобы последний элемент был доскроллим.
Иначе пользователь физически не может его увидеть, не выйдя из режима.
Проверка: бар активен → последний item в списке → между низом
карточки и верхом бара должно быть ≥16 px воздуха.

**Правило:** при добавлении нового persistent overlay (selection-bar,
sticky CTA, etc.) — закрепить пару (overlay-условие) ↔ (доп.
padding-bottom условие в скролл-контейнере) сразу же, не отдельным
коммитом.

**Лучший код:** `padding-bottom` на wishlist-detail контейнере стал
тернарным: `bulkSelectionMode ? 210px : curatedSelectionMode ? 110px :
90px` (всё + safe-area). 210 = 76 (offset бара) + 116 (высота 2-row
бара) + ~18 breathing. 110 = 70 (curated single-row) + ~40 breathing.

**Commit:** `<this commit>` — fix(miniapp): scroll padding when bulk/curated bar active

---

## 2026-05-08 — Item images: открытие вишлиста на 28 желаний грузит ~28 картинок параллельно по мегабайту с внешних CDN

### Ошибка
Пользователь открывает свой вишлист → карточки желаний рендерятся, но
вместо превью товаров в течение 5–15 секунд видны emoji-плейсхолдеры
(😍 / 🎁), потом постепенно начинают появляться картинки. На скриншотах
все 28 строк списка имели placeholder-emoji в момент captura. Эффект
особенно заметен на медленной мобильной сети.

### Root cause
Три фактора накладываются друг на друга, каждый по отдельности
терпимый, вместе — деградация:

1. **`imageUrl` хранится как сырой external CDN URL.** `url-import.ts`
   парсил marketplace-страницу через `parseUrl`, доставал `imageUrl`
   (типично `https://avatars.mds.yandex.net/get-mpic/.../orig`,
   `https://cdn-img.ozone.ru/...`, `https://images.wbstatic.net/...`)
   и сохранял **строкой как есть** в `Item.imageUrl`. Никакого
   download'а / sharp / локального кеша. Mini App ходит за каждой
   картинкой к чужому CDN.
2. **Тащим original-resolution для 88-px thumbnail'а.** Yandex `/orig`
   суффикс = полноразмерный JPG, типично 1–3 МБ. Карточка в списке —
   88×110 px. Перерасход трафика ~30×.
3. **`<img>` без lazy/decoding hints.** В `MiniApp.tsx` 19 мест с
   `<img src={item.imageUrl}>` — ни `loading="lazy"`, ни
   `decoding="async"`, ни `next/image`, ни IntersectionObserver. На
   списке из 28 желаний браузер открывает 28 параллельных fetch к
   внешним CDN при первой отрисовке, конкурируя за коннект и main
   thread (декодинг блокирует UI).

Geo-latency добавляет финальный гвоздь: API/Mini App теперь хостятся в
Амстердаме (Vultr, после переезда 2026-05-03), пользователи — в РФ.
Yandex/WB CDN отдают быстро для российского трафика, но через
европейский TLS-handshake в один поток на 28 хостов это секунды
ожидания.

В БД на момент аудита: 78 items с remote `http%` imageUrl против 31
local `/api/uploads/%`. 70 % товарных карточек ходили в чужой CDN.

### Урок
1. **External CDN — не source of truth для контента, который критичен
   для UX.** Картинка товара = главный визуальный якорь карточки. Если
   она грузится 5+ секунд, пользователь видит «приложение тормозит»,
   а не «Yandex медленно отдаёт». Переносим в свой `/uploads/`.
2. **Производительность списков — N-of-M проблема.** На каждом item —
   свой сетевой запрос. Любая мелкая медлительность (500 ms × 28 =
   14 секунд wall-clock'а с учётом конкуренции) превращается в
   ощущаемую деградацию. `loading="lazy"` — практически бесплатный
   instrument: браузер сам решает, что грузить, а что отложить до
   скролла.
3. **Уже существующая инфра должна переиспользоваться.** Sharp pipeline
   (`apps/api/src/uploads/imageProcessor.ts`) был написан для
   ручных загрузок 6 месяцев назад. URL-импорт о нём не знал и качал
   как мог. Цена «протянуть вызов в новый flow» — 30 строк кода;
   цена «не протянуть» — 6 месяцев деградации UX.
4. **SSRF guard уже написан и оттестирован** в `url-parser.ts`
   (`validateUrl` + `assertDnsIsSafe`, покрытие в
   `security-ssrf.test.ts`). Любой новый код, который дёргает remote
   URL по пользовательским данным, обязан переиспользовать этих двух
   helper'ов, а не выкатывать «пока без guard, потом починим».

### Правило
- **Списочные `<img>`** (всё, что выводится в списке/гриде, а не на
  отдельной странице товара) MUST иметь `loading="lazy"
  decoding="async"`. Без исключений.
- **Любой `imageUrl`, полученный из external источника** (URL parser,
  Telegram file API, scraper) MUST пройти через
  `downloadAndProcessImage` перед сохранением в `Item.imageUrl`.
  Failure ⇒ fall back на remote URL (лучше, чем потерять картинку
  совсем), но primary path = local.
- **Любой server-side `fetch(url)` по пользовательскому URL** MUST
  пройти `validateUrl` + `assertDnsIsSafe` перед запросом. Reject
  редиректы или revalidate их повторно (см. `fetchHtml` в
  `url-parser.ts` для эталонной реализации).

### Лучший код
- `apps/api/src/uploads/imageProcessor.ts` — добавлен
  `downloadAndProcessImage(url, opts)`: validateUrl → assertDnsIsSafe
  → fetch с 8 s timeout, manual redirect (reject 3xx), 15 MB cap,
  content-type guard `image/*` → существующий `processImage`
  (resize 1600 / mozjpeg q80, EXIF strip).
- `apps/api/src/services/url-import.ts` — после `parseUrl` и до
  `prisma.item.create` пытаемся скачать; ошибка логируется как
  `url_import.image_cache_failed` и не валит импорт (fall back на
  remote URL).
- `apps/web/app/miniapp/MiniApp.tsx` — 19 мест с `<img>` для item
  фотографий получили `loading="lazy" decoding="async"`. Для модальных
  full-screen viewer'ов — только `decoding="async"` (открываются по
  явному клику, lazy-load бессмыслен).
- `apps/api/src/scripts/backfill-item-images.ts` — one-shot
  бэкфилл для 78 legacy items. Concurrency 3 (вежливо к чужим CDN),
  поддержка `--dry-run` и `--limit N`. Прогон на проде:
  77 downloaded / 1 skipped (мёртвый t.me 404) / 0 failed.

После прогона: распределение `Item.imageUrl` сменилось с
31 local / 78 remote / 83 null / 39 other → 109 local / 1 remote / 83
null / 39 other. Объём `/data/uploads/` вырос с ~1 MB до 12 MB
(167 файлов) — приемлемо.

Commit: `f98c247`.

---

## 2026-05-03 — Hints: «Активный намёк не найден» при свежем клике (idempotency-window mismatch + сетевая стена маскировала логический баг недели)

### Ошибка
Пользователь жмёт «Намекнуть друзьям» в Mini App → бот получает клавиатуру выбора
контактов → пользователь выбирает контакт → бот отвечает «**Активный намёк не
найден. Создай новый в приложении.**» И так несколько попыток подряд, повторно
воспроизводимо.

В БД на момент попытки виден последний `Hint` с `status='SENT'` от **этого же
пользователя на тот же item**, но `createdAt` 10 часов назад. Свежего hint
после клика нет. API при этом отвечает Mini App'у `200 OK` с `hintId`.

### Root cause
**Расхождение «окон» между двумя сервисами**, читающими общий стейт через БД:

- **API** (`apps/api/src/index.ts`, idempotent fast-path в `POST /tg/items/:id/hint`)
  искал существующий hint по условию `status='SENT' AND expiresAt > now()`.
  `expiresAt` ставится `now() + 30 дней` при создании → effectively окно
  идемпотентности **30 дней**. На повторный клик API возвращал тот же 10-часовой
  `hintId` и заново слал клавиатуру.
- **Бот** (`apps/bot/src/index.ts`, обработчик `users_shared`) ищет hint по
  условию `senderUserId=X AND status='SENT' AND createdAt >= now() - 30 минут`,
  чтобы не подцепить случайный древний абандон. Окно — **30 минут**.

Когда юзер кликал, абандонив, и возвращался через несколько часов, API возвращал
старый зомби-hint, бот его не находил в своём окне → отвечал «Активный намёк не
найден». Контракт между двумя сервисами расходился на 3 порядка (30 мин vs 30
дней).

**Почему этот баг прожил недели в проде, прежде чем мы его опознали:**
параллельно работала **сетевая стена** Timeweb-VPS → Telegram (RKN-блок IPv4 +
deprecated upstream IPv6). Каждая попытка hint-flow в проде превращалась в
`fetch failed: Connect Timeout Error` либо на API-side (отправка клавиатуры),
либо на bot-side (recipient sendMessage). Все наши «фиксы» в течение нескольких
сессий — добавление retry с timeout, atomic-claim против дубликатов
`users_shared`, idempotent fast-path, fire-and-forget keyboard delivery,
структурные логи — били по симптомам, которые вызывал сетевой шум. Логический
баг с window-mismatch был **полностью замаскирован**: оба сервиса не доходили
до своих query настолько часто, что мы не различали «не нашёл из-за окна» от
«не дошёл из-за сети». Только после переезда инфры на Vultr Amsterdam (TG
reach ~30 ms) сетевая дисперсия исчезла и баг стал воспроизводиться 1-в-1.

### Урок
1. **Контракт «producer создаёт состояние / consumer ищет это состояние через
   БД-очередь» обязан явно совпадать по lookup-критериям с обеих сторон.** Если
   consumer ограничивает окно по `createdAt >= now() - X`, producer не имеет
   права через идемпотентность переиспользовать запись старше X. Несовпадение
   окон = race-условие, которое выглядит как «всё хорошо, кроме бага».
2. **Сетевая нестабильность маскирует логические баги.** Когда из 100 попыток
   30 % падает «по сети», у диагноста нет статистической базы отделить «упало
   потому что логика кривая» от «упало потому что сеть лежит». Любой код-фикс
   в этих условиях — догадка. Наши 5+ итераций hint-fixes (`491a2ba` /
   `6c4de80` / `dc5a0af` / `91a1c22` / `fa0b52d`) лечили реальные мелкие
   проблемы по дороге, но не корень — корень был не в коде, а в контракте,
   который сеть скрывала.
3. **`expiresAt` ≠ окно идемпотентности.** Поле «срок жизни» в БД — это
   garbage-collection / архивация, а не семантика «когда переиспользовать».
   Идемпотентность строится отдельным узким окном, согласованным с consumer'ом.
4. **Stale записи блокируют rate-limit slots.** Анти-спам hints (3/item за 30
   дней, 5/sender за 24 ч) считал `status IN ('SENT', 'DELIVERED')`. Каждый
   абандонный SENT, оставленный навсегда, занимал слот. На момент починки в
   проде висело 8 stale-SENT с марта-мая, реально блокирующих item-rate-limit
   для пользователя, который их даже не помнил.

### Правило
1. **Pair-test producer/consumer, если они синхронизируются через БД-очередь.**
   Минимум — `grep`-чек в обоих файлах при ревью PR'а, который меняет хотя бы
   одну сторону: lookup-where в consumer должен покрывать все записи, которые
   producer считает «свежими/активными».
2. **Любое окно идемпотентности дублируется константой с одинаковым именем в
   обоих файлах** (`HINT_LOOKUP_WINDOW_MS = 30 * 60 * 1000`), либо выносится
   в общий `packages/shared`. Магических чисел в `findFirst` запрещены — они
   незаметно расходятся.
3. **Stale-state cleanup должен быть proactive, не reactive.** Записи,
   выпавшие из «свежего окна», переводятся в `CANCELLED` при следующем
   клике/запросе того же пользователя — не «когда-нибудь по cron». Иначе они
   копятся и блокируют rate-limits.
4. **Перед мульти-сессионным циклом фиксов одной фичи в проде с сетевыми
   ошибками — стабилизировать сеть.** Если в логах доминирует
   `fetch failed: Connect Timeout`, любой код-фикс симптома будет угадыванием.
   Диагноз сначала, фикс потом.

### Лучший код
```ts
// apps/api/src/index.ts — POST /tg/items/:id/hint, fast-path:
const now = new Date();
// MUST stay in sync with apps/bot/src/index.ts users_shared handler.
const HINT_LOOKUP_WINDOW_MS = 30 * 60 * 1000;
const lookupWindowStart = new Date(now.getTime() - HINT_LOOKUP_WINDOW_MS);

// 1. Proactive stale cleanup: anything outside the consumer's window is dead.
const stale = await prisma.hint.updateMany({
  where: {
    senderUserId: user.id,
    itemId: id,
    status: 'SENT',
    createdAt: { lt: lookupWindowStart },
  },
  data: { status: 'CANCELLED' },
});
if (stale.count > 0) {
  logger.info({ userId: user.id, itemId: id, cancelledCount: stale.count },
    'hint_create_cancelled_stale_sent');
}

// 2. Idempotency over the SAME window the bot uses.
const existing = await prisma.hint.findFirst({
  where: {
    senderUserId: user.id,
    itemId: id,
    status: 'SENT',
    createdAt: { gte: lookupWindowStart },  // ← must match consumer
    expiresAt: { gt: now },                  // ← belt-and-braces
  },
  orderBy: { createdAt: 'desc' },
  select: { id: true, createdAt: true },
});
```

```ts
// apps/bot/src/index.ts — users_shared handler:
const HINT_LOOKUP_WINDOW_MS = 30 * 60 * 1000;
// MUST stay in sync with apps/api/src/index.ts hint create handler.
const thirtyMinAgo = new Date(Date.now() - HINT_LOOKUP_WINDOW_MS);

const hint = await prisma.hint.findFirst({
  where: {
    senderUserId: sender.id,
    status: 'SENT',
    createdAt: { gte: thirtyMinAgo },        // ← matches producer
  },
  orderBy: { createdAt: 'desc' },
  ...
});
```

**Commits:**
- `6574323` fix(hints): cancel stale SENT hints + match bot's 30-min lookup window
- (network unmasking) infra migration to Vultr Amsterdam — `0e7a9f6` and follow-ups

---

## 2026-04-30 — Календарь: бейдж «СЕГОДНЯ» вместо «ЗАВТРА» вечером накануне события

### Ошибка
В Mini App, экран события календаря (1 мая, повторение «каждый год»),
запрошенный 30 апреля около 18:14 по GMT+3, показывал бейдж **«СЕГОДНЯ»**
и подпись `1 Май · Пт`. При этом таймер обратного отсчёта работал
корректно: `08 ч 45 мин 42 сек` — то есть до события действительно
оставалось < 9 часов и оно было *завтра*, а не сегодня.

Тот же баг затронул выбор «ближайшего события» в hero-карточке —
завтрашнее событие могло отображаться как «сегодняшнее».

### Root cause
В двух местах `apps/api/src/index.ts` `daysUntil` считался как:

```ts
Math.round((nextDate.getTime() - Date.now()) / (24 * 3600 * 1000))
```

`nextDate` всегда нормализована к **полуночи UTC** (она строится через
`Date.UTC(y, m-1, d)` в `getNextOccurrenceDate`). Но `Date.now()` —
текущий timestamp, включающий время суток.

Сценарий: сейчас 30 апреля 15:14 UTC, событие — 1 мая 00:00 UTC.
Разница = ~8.75 часов = `0.365` дня. `Math.round(0.365) = 0` →
`daysUntil = 0` → клиент рендерит бейдж «СЕГОДНЯ».

Фронт корректен: он переводит `daysUntil === 0` → «сегодня`,
`daysUntil === 1` → «завтра». Источник кривой даты — сервер.

### Урок
- **Календарные дни — это разница ДАТ, а не разница миллисекунд / 86 400 000.**
  Когда одна сторона уже нормализована к полуночи, а вторая — нет,
  `Math.round`/`Math.floor`/`Math.ceil` дадут off-by-one в зависимости
  от времени суток. Любое из округлений будет неверно для какой-то
  части дня.
- **Таймер и бейдж разошлись, потому что считались по-разному.** Таймер
  работает в реальных миллисекундах (это правильно для countdown'а), а
  бейдж должен работать в календарных днях (а считал в миллисекундах).
  Расхождение в принципе расчёта = расхождение в выводе.

### Правило
- Для «через сколько дней» **обе стороны нормализуются к полуночи в
  одной и той же тайм-зоне** (UTC, раз сервер UTC), затем `(b - a) / 86400000`
  даёт целое число дней без округления.
- Если в одной фиче есть и countdown-таймер (часы/минуты/секунды), и
  «дни до» (бейдж/подпись) — это **два разных расчёта** с разной
  семантикой. Не пытаться вывести «дни» из того же значения, что и
  таймер.

### Лучший код
```ts
// apps/api/src/index.ts — везде, где считается daysUntil от nextDate
const now = new Date();
const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const daysUntil = Math.round((nextDate.getTime() - todayUtcMs) / (24 * 3600 * 1000));
```

`nextDate` уже на полуночи UTC → разница всегда кратна 86 400 000 →
`Math.round` тут страховочный, реально результат — целое число.

---

## 2026-04-30 — Фото идеи к событию календаря не загружается + каретка уезжает в поле цены

### Ошибка
1. **Фото исчезает.** В календаре, при добавлении идеи к событию с
   прикреплённым фото, серверная idea создавалась без `imageUrl`.
   Тост-ошибки нет, фронт молча пропускает. Корень — в
   `tgFetch` (`apps/web/app/miniapp/MiniApp.tsx`): он жёстко выставлял
   `'Content-Type': 'application/json'` для **всех** запросов, включая
   те, где `body` это `FormData`. Браузер не может выставить
   `multipart/form-data; boundary=...` поверх явно заданного Content-Type,
   поэтому multer на сервере получал тело как JSON и не видел поля
   `photo`. Запрос проходил с 200, фото никуда не сохранялось.

2. **Каретка уезжает (вертикально внутри инпута).** В форме «Добавить
   идею», при тапе на инпут «цена», мигающая каретка отрисовывалась
   значительно ниже видимой границы инпута (~50 px вниз, в зазоре между
   price-row и upload-кнопкой). Текст «70000» при этом был на своём
   месте.
   
   **Первая попытка фикса (мимо):** добавили `onFocus → scrollIntoView`,
   как у соседнего text-инпута. Это не помогло — пользователь
   подтвердил баг на проде после деплоя. Гипотеза «WebView не
   пересчитывает caret после открытия клавиатуры» была ошибочной:
   text-инпут работал не потому, что у него был scroll-handler, а
   потому что ему хватало intrinsic line-height. Эти две вещи мы
   связали по корреляции, не по причинно-следственной связи.
   
   **Настоящий root cause:** в WebKit (iOS WKWebView, Telegram) если у
   `<input>` **нет явного `line-height`**, движок вычисляет caret-rect
   из font ascent/descent и метрик контейнера. В `display: flex`
   контейнере с растянутым по высоте инпутом этот расчёт даёт
   смещённый вниз caret. Текст рисуется по `padding`, а каретка —
   по неправильно посчитанной baseline. Эффект: caret «вылезает»
   за нижнюю границу инпута.
   
   В коде MiniApp.tsx строка 797-798 уже есть комментарий **прямым
   текстом**: `"Explicit lineHeight is required — without it, ...
   WebKit caret to render displaced vertically in focused inputs"`.
   Каноничный `inputStyle` имеет `lineHeight: '22px'` именно по этой
   причине. Календарная форма была построена inline, без использования
   канона, и `lineHeight` не выставлен ни на одном из 4 инпутов.
   Проявилось только на цене из-за `flex: 2` контейнера.

**Root cause:**
- Bug 1 (фото): «глобальный default-header» в обёртке fetch без
  проверки типа body. Эта ошибка системная — каждый будущий
  multipart-загрузчик через `tgFetch` сломался бы тем же способом.
- Bug 2 (каретка): inline-стили инпутов вместо использования
  каноничного `inputStyle`. В каноне есть defensive свойства
  (`lineHeight`, `WebkitUserSelect`, `touchAction`), которые лечат
  набор iOS WKWebView квирков; их пропуск проявляется
  не-детерминированно — где-то работает «по случаю», где-то ломается.

### Урок
1. **Обёртки над fetch не должны жёстко задавать `Content-Type`** —
   браузер сам выставит правильный, если body это `FormData`, `Blob` или
   `URLSearchParams`. Default-заголовок имеет смысл только для JSON-body.
   Безопасный паттерн:
   ```ts
   headers: {
     ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
     ...
   }
   ```
2. **Любой `<input>` в Mini App обязан иметь явный `line-height`**
   (помимо font-size). Без него WebKit считает caret-rect из intrinsic
   метрик, что в flex-контейнерах ломается. Также обязательны
   `WebkitUserSelect: 'text'` и `touchAction: 'auto'` (комментарий в
   коде про native selection handles при ancestor touchmove handlers).
3. **Корреляция ≠ причина при отладке UI-багов.** Если после первого
   фикса баг сохраняется, это означает, что гипотеза о root cause
   неверна, а не «фикс не доехал до прода». Не повторять тот же фикс,
   а пересобирать гипотезу. Здесь корреляция была: text-инпут имел
   scroll-handler И работал → решили, что scroll-handler == фикс.
   Реальная причина — у text-инпута caret-displacement не
   проявлялся по другим случайным причинам.

### Правило
- Любая обёртка над `fetch` должна проверять `body instanceof FormData`
  (и желательно `Blob`/`URLSearchParams`) и **не** заполнять
  Content-Type в этих случаях.
- **Inline-стили на `<input>` без `lineHeight` запрещены.** Либо
  использовать каноничный `inputStyle` из MiniApp.tsx (через spread
  `...inputStyle`), либо явно прописать `lineHeight`,
  `WebkitUserSelect: 'text'`, `touchAction: 'auto'`.
- При фиксе UI-бага в Mini App **проверять на проде**, что симптом
  ушёл, прежде чем закрывать тикет. Локальная проверка через TS-check
  не покрывает iOS WKWebView quirks — нужен реальный тап.
- Если фикс №1 не помог — **новая гипотеза**, не «усилить тот же фикс».

### Лучший код
```tsx
// apps/web/app/miniapp/MiniApp.tsx — tgFetch
headers: {
  ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
  ...(initDataRef.current ? { 'X-TG-INIT-DATA': initDataRef.current } : {}),
  ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  ...(init?.headers as Record<string, string> | undefined),
},

// CalendarDetail.tsx — каждый <input> формы:
style={{
  ...,
  fontSize: 14, lineHeight: '20px',                    // ← lineHeight обязателен
  WebkitUserSelect: 'text', userSelect: 'text',        // ← iOS native selection
  touchAction: 'auto',                                 // ← iOS WKWebView quirk
}}
```

**Долгосрочно:** календарная форма должна быть переписана через
`...inputStyle` из канона. Inline-стили в новом коде — нарушение
design-system rules (CLAUDE.md: «No raw hex colors, no raw rgba, no
arbitrary Tailwind values in new code» — то же касается inline
inputs без primitive).

---

## 2026-04-30 — `getOrCreateProfile` race-condition 500 (повтор)

### Ошибка
GET `/tg/me/profile` периодически отвечает 500 для нового пользователя. В
логах — `PrismaClientKnownRequestError P2002` на `UserProfile.userId`,
вызов `prisma.userProfile.upsert()` внутри `getOrCreateProfile`. Mini-app
boot параллельно стреляет несколькими GET'ами от одного юзера, оба
запроса находят `findUnique == null`, оба делают `upsert`, второй падает
на unique-constraint.

Это **второе появление** того же бага. Первый фикс (`281379a`,
2026-04-19) заменил `create` на `upsert({ update: {} })` в надежде, что
Prisma переведёт это в атомарный `INSERT ... ON CONFLICT DO UPDATE`. На
проде 2026-04-30 оно опять упало — Prisma 5.18 при пустом `update: {}`
не использует native ON CONFLICT, а откатывается на тот же
check-then-create, который мы пытались исправить.

**Root cause:** ставка на «Prisma upsert магически атомарен» без проверки
поведения движка. Empty update — особый кейс, который ломает
оптимизацию. Гонка осталась.

### Урок
В Prisma `upsert` — **не безусловно атомарный** на уровне БД. При пустом
`update: {}` или некоторых других формах он деградирует до
find-then-create, и в условиях конкуренции от одного клиента выпадает в
P2002. Надёжный race-safe паттерн в Prisma — это `try { create }
catch (P2002) { findUnique }`. Это явный, тестируемый, не зависящий от
внутренних оптимизаций ORM код.

Отдельно: «фикс» race-condition нельзя считать закрытым, пока не
воспроизвели гонку искусственно (две параллельные create-операции в
тесте). Любая логика «оно теперь атомарное» без эмпирической проверки —
гипотеза, а не фикс.

### Правило
1. **Prisma upsert не равно ON CONFLICT.** Не полагайся на upsert как
   на race-safe primitive. Если нужна гарантия — пиши `create` + catch
   `Prisma.PrismaClientKnownRequestError` с `code === 'P2002'` и
   `meta.target.includes('<field>')`, потом re-fetch.
2. **Узкий catch.** Catch P2002 только для конкретного поля; остальные
   constraint violations (`username`, `supportId` и т.п.) пробрасывай —
   это другие баги, маскировать нельзя.
3. **Race-fixes требуют test-evidence.** Если фиксишь гонку без
   юнит-теста, который её воспроизводит — фикс гипотетический. Минимум:
   nightly e2e, который параллелит 5 одновременных вызовов проблемной
   функции и ждёт стабильного результата.
4. **Re-occurrence == уровень выше.** Если тот же баг с тем же symptom
   возвращается после «фикса» — менять стратегию, не подкручивать
   старый подход.

### Лучший код
```ts
// ❌ Первый фикс: upsert с пустым update — Prisma фолбэчит на
// check-then-create при некоторых конфигурациях
profile = await prisma.userProfile.upsert({
  where: { userId },
  create: { userId, defaultCurrency, supportId },
  update: {},
});

// ✅ Race-safe: явный create + узкий catch P2002 + re-fetch
try {
  profile = await prisma.userProfile.create({
    data: { userId, defaultCurrency, supportId },
  });
} catch (err) {
  const isUserIdConflict =
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray((err.meta as { target?: unknown } | undefined)?.target) &&
    ((err.meta as { target: string[] }).target.includes('userId'));
  if (!isUserIdConflict) throw err; // другие constraints — наверх
  const existing = await prisma.userProfile.findUnique({ where: { userId } });
  if (!existing) throw err;
  profile = existing;
}
```

**Commit:** see `git log --grep="fix(profile): replace fragile upsert"` (commit hash chases itself on amend; pick by date 2026-04-30)

---

## 2026-04-29 — Calendar idea cards: keyboard overlap + non-tappable cards

### Ошибка
В разделе «Идеи подарков» на детальной карточке события было два бага:
1. При тапе на «+ Добавить идею» открывалась клавиатура и перекрывала
   форму ввода — пользователь не видел поля.
2. Создав идею с фото/ссылкой/заметкой, нельзя было открыть её для
   просмотра. Карточка идеи была плоская (только чекбокс + удалить),
   фото отображалось маленьким превью, заметка/ссылка — мелким хвостом
   или не отображались вовсе. Поле `note` существовало в типе и API, но
   в форме создания его вообще не было.

**Root cause:** UI был построен под “write-only” модель — данные пишутся,
но reading-experience не спроектирован. Authoring (создание) и
consumption (просмотр) разошлись: API даёт богатую сущность (фото,
ссылка, заметка, цена), а UI рендерит только заголовок + чекбокс.
Плюс `autoFocus` без явного `scrollIntoView` — на iOS-keyboard форма
оказывалась за виртуальной клавиатурой.

### Урок
Каждая создаваемая сущность должна иметь parity между формой создания и
view-режимом. Если API принимает поле — форма должна его экспонировать.
Если форма принимает поле — view должен его показывать. Любое поле,
которое “тихо проваливается” (есть в API, нет в UI) — это потерянная
работа пользователя.

Отдельно: `autoFocus` на iOS/Telegram WebApp **не гарантирует** прокрутку
к полю. visualViewport ресайзится с задержкой, и `scrollIntoView` нужно
вызывать после стабилизации (или повторно по `onFocus` с `setTimeout`).

### Правило
1. **API field parity:** при review’е формы создания — пройтись по
   payload’у API и убедиться, что каждое поле имеет input. Если поле
   опциональное и редко используется — спрятать за «Дополнительно», но
   не выкидывать.
2. **View parity:** view-карточка должна уметь показать всё, что было
   введено. Если поле есть в типе — UI должен иметь явный путь к его
   отображению (inline или через раскрытие/детальный экран).
3. **Mobile keyboard scroll:** при появлении формы внутри скролл-страницы
   на мобильном — всегда вызывать `scrollIntoView` через ref, плюс
   повторный вызов на `onFocus` с задержкой 300ms (под анимацию
   visualViewport). `autoFocus` без скролла = баг на iOS.

### Лучший код
```tsx
// ❌ До: autoFocus без скролла, форма уходит под клавиатуру
<input autoFocus ... />

// ✅ После: ref + useEffect + onFocus retry
const formRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (adding && formRef.current) {
    formRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}, [adding]);

<div ref={formRef}>
  <input
    autoFocus
    onFocus={() => {
      setTimeout(() => formRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    }}
  />
</div>
```

```tsx
// ❌ До: карточка идеи — view-only, нельзя открыть фото/note/link
<div>
  <Checkbox /> <Thumbnail /> <Title /> <DeleteButton />
</div>

// ✅ После: tap-to-expand, парность с полями API
const hasDetails = !!(idea.imageUrl || idea.note || idea.link);
<div>
  <div onClick={() => hasDetails && setExpandedId(expanded ? null : idea.id)}>
    {idea.text} {hasDetails && !expanded && <span>›</span>}
  </div>
  {expanded && (
    <ExpandedView photo={idea.imageUrl} note={idea.note} link={idea.link} />
  )}
</div>
```

```tsx
// ❌ До: API принимает note, форма не отправляет
await api.createIdea(tg, occasionId, { text, link, price, currency });

// ✅ После: каждое поле API имеет input в форме
await api.createIdea(tg, occasionId, {
  text, link, price, currency,
  note: note.trim() || undefined,
});
```

**Commit:** `2ad5cb7` — fix(calendar): expandable idea cards + keyboard scroll + note field
