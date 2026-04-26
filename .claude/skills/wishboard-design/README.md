# WishBoard Design System

> Telegram Mini App for creating and sharing wishlists. Friends reserve gifts in **surprise mode** (the owner never sees who reserved what). Monetized via Telegram Stars (PRO, 100 ⭐/month).

- **Product:** https://wishlistik.ru/miniapp
- **Bot:** @WishHub_bot
- **Source repo:** [`brsvdmtr/wishlist`](https://github.com/brsvdmtr/wishlist) (GitHub)
- **Design‑system docs in repo:** `docs/design-system/` (mirrored here — see below)
- **Binding mockups:** `docs/design-system/mockups/approved/` — `v2.1-refresh-all-screens.html` is the **current canonical (v2.1)**; the `v2-*.html` set is retained as approved-secondary (Santa, group-gift, etc., where v2.1 refresh hasn't landed yet).

The product is **Russian-first**, localized to 6 languages (ru · en · zh-CN · hi · es · ar-RTL). Copy is written in Russian in this system; English translations are parallel. The primary surface is a dark‑first WebView inside Telegram, ~375 × 812 px (iPhone 13 baseline).

---

## ⚠️ Bundle status notice (read first)

This bundle is a **mirror of the repo's design system**, not an independent source of truth. Layered statuses inside:

| Folder/file | Status | Authoritative |
|---|---|---|
| `colors_and_type.css` | **v2.1 canonical** | Yes — drop-in CSS for non-React consumers |
| `packages/ui-tokens/src/*.ts` | **v2.1 canonical** | Yes — synced from repo |
| `packages/ui/src/*.tsx` | **v2.1 canonical** | Yes — synced from repo |
| `docs/design-system/*.md` + `mockups/approved/v2.1-*.html` + `v2-*.html` | **canonical** | Yes — identical to repo |
| `preview/*.html` (21 files) | **v2 visual archive** | NO — they hard-code v2 hex (`#7C6AFF`, `#1B1B1F`, etc.) and were exported before v2.1 refresh. Use as historical reference, not current spec. |
| `ui_kits/miniapp/*` (incl. `calendar/`) | **v2 prototype archive** | NO — same caveat. The calendar UI kit + `mockups/proposed/gift-calendar-onboarding.html` are sketches for a future feature; not yet implemented. |
| `scratch/`, `uploads/` | reference imagery | n/a |

**Rule for agents:** when implementing or proposing UI, pull tokens from `packages/ui-tokens/src/` (or `colors_and_type.css`) and primitives from `packages/ui/src/`. Do **not** copy hex values from `preview/*.html` or `ui_kits/miniapp/*` — they're v2 and will produce off-brand output.

If you spot something missing from the design system (a primitive, a token, a screen pattern), do NOT improvise: build a mockup in `docs/design-system/mockups/proposed/`, present it for approval, then promote into the bundle and `packages/ui` only after the human owner approves.

---

## Surfaces / products covered

| Surface | Location in repo | In this design system |
|---|---|---|
| **Mini App** (primary) | `apps/web/app/miniapp/MiniApp.tsx` | `ui_kits/miniapp/` |
| Telegram bot | `apps/bot/` | (not design-relevant; text-only) |
| Public web (wishlist share links, admin) | `apps/web/app/` | (out of scope for this round) |

> Only the Mini App has a design system. The bot is text + keyboards; the public web is a thin fallback.

---

## What's here — index

| File / folder | Purpose |
|---|---|
| `README.md` | This file — brand, content, visual foundations, iconography |
| `SKILL.md` | Agent‑Skills entrypoint (use in Claude Code) |
| `colors_and_type.css` | CSS variables + semantic roles for all consumer code |
| `packages/ui-tokens/src/` | **Canonical token source** — TypeScript (colors, spacing, radius, shadow, motion, gradients, typography, z‑index, sizing, safe‑area, breakpoints) |
| `packages/ui/src/` | **Canonical primitives** — Button, Card, Sheet, SectionHeader, ListRow, Banner, Chip, CounterBadge, StatTile, AvatarStack |
| `docs/design-system/` | Mirrored design‑system docs (FOUNDATIONS, COMPONENTS, SCREEN_PATTERNS, INTERACTION_SYSTEM, UI_IMPLEMENTATION_RULES) |
| `docs/design-system/mockups/approved/` | **Binding HTML mockups + `_north-star-v2.css`** |
| `preview/` | **v2 visual archive** — 21 design‑system preview cards (color swatches, type specimens, component states). Hard-codes v2 hex; not v2.1-binding. See status notice above. |
| `ui_kits/miniapp/` | **v2 prototype archive** — interactive screen recreations (home, wishlist detail, paywall, onboarding). Includes `calendar/` sub-kit for the proposed gift-calendar feature (not yet shipped). Reference for prototyping; not v2.1-binding. |
| `assets/` | Logos, icons (none bundled — icon policy below) |

---

## Brand / Product overview

WishBoard (бренд: **Wishlistik**, бот: **@WishHub_bot**) помогает людям:

- создавать вишлисты и делиться ими по ссылке;
- импортировать товары из маркетплейсов (Ozon, WB, Яндекс Маркет, Lamoda, Goldapple) — **PRO**;
- бронировать подарки **в режиме сюрприза** (владелец не видит, кто забронировал);
- обмениваться подарками по сценарию **Secret Santa**;
- писать **намёки** и подписываться на вишлисты друзей (до 5 — PRO).

Монетизация: подписка PRO 100 ⭐/мес. через Telegram Stars. Промокод `WISHPRO` даёт 30 дней PRO.

FREE/PRO лимиты: 2/10 вишлистов · 20/70 желаний · 5/20 участников · 2/5 подписок · без комментариев/импорта/намёков на FREE.

---

## Content Fundamentals

### Voice & tone

- **Язык:** русский — основной. Обращение на **«ты»** (дружеский тон Telegram‑мини‑аппов), а не «вы». Бот — «умный друг», не корпоративный ассистент.
- **Регистр:** **sentence case** во всех заголовках и кнопках (не Title Case и не ALL CAPS). Исключения: аббревиатуры (**PRO**, **AI**, **TG**), бренды (**Ozon**, **Lamoda**) — как у бренда.
- **Краткость:** мини‑аппа живёт в 375 px; заголовки ≤ 30 символов, текст кнопок — 1‑3 слова. Приоритет — глагол действия («Забронировать», «Открыть», «Добавить»).
- **Эмодзи:** используются **целенаправленно и умеренно** — как префикс к заголовкам сегментов (🎁 «Мои вишлисты», 🎄 «Secret Santa»), как иконка категорий в thumbnails, в поздравлениях. Никогда — в телах кнопок и в официальных сообщениях об ошибках.
- **Обращение к чувствам:** surprise‑mode = **волшебство**. Копирайт избегает шпионской/военной лексики («секретная операция») и официоза — ближе к «фокусник прячет подарок за спиной».

### Specific examples from approved mockups

| Место | Текст | Что это говорит |
|---|---|---|
| Онбординг, заголовок | «Первое желание» | Краткость, ты‑форма по умолчанию |
| Онбординг, сабтайтл | «Добавь первую вещь, которую хочешь получить в подарок» | Конкретика: «вещь», «в подарок» — не «желание» как абстракция |
| Paywall, hero | «WishBoard **PRO**» / «Всё для идеальных подарков» | Sentence case, PRO в upper как стиль бренда |
| Подарено PRO‑подарок | «🎁 Подарено с любовью» | Эмодзи + чувство, а не транзакция |
| Состояние «секретно забронировано» | «Ты забронировал тайно. Хозяин вишлиста не увидит.» | Явное обращение к пользователю («ты»), прямое объяснение правила |
| Промо Secret Santa | «Тяни, кому даришь 🎄» | Императив + эмодзи как акцент |
| Пустое состояние | «Ничего пока нет. Добавь первое желание — это займёт 30 секунд.» | Обещание времени, призыв действия |
| Конфликт брони | «Этот подарок уже купили открыто. Сними тайную бронь, чтобы не задвоить.» | Объясняет причину, подсказывает действие |

### Rules for agents writing copy

1. Глагол + объект. «Создать вишлист», не «Создание нового вишлиста».
2. Никогда — «пользователь», «система», «платформа». Только «ты» / «друг» / «WishBoard».
3. Не использовать «кликни» (мы в тач‑интерфейсе); всегда «нажми» или «выбери».
4. Состояние PRO — всегда с акцентом: `<Chip tone="pro">PRO</Chip>`, не «(PRO)» в скобках.
5. Ошибки: что случилось → что делать. Не бросать юзера в стену красного.
6. Числа: русская конвенция (цена: `2 499 ₽`, без копеек). Даты: «3 янв», «вчера», «15 мин назад».

---

## Visual Foundations

### Colors

- **Dark‑first, v2.1 glass.** Фон `#0F0F12` (был `#1B1B1F` в v2). Поверх — фиксированная **mesh‑gradient подложка** (3 layered radials, см. `--wb-grad-mesh` в `colors_and_type.css`). Карточки — translucent glass `rgba(255,255,255,0.045)` + `backdrop-filter: blur(14–16px)` (был solid `#2F2F38` в v2). Без светлой темы.
- **Один brand‑accent:** `#8B7BFF` (cooler violet, был `#7C6AFF` в v2). Не синий, не розовый, **один цвет**. Градиент `linear-gradient(135deg, #8B7BFF → #B4A6FF)` — для hero CTA. Deep blend для pressed states: `#8B7BFF → #5B48E5`.
- **Семантика:** успех `#4ADE80` · предупреждение `#FBBF24` · опасность `#FB7185`. Всегда с `rgba(·, 0.14)` **soft‑вариантом** для фоновой подложки.
- **Приоритет‑шкала** для карточек‑желаний: низкий `#6B7FD4` (blue) · средний `#FBBF24` (amber) · высокий `#FB7185` (pink). Это НЕ семантика — это **визуальная шкала** приоритета желания. В градиентах всегда `90deg` horizontal.
- **Santa** — `#0f5f3c → #1a8552 → #d92020`. **Не смешивать** с brand‑accent — это изолированный сезонный палитровый остров. Источник: `mockups/approved/v2-santa-campaign.html` (v2 моки для Santa остаются binding в v2.1).

### Type

Единое системное семейство `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', sans-serif`. **Никаких веб‑шрифтов** — мини‑аппа живёт внутри TG WebView и наследует системный текст. Inter в стеке для Android‑fallback (если включен в системе) — но не подгружается. Масштаб компрессионный (10 – 32 px): мини‑аппа — не landing page. Body = 15 px; card title = 17 px; sheet title = 19 px; hero title = 32 px.

**v2.1 weight discipline.** Большинство UI‑текста использует **`650`** (между semibold 600 и bold 700) — карточные заголовки, button labels, list‑row titles, nav active. **`550`** — nav‑items в неактивном состоянии и meta‑labels. Остальные веса 400/500/600/700/800 как обычно. Letter‑spacing для display: `-0.025em` (display) и `-0.035em` (hero) — заголовки заметно сжаты.

### Spacing

Основа: 4‑px grid с сильными «якорями» — **8 (flex gap), 14 (button v‑padding / list row gap), 16 (card padding), 24 (sheet padding)**. Эти четыре значения покрывают 90% кода. Экстремально важно: **screen padding X = 16** — все экраны мини‑аппы в 16 px от бортов.

### Backgrounds / imagery

- **Нет** фотобэкграундов, нет «full‑bleed hero images». Есть одно исключение — **paywall hero** (рендер‑gradient‑блок с светом), где используется композит из двух radial + linear‑accent.
- **Нет** hand‑drawn illustrations, нет ручного орнамента. Пустые состояния — **emoji‑иконка 3.5 rem + текст**, иногда в круге с accent‑soft фоном.
- **Текстуры:** только `inset 0 1px 0 rgba(255,255,255,0.15/0.20)` на gradient‑CTA (имитация верхнего ребра).
- **Паттерны:** нет.

### Animation

- **Длительности:** `0.12s / 0.15s / 0.2s / 0.3s / 0.4s / 1s`. Almost everything = **0.15s ease**. Sheet‑slide = `0.32s decelerate`.
- **Easing:** `ease` по умолчанию. `cubic-bezier(0.4, 0, 0.2, 1)` (`emphasized`) — **v2.1 default** для UI state changes (tab switch, card press, tile select). `cubic-bezier(0.25, 0.8, 0.35, 1)` (`decelerate`) — sheet open/close. `cubic-bezier(0.34, 1.56, 0.64, 1)` (`spring-out`) — **только** для «pop»‑эффекта на success‑check (онбординг).
- **Canonical transition presets:** `transition.all` (0.15s ease), `transition.allEmph` (0.2s emphasized — **новое в v2.1**), `transition.sheet` (0.32s decelerate — **новое в v2.1**).
- **Respect `prefers-reduced-motion`** — в `globals.css` глобально; не переопределяй в компонентах.
- **Float / glow‑pulse / sparkle / dot‑pulse** — декоративные keyframes на hero paywall, success‑screens и активных индикаторах.

### Hover / press / focus

- **Press:** `transform: scale(0.98)` для кнопок, `0.995` для карточек, `0.97` для tiles. Длительность 0.15s.
- **Hover:** очень экономно (TG — тач‑интерфейс). Если есть — `opacity: 0.9` или сдвиг к `--wb-surface-hover`.
- **Focus:** `box-shadow: 0 0 0 4px rgba(139,123,255,0.14)` — focus‑ring только в контекстах с клавиатурой (см. `--wb-sh-ring-focus`).
- **Haptic:** `Telegram.WebApp.HapticFeedback.impactOccurred('light')` на primary‑кнопках; `medium` на destructive.

### Borders, shadows, cards

- **Radii (v2.1, +2–8 px к v2):** `18 px` — PRIMARY (buttons, sheet‑inner cards). `22 px` — карточки на home/list. `14 px` — tabs/inner inline controls/thumbnails. `16 px` — form inputs (новый tier). `26 px` — hero‑cards. `28 px` — верх bottom‑sheet. `7 px` — бейджи. `11 px` — status pills. `20 px` — FAB (rounded‑square, **не круг**). `50%` — аватары, priority‑indicators, toggle knobs.
- **Карточки (v2.1 glass):** fill `rgba(255,255,255,0.045)` поверх mesh‑backdrop; **обязателен** `backdrop-filter: blur(14–16px)`. Border `1px solid rgba(255,255,255,0.06)` (почти невидимый). Pressed/active: `rgba(255,255,255,0.07)`. Тень — **нет** по умолчанию; `elevated 0 2px 12px rgba(0,0,0,0.18)` — только для кнопок.
- **Внутренние тени:** `inset 0 1px 0 rgba(255,255,255,0.22–0.24)` — на gradient‑CTA (имитация верхнего ребра).
- **Overlay/modal:** `0 12px 40px rgba(0,0,0,0.60)` — выпадающие меню; `0 8px 24px rgba(0,0,0,0.35)` — sheet; `0 -20px 60px rgba(0,0,0,0.5)` — bottom‑sheet upward drop (новое в v2.1).
- **Floating nav‑bar (v2.1):** `0 10px 30px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)` — на нижней liquid‑glass нав‑баре (см. `--wb-sh-nav-floating`).
- **FAB (v2.1):** `0 14px 40px rgba(139,123,255,0.45), inset 0 1px 0 rgba(255,255,255,0.24), 0 1px 2px rgba(0,0,0,0.3)` — `--wb-sh-fab-layered`.
- **Hero:** трёхслойная композитная тень `--wb-sh-paywall-hero` (`0 20px 50px -12px rgba(139,123,255,0.45), inset 0 1px 0 rgba(255,255,255,0.24)`) — **только** на paywall и wishlist‑hero, не копировать вручную.

### Layout / fixed chrome

- Mini App frame: **375 × 812 px** baseline (iPhone 13). Safe‑area top 44 px (status bar imitation), bottom 28 px (home indicator).
- **Sticky CTA** — внизу экрана, в `gradient-fade-bg` (fade к `--wb-bg` на 65%). Высота зоны ≈ 24 + 44 + 28 = 96 px.
- **Screen‑padding X:** 16 px на всех экранах, без исключений.
- **Content padding‑bottom** = 140 px, когда есть sticky CTA; 24 px без.

### Transparency / blur

- **Backdrop blur:** **обязателен на всех glass‑карточках в v2.1** — `backdrop-filter: blur(14–16px)`. Без blur translucent surfaces ломаются. Также на phone‑label бейджах и в модальных overlays — `blur(8px)` + `rgba(0,0,0,0.7)`.
- **Soft‑accent fills:** `rgba(139,123,255,0.14 / 0.30)` — accent‑soft и accent‑soft‑strong. Никогда не `0.4+` — это уже solid. Glow‑shadows (на CTA): `rgba(139,123,255,0.15 / 0.25 / 0.35 / 0.40 / 0.45)`.

### Imagery colour vibe

Н/д — WishBoard не использует фотографию или иллюстрацию. Визуальный язык — **typography + color + gentle gradient glow**.

---

## Iconography

WishBoard **не использует** привязку к Lucide / Heroicons / Material Icons в коде мини‑аппы. Что используется:

1. **Emoji (Unicode)** — основной «icon system» мини‑аппы. Примеры:
   - Навигация/сегменты: 🎁 вишлисты · 🤝 брони · 👥 друзья · 🛠 настройки · 🎄 Secret Santa
   - Тематические thumbnails: 🎧 · 💍 · 📱 · 👟 · 📚 · ☕ · 🧸
   - Состояния: ✅ успех · ⚠️ предупреждение · ❌ ошибка · 💡 hint · 🔒 приватность · ⭐ Telegram Stars
   - Эмодзи всегда рендерятся нативно (системный TG‑font); мы **не** подключаем Twemoji/Noto‑Emoji.
2. **Unicode glyphs** — для chevrons и мета‑элементов: `›` trailing chevron, `·` разделитель в meta‑row, `×` close‑icon, `+` add‑icon.
3. **Пользовательские SVG‑иконки в коде** — есть несколько штук в `apps/web/app/miniapp/icons/` (мы их не импортировали, т. к. это closed set of ~10 utility icons). В нашем design‑system‑репо заменены inline‑SVG‑плейсхолдерами того же stroke‑weight.
4. **Telegram Stars** — спецсимвол `⭐` (Unicode) или `Telegram.WebApp`‑нативный glyph в официальных invoice‑экранах.

**Правила использования:**

- **Bleed emoji**: в thumbnails 52×52 — emoji ~26px в center, фон `--wb-thumb-*-soft`.
- **Inline emoji** — в начале section‑header (🎁 + text), в начале текста banner (`b-icon`), в chip (`chip.pro ⭐`).
- **Нельзя** использовать emoji как вторую иконку-акцент внутри текста — это визуальный шум.
- **Нельзя** использовать emoji как метку статуса вместо `<Chip>` (✅ вместо `success` — запрет).

**Flagged substitutions:** система репы использует системный font‑stack для emoji; в скриншотах design‑system‑превью мы тоже полагаемся на ОС. На Linux/fallback системе emoji могут рендериться по‑разному — это ожидаемо.

---

## Visual / Font substitutions flagged

- **Fonts:** WishBoard **не использует** веб‑шрифты. `-apple-system` → на Windows = Segoe UI, на Android = Roboto, на Linux = fallback. **Это by design** — мини‑аппа наследует системный текст TG. Никаких TTF не нужно копировать; никаких Google Font fallbacks не нужно.
- **Logos / brand mark:** в репозитории нет логотипа как отдельного asset'a. Wordmark — просто текст **«WishBoard»** в `wb-display`. Иконка бота в TG — emoji 🎁 на accent‑gradient. Мы **не** рисуем лого от себя; используем text‑wordmark.

---

## Sources

- GitHub: `brsvdmtr/wishlist` @ `main`
  - Tokens: `packages/ui-tokens/src/*.ts` → импортировано в `packages/ui-tokens/src/` здесь
  - Primitives: `packages/ui/src/*.tsx` → импортировано в `packages/ui/src/` здесь
  - Docs: `docs/design-system/*.md` → импортировано в `docs/design-system/` здесь
  - Approved mockups: `docs/design-system/mockups/approved/v2-*.html` + `_north-star-v2.css`
- Product URL: https://wishlistik.ru/miniapp
- Bot: @WishHub_bot
- Decisions log (в исходном репо, не импортирован сюда): `docs/design-system/DESIGN_DECISIONS.md`

---

## How to use this system

1. **CSS‑only projects** → подключи `colors_and_type.css` + `docs/design-system/mockups/approved/_north-star-v2.css`, используй CSS‑переменные и классы `.wb-*`.
2. **React projects** → импортируй из `packages/ui/src/` и `packages/ui-tokens/src/` (пути настроены как `@wishlist/ui` и `@wishlist/ui-tokens` в исходном монорепо).
3. **Прототипирование** → начни с `ui_kits/miniapp/index.html` — живой кликабельный прототип, копируй куски.
