# Tags — решение: удалить или запланировать UI

**Дата:** 2026-05-29
**Скоуп:** `Tag` / `ItemTag` модели в prod, admin CRUD, public `?tag` фильтр, отсутствие Mini App UI
**Рекомендация:** **Remove (deprecate + drop)** — фича подтверждённо мёртвая, дублирует `WishlistCategory`, удаление **полностью обратимо** (нет реальных данных). Финальное решение — за владельцем; код не трогаю до твоего «go».

> ⚠️ Код **не удалён**. Это аналитика + план. См. § 9 (опции) и § 12 (требуется решение).

---

## 1. TL;DR

| Вопрос | Ответ |
|---|---|
| Используется ли Tag в prod реальными юзерами? | **Нет.** 3 тега, все — seed-данные на демо-вишлисте, 0 органических. |
| Есть ли end-user путь создать/присвоить тег? | **Нет.** Только admin CRUD под `X-ADMIN-KEY`. |
| Есть ли Mini App UI? | **Нет.** API отдаёт `tags` в payload, монолит их не рендерит. |
| Рендерится ли тег-UI где-либо для юзера? | Да — public web `/w/[slug]` (dropdown + чипы), но он **всегда пустой** (тегов нет). |
| Дублирует ли что-то живое? | **Да — `WishlistCategory`** (полный Mini App UI, 140 строк на 132 вишлистах). |
| Безопасно ли удалить? | Да. Нет данных для миграции; rollback = пересоздание пустых таблиц. |

**Главный факт:** Tag и ItemTag существуют с **самой первой миграции** (`20260210151944_init`, 2026-02-10). За ~3.5 месяца — **ноль** органических тегов. Параллельно команда построила `WishlistCategory` с полным UI, и юзеры его активно используют. Tags — заброшенный ранний примитив, замещённый категориями.

---

## 2. Что показывает prod DB (решающий замер)

```sql
SELECT
  (SELECT COUNT(*) FROM "Tag")                       AS tag_rows,        -- 3
  (SELECT COUNT(*) FROM "ItemTag")                   AS itemtag_rows,    -- 5
  (SELECT COUNT(DISTINCT "wishlistId") FROM "Tag")   AS wishlists_w_tags,-- 1
  (SELECT COUNT(DISTINCT "itemId") FROM "ItemTag")   AS items_tagged;    -- 4
```

Детализация всех трёх тегов:

```sql
SELECT t.name, t."createdAt"::date, w.slug, w.title, u."telegramId", u."firstName"
FROM "Tag" t
JOIN "Wishlist" w ON w.id = t."wishlistId"
JOIN "User" u ON u.id = w."ownerId";
```

| tag_name | created | slug | wl_title | telegramId | firstName |
|---|---|---|---|---|---|
| дорого | 2026-02-16 | `demo` | Demo wishlist | *(пусто)* | *(пусто)* |
| техника | 2026-02-16 | `demo` | Demo wishlist | *(пусто)* | *(пусто)* |
| вкусняхи | 2026-02-16 | `demo` | Demo wishlist | *(пусто)* | *(пусто)* |

**Вывод:** все 3 тега и 5 связей — это **в точности** seed-данные из [`apps/api/src/seed.ts`](../../apps/api/src/seed.ts):

```ts
// seed.ts:66–102
tags: ['вкусняхи']            // 1 item
tags: ['техника', 'дорого']   // 1 item
tags: ['техника']             // 1 item
tags: []                      // 0
tags: ['вкусняхи']            // 1 item
// → unique: вкусняхи, техника, дорого = 3 тега; ассоциаций = 5 ✅
```

Владелец — seed/demo юзер (`telegramId IS NULL`, `firstName IS NULL`, создан в день сидинга). Вишлист `demo` — `LINK_ONLY`. **Ни один реальный Telegram-пользователь никогда не создавал и не присваивал тег** — что логично, т.к. UI для этого не существует.

### Контраст: `WishlistCategory` (живой sibling)

```sql
SELECT COUNT(*) AS category_rows, COUNT(DISTINCT "wishlistId") AS wls_with_cats
FROM "WishlistCategory";
-- category_rows = 140, wls_with_cats = 132
```

Категории решают ту же задачу («организовать товары внутри вишлиста»), имеют **полный Mini App UI** (создание / переименование / удаление / reorder — [`MiniApp.tsx:3948–3966`](../../apps/web/app/miniapp/MiniApp.tsx)) и **массово используются**. Это и есть причина, по которой Tags умерли: продукт уже ответил на вопрос «как юзер группирует подарки» — категориями.

---

## 3. Полная карта кода (где живёт Tag)

### DB / Prisma — [`packages/db/prisma/schema.prisma`](../../packages/db/prisma/schema.prisma)
| Что | Строка |
|---|---|
| `model Tag` | 364–373 |
| `model ItemTag` (join) | 376–384 |
| `Wishlist.tags Tag[]` | 304 |
| `Item.itemTags ItemTag[]` | 33 |
| Таблицы созданы в миграции | `20260210151944_init` (Tag:53, ItemTag:63, idx:98, FK:110/113/116) |

### Backend — `apps/api/src/`
| Файл | Что |
|---|---|
| [`routes/admin.routes.ts`](../../apps/api/src/routes/admin.routes.ts) | **5 admin-эндпоинтов** (262–348): POST/DELETE `/items/:itemId/tags/:tagId`, POST `/wishlists/:id/tags`, PATCH `/tags/:id`, DELETE `/tags/:id` |
| [`routes/public.routes.ts`](../../apps/api/src/routes/public.routes.ts) | `?tag` query-фильтр (121, 138); `itemTags` includes (148, 217, 373, 672, 732, 777); `tags` select (196, 350); `PublicItem.tags` mapping (52, 69, 312, 436) |
| [`routes/wishlists.routes.ts`](../../apps/api/src/routes/wishlists.routes.ts) | tags includes + mapping в Mini App API (1316, 1344, 1421, 1431) — **отдаётся, но не рендерится** |
| [`seed.ts`](../../apps/api/src/seed.ts) | seeding тегов (45–49, 130; `tags:` массивы 66–102) — **dev/demo only** |
| `services/search.ts` | **НЕ затронут** — теги в поиске не участвуют (совпадения grep = «tagged-template» SQL, не модель) |

### Frontend — `apps/web/`
| Файл | Что |
|---|---|
| [`app/w/[slug]/WishlistClient.tsx`](../../apps/web/app/w/[slug]/WishlistClient.tsx) | **Единственное место, где тег-UI реально рендерится юзеру:** `Tag` type (5), tags-поля (19, 25), `tagFilter` state (138), client-side фильтр (201), dropdown «Тег» (279–293), чипы на айтемах (359–370). Фильтрует **клиентски** — серверный `?tag=` не вызывает. Для реальных вишлистов dropdown всегда пуст (только «Все»). |
| [`app/admin/[id]/page.tsx`](../../apps/web/app/admin/[id]/page.tsx) | Admin UI тегов: импорты (13–17), state (31, 49–52), хендлеры (139–162), секция «Tags» (241+) |
| [`app/admin/page.tsx`](../../apps/web/app/admin/page.tsx) | счётчик `Tags: N` (75–76), копирайт «and tags» (26) |
| [`app/api/admin/wishlists/[id]/tags/route.ts`](../../apps/web/app/api/admin/wishlists/[id]/tags/route.ts) | proxy POST (+ `route.test.ts`) |
| [`app/api/admin/tags/[tagId]/route.ts`](../../apps/web/app/api/admin/tags/[tagId]/route.ts) | proxy DELETE (+ `route.test.ts`) |
| [`lib/admin-api-client.ts`](../../apps/web/lib/admin-api-client.ts) | `type Tag` (35), `createTag` (160), `deleteTag` (172), `_count.tags` (16), `tags?` (32), `tags: Tag[]` (60), `?tag` filter (99–103) |
| [`app/miniapp/lib/searchApi.ts`](../../apps/web/app/miniapp/lib/searchApi.ts) | `tags: Array<{id,name}>` в типе ответа (228) — пробрасывается, не используется |
| `app/miniapp/MiniApp.tsx` | тег-рендеринга **нет** (совпадения grep = «PRO-tag», addon-tag, dont-gift-presets — не модель) |

### Тесты
- `apps/web/app/api/admin/wishlists/[id]/tags/route.test.ts`, `apps/web/app/api/admin/tags/[tagId]/route.test.ts` — admin proxy.
- `apps/web/app/admin/[id]/page.test.tsx` — мокает `createTag`/`deleteTag`.

---

## 4. Коррекция feature map

[`docs/research/01-product-feature-map.md` §5.4](01-product-feature-map.md) (строка 504) утверждает: *«Поле `?tag=` фильтр существует… но никем не вызывается из официального клиента»* и помечает фичу как «UI нет».

Уточнение по факту кода:
- **Серверный `?tag=`** (`public.routes.ts:138`) официальным end-user клиентом действительно **не вызывается** — public web фильтрует клиентски, admin-клиент wired-ит его, но это admin-only. ✅ верно.
- **Но тег-UI на public web `/w/[slug]` существует и рендерится** (dropdown + чипы). Формулировка «UI нет» неточна — корректнее: *«UI есть только на public web и всегда пуст; в Mini App UI нет»*.

→ При любом решении стоит поправить §5.4 (мелкая правка, вне скоупа этого дока — отдельным коммитом).

---

## 5. Анализ: почему Tags мертвы

1. **Нет точки входа.** Создать/присвоить тег может только админ через `X-ADMIN-KEY`. У юзера нет ни кнопки, ни экрана → накопить usage физически невозможно без постройки UI.
2. **Замещены категориями.** `WishlistCategory` решает ту же задачу группировки, имеет UI и 132 вишлиста adoption. Два пересекающихся примитива организации без чёткого разграничения — это путаница, а не фича.
3. **Документированный долг.** KNOWN_GAPS Risk #20 + feature map §5.4 уже флагают это как dead code.
4. **Тянет вес в горячих путях.** Каждый public/Mini App read джойнит `itemTags` и селектит `tags` ради данных, которые на 100% вишлистов пусты.

---

## 5a. Продуктовый вердикт — нужна ли фича, или категории покрывают полностью?

**Вердикт: категории покрывают реальную потребность. Теги не нужны → удалять (Option A).**

Это не «категории технически дублируют теги» — они **не** дублируют. Есть ровно одно структурное различие, и его стоит назвать честно:

| | Категория | Тег |
|---|---|---|
| Кардинальность | **single** — `Item.categoryId String?` (один товар = одна папка, `onDelete: SetNull`) | **multi** — join `ItemTag` (один товар = много меток) |
| Статус | Pro-фича (FREE 1 / PRO до 20), монетизирует | admin-only, free, не монетизирует |
| UX | полный: create/rename/delete/reorder, перемещение, группировка, гость видит структуру ([`MiniApp.tsx:9308–9460`](../../apps/web/app/miniapp/MiniApp.tsx)) | нет UI |
| i18n / upsell / search | есть (`upsell_categories_*`, search-интеграция) | нет |

Единственное, что теги умеют, а категории нет — **multi-membership** (повесить на товар несколько ортогональных ярлыков).

**Почему это различие здесь не имеет значения — решающая цифра:**

```sql
-- среднее число товаров на вишлист (prod, 2026-05-29)
-- wishlists=176, avg_items=1.7, max=35, >15 товаров: 3 вишлиста, >30: 1
```

При **среднем 1.7 товара на вишлист** организационной проблемы не существует в принципе. Список из 2 товаров не группируют и не фильтруют — ни категориями, ни тегами. Вторая ось фильтрации (ради чего теги и существуют) решает проблему, которой у пользователей этого продукта **нет**. Даже категории при таком масштабе работают скорее как монетизация/структура для гостя, чем как насущный инструмент; теги *поверх* них — избыточность на избыточности.

Multi-label реально мог бы понадобиться лишь на длинных списках (>15 товаров) — таких **3 из 176 (1.7%)**, и даже там single-folder категорий достаточно.

**Стоимость держать обе оси:** второй примитив организации на консьюмерском приложении, чья метрика — retention (= простота), это когнитивный шум для юзера и поддержка-долг для нас, без пропорциональной пользы. Категории — выбранный, отполированный, **приносящий деньги** примитив; теги его размывают (бесплатная параллельная ось вместо Pro-апселла).

**Tripwire для пересмотра:** если продукт когда-нибудь сместится к длинным спискам как норме (свадебные/детские реестры, коллаборативные/семейные списки на 30–50+ позиций) — вернуться к multi-label. Сегодня сигнала нет.

---

## 6. Self-check (по ТЗ)

| Проверка | Результат |
|---|---|
| **grep по Tag usage** | Выполнен. Реальная модель: admin CRUD (5 endpoints), public/wishlists read includes, seed, public web UI. Отделено от шума (HTML/meta/PRO-tag/tagged-template SQL). |
| **SQL: count Tag rows** | `Tag=3, ItemTag=5, 1 wishlist (demo), 0 реальных юзеров` — всё seed. |
| **Migration + rollback** | См. § 10. Forward: DROP 2 таблицы. Rollback: пересоздать пустые (дословный DDL из init). |
| **Код не удалять без решения** | Соблюдено — ничего не тронуто. |

---

## 9. Опции

### Option A — Remove (**рекомендуется**)
Снести модели `Tag`/`ItemTag`, admin CRUD, public-фильтр, public web тег-UI.
- **За:** ноль usage; дубль категорий; закрывает Risk #20; чистит горячие read-пути; **обратимо почти даром** (нет данных для сохранения).
- **Против:** диф на ~12 файлов (вкл. тип в 30k-строчном `MiniApp.tsx` и public web); теряется optionality (если теги-как-cross-cutting-labels когда-нибудь понадобятся — строить заново).
- **Риск:** низкий. Демо-вишлист потеряет чипы — косметика.

### Option B — Keep + запланировать UI (не строить сейчас)
Оставить модель, в будущем построить Mini App UI. Эскиз спеки — § 11.
- **За:** теги — легитимный *cross-cutting* ярлык (item в одной категории, но с многими тегами).
- **Против:** пересекается с категориями — нужна кристальная продуктовая граница «теги vs категории», иначе путаница core loop. **Нет сигнала спроса** (0 запросов, 0 usage). Строить на спекуляции.

### Option C — Defer (status quo)
Ничего не делать, код дремлет (как referral «keep disabled»).
- **За:** ноль усилий; код безвреден функционально.
- **Против:** долг остаётся; public web показывает реальным гостям **всегда пустой** dropdown «Тег» — мелкая UX-бородавка; горячие пути продолжают джойнить пустоту.

---

## 10. Removal plan (Option A) — миграция + rollback

### 10.1 Forward migration
Новая миграция `packages/db/prisma/migrations/<ts>_drop_tags/migration.sql`:

```sql
-- DropForeignKey
ALTER TABLE "ItemTag" DROP CONSTRAINT "ItemTag_itemId_fkey";
ALTER TABLE "ItemTag" DROP CONSTRAINT "ItemTag_tagId_fkey";
ALTER TABLE "Tag"     DROP CONSTRAINT "Tag_wishlistId_fkey";

-- DropTable
DROP TABLE "ItemTag";
DROP TABLE "Tag";
```

> Безопасно без бэкапа: единственные данные — 3 seed-тега на демо-вишлисте. При желании сохранить демо — заранее `pg_dump -t '"Tag"' -t '"ItemTag"'`.

### 10.2 Rollback (forward-only Prisma → откат = пересоздание; дословно из init)

```sql
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ItemTag" (
    "itemId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    CONSTRAINT "ItemTag_pkey" PRIMARY KEY ("itemId","tagId")
);
CREATE INDEX "Tag_wishlistId_idx" ON "Tag"("wishlistId");
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_wishlistId_fkey"
    FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ItemTag" ADD CONSTRAINT "ItemTag_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ItemTag" ADD CONSTRAINT "ItemTag_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

### 10.3 Порядок выкатки (важно: схема меняется после кода)
1. **Сначала код** — убрать все потребители (backend + frontend), задеплоить. После этого ни один путь не ссылается на таблицы.
2. **Потом миграция** — `DROP TABLE`. Так `DROP` не ломает работающий образ (старый код уже не обращается к таблицам).
3. Прогнать post-deploy health checks (CLAUDE.md): failed migrations = 0, `/health`, контейнеры, heartbeat.

### 10.4 Файловый чек-лист (когда «go»)
**Prisma:** удалить `model Tag`, `model ItemTag`, `Wishlist.tags`, `Item.itemTags` → `prisma generate`.
**apps/api:** `admin.routes.ts` (5 endpoints) · `public.routes.ts` (query schema + filter + includes + mapping + `PublicItem` type) · `wishlists.routes.ts` (includes + mapping) · `seed.ts` (tag seeding).
**apps/web:** `w/[slug]/WishlistClient.tsx` (type + state + filter + dropdown + чипы) · `admin/[id]/page.tsx` (вся tag-секция) · `admin/page.tsx` (счётчик + копирайт) · удалить каталоги `api/admin/wishlists/[id]/tags/` и `api/admin/tags/[tagId]/` · `lib/admin-api-client.ts` (type + create/delete + filter + `_count.tags`) · `miniapp/lib/searchApi.ts` (поле `tags`) · `MiniApp.tsx` (поле `tags` в типе item, если есть).
**Тесты:** удалить tag-тесты proxy; почистить `admin/[id]/page.test.tsx`.
**Docs:** `01-product-feature-map.md` §5.4 · `DATA_MODEL.md` · `API_REFERENCE.md` (убрать Tag-эндпоинты/модель).

---

## 11. UI spec sketch (только если Option B — НЕ строить сейчас)

Заготовка на случай решения «keep». Перед постройкой обязательно: (а) продуктовая граница vs категории, (б) сигнал спроса, (в) mockup-first по design-system контракту.

- **Продуктовая граница:** Категория = *одна* папка (item ровно в одной). Тег = *много* cross-cutting ярлыков («срочно», «идея», «для детей»), ортогональных категориям. Если эту границу не удержать — не строить.
- **Точки входа (которых сейчас нет):**
  - Item editor: chip-input «Теги» (autocomplete по существующим тегам вишлиста + создание нового).
  - Wishlist view: фильтр-строка тег-чипов (toggle), поверх существующего фильтра категорий.
- **Из design-system:** чипы → существующий chip-паттерн (не инлайнить); фильтр → паттерн фильтр-бара. Новых примитивов не плодить без mockup→approve.
- **Backend:** уже готов (admin CRUD переиспользовать как user-scoped с `protectTgRoute` + idempotency `wishlist.tag.create` / rate-limit категория; см. API_SECURITY/ARCHITECTURE контракты). Public `?tag=` фильтр уже есть.
- **Гейтинг:** решить free vs Pro (как лимиты категорий).
- **Тесты:** happy + error path на новые user-scoped эндпоинты; рендер чипов/фильтра.

> Это **эскиз**, не утверждённая спека. Полноценная спека = отдельный артефакт после approve (design-draft-first).

---

## 12. Требуется решение

Код не тронут. Жду выбор:

- **A (remove)** — выполняю removal plan § 10 (код → деплой → миграция → health checks), бандлю с правкой feature map §5.4.
- **B (keep + UI)** — оставляю как есть, развиваю § 11 в полноценную спеку + mockup, **без постройки** до approve.
- **C (defer)** — статус-кво, опционально только убрать всегда-пустой dropdown «Тег» на public web (мелкая UX-чистка).
