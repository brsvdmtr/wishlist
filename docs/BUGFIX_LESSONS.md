# Bug-fix Lessons

Structured log of bug fixes — symptom + root cause, lesson, rule, better code.
New entries go at the top.

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
