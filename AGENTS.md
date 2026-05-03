# AGENTS.md — WishBoard / Wishlist

> Контекст для CLI-агентов (Codex / Claude Code / другие). Самодостаточный — все iron rules, deploy workflow, и memory-факты собраны здесь. Если расходится с текущим состоянием кода — код выигрывает.

---

## 0. Кто пользователь

- **Дмитрий** — единственный разработчик и владелец.
- Русскоязычный, ожидает общение **на русском**.
- Хостинг перенесён на Vultr (Amsterdam, NL); Timeweb VPS больше не является production.
- Очень переживает за потерю пользователей (инцидент с aurora — ранний 2026).
- Даёт явное разрешение деплоить автономно после `git push` в `main`.

---

## 1. Что это за проект

**WishBoard** — Telegram Mini App для вишлистов: подписки, резервации, Pro-фичи, реферальная программа, Santa.

**Стек**:
- Frontend: Next.js (`apps/web`), Mini App в `apps/web/app/miniapp/MiniApp.tsx` (~30k строк-монолит)
- Backend API: Express + Prisma (`apps/api/src/index.ts`, ~19.6k строк)
- Telegram-бот: Telegraf (`apps/bot/src/index.ts`, ~2.3k строк)
- DB: PostgreSQL, схема в `packages/db/prisma/schema.prisma`
- Дизайн-система: `packages/ui` (примитивы) + `packages/ui-tokens` (токены v2.1)
- Менеджер: `pnpm@10.15.0`
- Деплой: Docker на Vultr VPS, через GitHub Actions

**Telegram Mini App, рендерится в WebView** — браузерное превью бессмысленно, никогда не запускать `preview_*` тулзы.

---

## 2. Verification (как проверять изменения)

```bash
# TS-проверка по проектам (нужно по затронутым)
npx tsc --project apps/web/tsconfig.json --noEmit
npx tsc --project apps/api/tsconfig.json --noEmit
npx tsc --project apps/bot/tsconfig.json --noEmit

# Prisma client после правок schema.prisma
pnpm --filter @wishlist/db exec prisma generate --schema=packages/db/prisma/schema.prisma

# Тесты (vitest)
pnpm test
# или точечно:
pnpm test -- apps/api/src/security-idempotency.test.ts

# UI raw-values audit (только при UI-работах)
pnpm ui:audit
```

**НЕ запускать**: `pnpm dev`, любой dev-server для UI-проверки. Это Mini App.

---

## 3. Deploy & Ops — ВАЖНО: через GitHub Actions, не SSH

### 3.1. Auto-deploy через push в `main`

- Workflow: `.github/workflows/deploy.yml`
- Триггер: любой push в `main` (или manual `workflow_dispatch`)
- **Селективная пересборка** по diff:
  - `apps/api/** | packages/db/** | packages/shared/** | pnpm-lock.yaml | Dockerfile.api` → api
  - `apps/bot/** | packages/db/** | packages/shared/** | pnpm-lock.yaml | Dockerfile.bot` → bot
  - `apps/web/** | packages/shared/** | pnpm-lock.yaml | Dockerfile.web` → web
  - `docker-compose.prod.yml` → все три
  - `.github/**`, docs-only — pull + skip (~3 сек)
- Длительность: ~3–5 мин для кода, ~3 сек для CI-only
- Concurrency group `deploy-prod` — пуши встают в очередь, не отменяются
- Docker build лимит: `--memory 768m` (на 2GB VPS, иначе OOM убивает sshd)

```bash
# Смотреть последний run
gh run list -R brsvdmtr/wishlist --workflow=deploy.yml --limit 5
gh run watch <run_id> -R brsvdmtr/wishlist --exit-status

# Manual re-deploy без push
gh workflow run deploy.yml -R brsvdmtr/wishlist
```

### 3.2. Admin ops через `admin-ops.yml` (без коммита)

`gh workflow run admin-ops.yml -R brsvdmtr/wishlist -f action=<...>` — основной канал day-to-day ops:

| `action=` | Что делает |
|---|---|
| `health-check` | 6-point regression gate (миграции / API / контейнеры / heartbeat / lifecycle / error spike) |
| `container-status` | `docker ps` + uptime + диск + память |
| `tail-logs` | Последние N строк api/bot/web/postgres + grep |
| `watch-logs` | `docker logs -f` на N сек (макс 300) + grep |
| `run-sql` | Любой SQL. Для строк используй `$$...$$` чтобы избежать quote-hell |
| `download-file` | Прочитать любой файл (base64 + текстовый превью) |
| `upload-file` | Записать файл (base64), с авто-бэкапом |
| `exec-shell` | Произвольный bash на VPS как root (escape hatch) |
| `restart-service` | Перезапустить api/bot/web без пересборки (~5s vs 5min) |
| `resolve-migration` | `prisma migrate resolve --applied <name>` |
| `edit-env-var` | Идемпотентно add/update/delete в `/opt/wishlist/.env` |
| `bump-rollout` | PATCH реферал-конфига `rolloutPercent` |
| `heal-attribution` | Force-qualify зависшую реферал-аттрибуцию + grant reward |
| `reset-test-data` | DELETE тестового юзера по telegramId |
| `retest-reset` | Полный реферал-test reset (user + reward + sub rollback) |
| `funnel-snapshot` | Дамп реферал-воронки + конфиг |

**Watch-шаблон**:
```bash
RUN=$(gh run list -R brsvdmtr/wishlist --workflow=admin-ops.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN -R brsvdmtr/wishlist --exit-status
gh run view $RUN -R brsvdmtr/wishlist --log | grep 'out:' | tail -40
```

### 3.3. SSH — ТОЛЬКО fallback

- Сервер: `root@199.247.24.125`, путь `/opt/wishlist`
- Ключ: `~/.ssh/vultr_wishlist` (ed25519)
- Локальный SSH-алиас: `Host vultr` в `~/.ssh/config` → `ssh vultr` эквивалентно `ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125`
- Manual deploy: `ssh vultr "cd /opt/wishlist && git pull origin main && docker compose -f docker-compose.prod.yml up -d --build"`

**Почему не SSH по умолчанию**: GitHub Actions даёт audit trail и единый путь деплоя/ops. SSH остаётся fallback для аварий и ручной диагностики.

### 3.4. Persistent file logs

API и bot пишут в stdout (для `docker logs`) **и** в ротируемый JSON-файл на bind-mount хоста — переживают `up -d`:

- `/opt/wishlist/logs/api/api.log.YYYY-MM-DD`
- `/opt/wishlist/logs/bot/bot.log.YYYY-MM-DD`
- Ротация: pino-roll, daily, 100 MB cap, 14 файлов (~1.4 GB/service worst case)
- Чтение: `download-file` action, либо `ssh 199.247.24.125 'jq -c "select(.level >= 50)" /opt/wishlist/logs/api/api.log.2026-04-18 | head'`
- Killswitch: пустой `LOG_FILE_PATH_API=` или `LOG_FILE_PATH_BOT=` в `/opt/wishlist/.env` → fallback на stdout-only

---

## 4. Post-deploy health check — ОБЯЗАТЕЛЬНО после каждого деплоя

**Запуск**: `gh workflow run admin-ops.yml -R brsvdmtr/wishlist -f action=health-check`

Эквивалент (через ssh, если actions недоступны):

```bash
# 1. Failed migrations (ожидается 0 строк)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;"

# 2. API health
curl -s http://localhost:3001/health   # → {"ok":true}

# 3. Все контейнеры Up
docker ps --filter name=wishlist-prod --format '{{.Names}} {{.Status}}'

# 4. Bot heartbeat (updatedAt свежий)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  'SELECT * FROM "ServiceHeartbeat" ORDER BY "updatedAt" DESC LIMIT 1;'

# 5. Lifecycle touches не stale (последний < 2 дней)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  'SELECT MAX("sentAt") FROM "LifecycleTouch";'

# 6. Error event spike (24ч)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT event, COUNT(*) FROM \"AnalyticsEvent\" WHERE event LIKE 'error:%' AND \"createdAt\" >= NOW() - INTERVAL '1 day' GROUP BY event ORDER BY count DESC;"
```

Если (1) фейлит — `gh workflow run admin-ops.yml -f action=resolve-migration -f migration_name=<name>`.

---

## 5. Telegram connectivity on Vultr

**Исторический контекст**: на старом российском VPS РКН блокировал TCP к `149.154.166.110:443` (единственный IPv4 `api.telegram.org`). На Vultr Docker IPv4 к Telegram работает, а container IPv6 недоступен, поэтому production использует `DNS_RESULT_ORDER=ipv4first`.

**Текущая политика**:
- API получает `DNS_RESULT_ORDER=${DNS_RESULT_ORDER:-ipv4first}` из `docker-compose.prod.yml`.
- Bot больше не форсит `ipv6first`; на Vultr он использует рабочий IPv4.
- Если Telegram снова ломается, сначала проверять из контейнера: DNS order, outbound IPv4 к `api.telegram.org:443`, затем только IPv6.

---

## 6. API security — iron rules для новых state-changing routes

Контракт целиком: [`docs/API_SECURITY.md`](docs/API_SECURITY.md). Wave 1 (P0) — live. Santa / Categories / Hints / Subscriptions — Wave 2.

### Iron rules (на каждый PR, который трогает `/tg/*` или `tgFetch`)

1. **Каждый новый state-changing route** (POST/PATCH/DELETE на `/tg/*`) должен взять rate-limit категорию из [`apps/api/src/security/rateLimits.ts`](apps/api/src/security/rateLimits.ts) (18 штук). Новую заводить только если ничего не подходит — задокументировать в `docs/API_SECURITY.md` § 5.
2. **Critical routes** (billing, account-deleting, болезненные для дедупа) — idempotency с `critical: true`. **Soft-require**: middleware не 400 на отсутствующий хедер; логирует `api.idem_missing_on_critical_endpoint`.
3. **Mini App caller `tgFetch`** для state-changing — обязательно `idempotency: { action: '<name>' }`. Исключение: telemetry-маяки (mark-as-read, attribution beacon).
4. **Action-key naming**: `domain.verb` для синглетонов (`wishlist.create`), `domain.verb:${entityId}` для entity-scoped, sorted-IDs join для bulk. Разные операции на одной строке — разные action-имена (`me.profile` ≠ avatar upload).
5. **НИКОГДА не логировать сырой `Idempotency-Key` или сырой client IP**. `hashIdempotencyKey` / `hashIp` (server), `hashKeyForLog` (client).
6. **НИКОГДА не отключать security в коде**. Только env kill switches: `SECURITY_IDEMPOTENCY_ENABLED`, `SECURITY_RATE_LIMIT_ENABLED`, `SECURITY_IP_THROTTLE_ENABLED` в `/opt/wishlist/.env`.

### Rollout discipline (lessons from Wave 1)

- **Soft-require, никогда hard-require на rollout**. Hard-require ломает кэшированные Mini App в Telegram WebView, скрипты, бот, старые клиенты.
- **Каждый новый defensive layer = env kill switch** (defaults: prod=true).
- **Fail-open** если новая система сама ошиблась (DB down при idempotency lookup) — log + pass through, не 5xx легитимный запрос.
- **Stage rollout**: backend accepts → deploy → observe → frontend начинает слать → observe → потом разговор про hard-require (probably never).
- **Observation cadence**: 2–3 проверки/день в течение 24–48 ч после деплоя. Не каждые 5 мин — это шум. Стандартный 3-command kit — `docs/API_SECURITY.md` § 11.
- **Wave-by-wave**: P0 первая, потом пауза, потом Wave 2. «Looks good» — это ровно тот момент, когда субтильные баги ещё latent, пауза даёт им время всплыть.

### НЕ делать рефакторинги «по пути» в `apps/api/src/index.ts`

19.6k строк. Любая инкрементальная чистка раздувает diff. Только то, что требуется для security-изменения. Если нашёл rot — оставь, заведи отдельную задачу.

---

## 7. Дизайн-система — iron rules для UI-работы

### Источники истины (по убыванию авторитета)

1. `packages/ui-tokens/src/*.ts` — TS токены (v2.1)
2. `packages/ui/src/*.tsx` — React-примитивы
3. `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html` — обязательный мокап (approved 2026-04-21). `v2-*.html` — approved-secondary для незатронутых поверхностей
4. `.claude/skills/wishboard-design/` — bundle-зеркало (drop-in `colors_and_type.css` для не-React, плюс v2 archive в `preview/` и `ui_kits/miniapp/` — НЕ копировать оттуда hex, это до v2.1)

**Источник истины — репо. Если bundle расходится с репо → правим bundle.**

### Перед любой UI-задачей

1. Прочитать [`docs/design-system/UI_IMPLEMENTATION_RULES.md`](docs/design-system/UI_IMPLEMENTATION_RULES.md).
2. Проверить [`docs/design-system/COMPONENT_REGISTRY.md`](docs/design-system/COMPONENT_REGISTRY.md) — статусы (`canonical` / `provisional` / `legacy` / `deprecated`). Присутствие в коде ≠ canonical.
3. Открыть мокап в [`docs/design-system/mockups/approved/`](docs/design-system/mockups/approved). `proposed/` — input, не реализовывать. `current-prod/` — reference.

### Iron rules (нарушать нельзя)

- **Никаких raw hex / rgba / магических spacing/radius / arbitrary Tailwind values** в новом коде. Вытаскивать из `@wishlist/ui-tokens`. Если значения нет — **сначала** добавить semantic token.
- **Никаких feature-local клонов примитивов**. Импортировать из `@wishlist/ui`:
  ```ts
  import { Button, Card, Sheet, SectionHeader, ListRow, Banner } from '@wishlist/ui';
  ```
- **Migrate on touch**: любой UI-регион должен уйти чище, чем пришёл — inline → токены, hand-rolled → примитивы.
- **Tap targets ≥ 44 × 44**. `Button md`/`lg` уже соответствуют. Icon-only — explicit min size + `aria-label`.
- **default / pressed / disabled / loading / error** — у каждой интерактивной поверхности. Happy-path-only PR не мерджится.
- **Motion**: `transition.*` / `animation.*` токены. `prefers-reduced-motion` обработан в `globals.css` — не оверрайдить.
- **Legacy ≠ canonical**. Паттерны в `MiniApp.tsx` (30k строк) — НЕ спецификация. Если не в `packages/ui` или `docs/design-system/COMPONENTS.md` — это legacy.
- **Перед любым inline `style={{...}}` или hex** — grep `packages/ui-tokens/src/`. Если нет — поднять gap.
- **Перед любым JSX-блоком, похожим на примитив** — проверить `packages/ui/src/index.ts`. Если есть — импортить.
- **Перед "match the mockup"** — открыть конкретный HTML из `mockups/approved/`. Не угадывать.
- **Status changes** примитива/токена → обязательно entry в [`docs/design-system/DESIGN_DECISIONS.md`](docs/design-system/DESIGN_DECISIONS.md). Не менять тихо.

### «Никакой самодеятельности» для отсутствующих элементов

Если нужного примитива/токена/паттерна **нет** в дизайн-системе:

1. **Стоп.** Не инлайнить.
2. HTML-мокап в `docs/design-system/mockups/proposed/` (inline CSS — см. § 7.5).
3. Сообщить пользователю про gap и **ждать явного апрува**.
4. Только после апрува: перенос в `approved/`, запись в `DESIGN_DECISIONS.md`, потом примитив в `packages/ui/` (`provisional` статус) / токен в `packages/ui-tokens/`.

### DRAFT-first для design-direction артефактов

Для vision / North Star / target concept / любого strategic visual-direction документа:

1. Создать как **DRAFT** с датой в шапке.
2. **Стоп**. Никакого продолжения (Toast extraction, миграция примитивов, Storybook setup, мокап approval, canonical promotion).
3. Ждать правок и явного апрува.
4. Только после апрува — продолжаем имплементацию, **переоценив старые планы** против утверждённого vision.

Что безопасно делать в ожидании: governance / processes / audit infra (PROMOTION_CHECKLIST, registry-поля, audit-script). Promote provisional → canonical нельзя.

### Feature audit перед мокапами

WishBoard сильно больше, чем выглядит — **~48 экранов, 3 home-таба, 15 upsell контекстов, 19 PRO-фич**. Перед визуальной работой:

- Проверить [`docs/design-system/FEATURE_INVENTORY.md`](docs/design-system/FEATURE_INVENTORY.md). Если старее 2 мес. — пере-аудит.
- Mental inventory: 3 home-таба (`wishlists` / `wishes` / `reservations`), wishlist owner vs guest, wish owner vs guest, paywall × 15 контекстов, Santa, group gifts, showcase profile, secret reservations, smart reservation TTL, categories, don't-gift preferences, curated selection share, link management, gift calendar / notes, referral, reservation PRO.
- Grep `type Screen` / `setScreen` / `UpsellContext` в `MiniApp.tsx` для сверки.
- Сначала озвучить набор поверхностей и дать пользователю расставить приоритеты — не угадывать scope.

### Mockup → код: stub для отсутствующего бэкенда

Если в одобренном мокапе есть UI для функционала, которого ещё нет в коде — **рисовать UI как нарисовано** и вешать `onClick` на toast «Скоро будет доступно» / «Появится в ближайшем обновлении» / эквивалент. **НЕ пропускать UI** «потому что фичи нет».

- Только тост — никаких "(soon)" badge'ов или серых состояний (если мокап явно не показывает).
- Не гейтить FREE/PRO без явного lock-icon в мокапе.
- Phase 4/5 backend-работа потом заменит stub'ы реальными хендлерами.

### Multi-wave UI — два режима, разная политика

**(а) Adoption waves** одиночных примитивов (Button Wave 1 → Banner Wave 1 → ...) — **пауза обязательна**:
- Между волнами: `migrate → deploy → user observes → user reports → next wave`.
- После PR-а волны — стоп. Готовить препы для следующей можно, трогать примитивы / call-sites — нельзя.
- Ждать структурный сигнал (паттерн: «Option B. Feels X. Go Banner.»).

**(б) Approved multi-wave redesign** (например, v2.1 refresh) — **НЕ делать паузу**:
- Идти по плану, коммитить + пушить каждую волну, post-deploy check, СРАЗУ следующая.
- Пользователь сам мониторит прод — это и есть live observation.
- Пауза только если регрессия / явный пинг / продуктовая неоднозначность.
- Каждая волна — отдельный коммит / реверсируемая единица.

### HTML мокапы — всегда inline CSS

Любой `.html` мокап / vision-концепт / design-system-демо — inline `<style>`, **никогда** `<link rel="stylesheet">`. VS Code Launch Preview через `file://` молча не загружает внешний CSS — рендерится Times-New-Roman, и пользователь сообщит об этом первым.

Дублирование 100–500 строк токенов на файл — это фича (self-contained), не баг.

### UI audit baseline

```bash
pnpm ui:audit
```

Считает inline-styles, hex, уникальные radius/spacing/shadow в монолите. Цель: монотонное снижение. UI PR, повышающий count в уже мигрированном файле, отклоняется.

### Карта дизайн-системы

- [`packages/ui-tokens/`](packages/ui-tokens) — токены (colors, spacing, radius, shadows, motion, typography, z-index, sizing, gradients, safe-area, breakpoints)
- [`packages/ui/`](packages/ui) — примитивы (Button, Card, Sheet, SectionHeader, ListRow, Banner)
- [`docs/design-system/README.md`](docs/design-system/README.md) — индекс
- [`docs/design-system/UI_IMPLEMENTATION_RULES.md`](docs/design-system/UI_IMPLEMENTATION_RULES.md) — strict contract
- [`docs/design-system/FOUNDATIONS.md`](docs/design-system/FOUNDATIONS.md) — token scales + принципы
- [`docs/design-system/COMPONENTS.md`](docs/design-system/COMPONENTS.md) — когда что использовать
- [`docs/design-system/SCREEN_PATTERNS.md`](docs/design-system/SCREEN_PATTERNS.md) — recurring layouts
- [`docs/design-system/INTERACTION_SYSTEM.md`](docs/design-system/INTERACTION_SYSTEM.md) — motion / toasts / feedback
- [`docs/design-system/MIGRATION_PLAYBOOK.md`](docs/design-system/MIGRATION_PLAYBOOK.md) — legacy → primitives
- [`docs/design-system/COMPONENT_REGISTRY.md`](docs/design-system/COMPONENT_REGISTRY.md) — статусы
- [`docs/design-system/DESIGN_DECISIONS.md`](docs/design-system/DESIGN_DECISIONS.md) — лог решений
- [`docs/design-system/FEATURE_INVENTORY.md`](docs/design-system/FEATURE_INVENTORY.md) — карта поверхностей
- [`docs/design-system/mockups/`](docs/design-system/mockups) — `current-prod` / `proposed` / `approved`
- [`.claude/skills/wishboard-design/`](.claude/skills/wishboard-design) — bundle-зеркало (читается напрямую как обычный markdown / HTML)

### Governance

- **Status model**: `legacy` / `provisional` / `canonical` / `deprecated`. Exists-in-code ≠ canonical.
- **Mockup buckets**: `current-prod/` (reference), `proposed/` (candidates), `approved/` (binding).
- **Phase-1 примитивы** (Button, Card, Sheet, SectionHeader, ListRow, Banner) — `provisional` (по состоянию на 2026-04-17). Не считать canonical: это extraction-from-current-prod, не approved-future-state.
- **Approval = explicit act**, лог в `DESIGN_DECISIONS.md`. Move мокапа в `approved/` только вместе с лог-entry.

---

## 8. Notifications & privacy — iron rules

### Аудитория уведомлений — только explicit relationships

Кому бот шлёт уведомления о чужой активности (день рождения, новый wishlist и т.д.) — **только** пользователи с явной opt-in связью:
- `ProfileSubscription`, `WishlistSubscription`
- `ReservationMeta.userId` для items в публичных wishlist'ах субъекта
- `Comment.userId` для items в публичных wishlist'ах субъекта

**НЕ использовать**: историю просмотров профиля, просмотров wishlist'а, share-link клики, любые passive/неподтверждённые сигналы.

«User A глянул профиль B → бот уведомляет A о дне рождения B» = жуть и спам. Explicit-связь = взаимный сигнал, recipient сам что-то сделал.

«EXTENDED»-аудитория допустима, но всё равно ограничена явными актами (например, share-link click — только если кликнули **залогиненными**, не голые open'ы).

### Sensitive data → explicit opt-in sheet

После того как юзер впервые сохранил sensitive поле (birthday, location, phone), **сразу** показать opt-in Sheet:

- Default toggle = `false`
- CTA: «Включить» / «Не сейчас» / «Подробнее»
- Track `*_optin_shown` / `*_optin_accepted` / `*_optin_dismissed`
- Не повторять при каждом редактировании — флаг `seenAt` в профиле
- Downgrade с Pro: данные сохраняются (DB), но reactivation требует явного toggle

«Заполнить профиль» ≠ «уведомлять подписчиков». Implicit opt-in на основе наличия данных нарушает ожидание.

### Pro-only settings — must error, не silent-save

Free user → Pro-only setting → `HTTP 402 { error: 'pro_required', context: '<feature_key>' }`. Frontend показывает paywall с этим контекстом.

- Zod-валидация принимает поле, но business logic чекает entitlement до persist
- Naming: `{feature}_{tier}` — `birthday_reminders_advanced`, `calendar_pro` и т.п.
- В UI: гейтить input behind PRO-бейдж → tap показывает paywall. Не давать заполнять и отбрасывать.
- Существующие валидные Pro-настройки сохраняются на downgrade (DB), но resolution layer трактует их как inactive (`pro_required` reason).

«Saved but not active» создаёт ghost-настройки — юзер думает, что фича работает, она silently no-op'ит. Никогда не видит paywall, не конвертится.

---

## 9. Debugging discipline — корневая дисциплина дебага

На каждый баг-фикс или behaviour-change:

- **Не лечить симптом до выяснения root cause.**
- **Чинить в owner-слое (source-of-truth)**, а не там, где симптом проявился.
- **Избегать child-layer compensation** (фоллбэки, патчи, дублированная логика, бранчи).
- Перед фиксом — **ultra-deep system research end-to-end**:
  - top-down: route → page → container → orchestration → state
  - bottom-up: function → hook → service → API → DB
- Диагностика по слоям: data/contracts → business logic → async/timing → UI state → integration → architecture.
- Если баг в child — сначала смотреть parent/owner слой.
- При смене механики — выровнять все coupled-слои: contracts, handlers, queries, cache, serializers, loading/error.
- Скептично относиться к one-file fix'ам — обосновать, почему другие слои не затронуты.
- Frontend-баги: route → layout → page → hooks → API → backend.
- Системный фикс предпочтительнее, но — пропорционально. Re-architecture только с явным scope / risk / compatibility / rollout-планом.

### BUGFIX_LESSONS.md — после каждого фикса

Запись в [`docs/BUGFIX_LESSONS.md`](docs/BUGFIX_LESSONS.md) по схеме:

1. **Ошибка** — симптом + root cause
2. **Урок** — что выяснилось при диагнозе
3. **Правило** — что делать впредь
4. **Лучший код** — минимальный before/after diff (не полный листинг)

---

## 10. Workflow / коммуникация

- **Прогресс по-русски на каждом milestone** в multi-step тасках. Одно предложение, не на каждый tool-call: «Закончил X, перехожу к Y.» Для one-shot — не нужно.
- **Не коммитить без запроса**. Коммит только когда пользователь явно просит.
- **Деплой = `git push` в `main`** автоматически триггерит сборку. Не запрашивать апрув повторно.
- **После каждого деплоя — health-check** (§ 4).
- Каждый PR / commit, который трогает **API routes** или `tgFetch` callers → iron rules § 6.
- Каждое **UI-изменение** → iron rules § 7.
- Каждый **bug fix** → запись в `BUGFIX_LESSONS.md` (§ 9).

---

## 11. Карта документации

- [`docs/INDEX.md`](docs/INDEX.md) — оглавление
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/BACKEND_MAP.md`](docs/BACKEND_MAP.md), [`docs/FRONTEND_MAP.md`](docs/FRONTEND_MAP.md), [`docs/FRONTEND_API_MAP.md`](docs/FRONTEND_API_MAP.md)
- [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md), [`docs/API_SECURITY.md`](docs/API_SECURITY.md)
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md), [`docs/USER_FLOWS.md`](docs/USER_FLOWS.md)
- [`docs/MONETIZATION.md`](docs/MONETIZATION.md), [`docs/SETTINGS_AND_PRIVACY.md`](docs/SETTINGS_AND_PRIVACY.md)
- [`docs/SANTA_ARCHITECTURE.md`](docs/SANTA_ARCHITECTURE.md), [`docs/ONBOARDING_AND_ACTIVATION.md`](docs/ONBOARDING_AND_ACTIVATION.md)
- [`docs/TELEGRAM_FLOW.md`](docs/TELEGRAM_FLOW.md), [`docs/LINK_IMPORT.md`](docs/LINK_IMPORT.md)
- [`docs/WEB_EXPANSION_AND_AUTH_MODEL.md`](docs/WEB_EXPANSION_AND_AUTH_MODEL.md)
- [`docs/DEPLOYMENT_RUNBOOK.md`](docs/DEPLOYMENT_RUNBOOK.md), [`docs/INFRA_AND_ENV.md`](docs/INFRA_AND_ENV.md)
- [`docs/RECOVERY_RUNBOOK.md`](docs/RECOVERY_RUNBOOK.md), [`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md), [`docs/MASTER_RESTORE_GUIDE.md`](docs/MASTER_RESTORE_GUIDE.md)
- [`docs/BACKUP_CHECKLIST.md`](docs/BACKUP_CHECKLIST.md), [`docs/CRITICAL_BACKUP_ACTIONS.md`](docs/CRITICAL_BACKUP_ACTIONS.md)
- [`docs/WEEKLY_OPS_CHECKLIST.md`](docs/WEEKLY_OPS_CHECKLIST.md), [`docs/OPERATIONS_RUNBOOK_LIGHT.md`](docs/OPERATIONS_RUNBOOK_LIGHT.md)
- [`docs/ANALYTICS_AND_GODMODE.md`](docs/ANALYTICS_AND_GODMODE.md), [`docs/ACCESS_MATRIX.md`](docs/ACCESS_MATRIX.md)
- [`docs/CURRENT_PRODUCT_STATE.md`](docs/CURRENT_PRODUCT_STATE.md), [`docs/KNOWN_GAPS_AND_RISKS.md`](docs/KNOWN_GAPS_AND_RISKS.md)
- [`docs/BUGFIX_LESSONS.md`](docs/BUGFIX_LESSONS.md), [`docs/CHANGELOG_DOCS.md`](docs/CHANGELOG_DOCS.md)

Дизайн-система — см. § 7.

---

## 12. Что НЕ делать никогда (TL;DR)

1. **НЕ запускать** браузерный preview / dev-server для верификации UI — Telegram Mini App.
2. **НЕ коммитить и не деплоить без явного запроса**.
3. **НЕ деплоить через SSH** в первую очередь — `gh workflow run` или `git push`.
4. **НЕ пропускать post-deploy health-check** после деплоя.
5. **НЕ инлайнить hex / rgba / магические числа** в UI.
6. **НЕ клонировать примитивы локально** — импорт из `@wishlist/ui`.
7. **НЕ внедрять новый UI-элемент** без мокапа в `proposed/` + явного апрува.
8. **НЕ promotить provisional → canonical** без апрува vision-документа.
9. **НЕ делать рефакторинги «по пути»** в `apps/api/src/index.ts` (19.6k строк).
10. **НЕ хардкодить security как required** на rollout — soft-require + env kill switch.
11. **НЕ логировать сырой Idempotency-Key или client IP** — только хеши.
12. **НЕ слать уведомления** на passive view-историю — только explicit relationships.
13. **НЕ silent-save Pro-only настройки** для Free user — 402 + paywall context.
14. **НЕ лечить симптом** без поиска root cause в owner-слое.
15. **НЕ забывать запись в `BUGFIX_LESSONS.md`** после каждого фикса.

---

## 13. Cheat sheet — частые команды

```bash
# TS-проверка всех трёх
npx tsc --project apps/web/tsconfig.json --noEmit && \
npx tsc --project apps/api/tsconfig.json --noEmit && \
npx tsc --project apps/bot/tsconfig.json --noEmit

# Prisma client
pnpm --filter @wishlist/db exec prisma generate --schema=packages/db/prisma/schema.prisma

# Тесты
pnpm test

# UI audit
pnpm ui:audit

# Health check на проде
gh workflow run admin-ops.yml -R brsvdmtr/wishlist -f action=health-check

# Логи api за последние 200 строк с grep
gh workflow run admin-ops.yml -R brsvdmtr/wishlist \
  -f action=tail-logs -f log_service=api -f log_lines=200 -f log_grep='err|Error'

# Live логи bot за 2 мин
gh workflow run admin-ops.yml -R brsvdmtr/wishlist \
  -f action=watch-logs -f log_service=bot -f watch_duration_sec=120 -f log_grep='err|Error|ETIMEDOUT'

# Restart API без пересборки
gh workflow run admin-ops.yml -R brsvdmtr/wishlist \
  -f action=restart-service -f restart_target=api

# SQL на проде ($$...$$ для строк, чтобы избежать quote-hell)
gh workflow run admin-ops.yml -R brsvdmtr/wishlist \
  -f action=run-sql \
  -f sql_query='SELECT COUNT(*) FROM "User" WHERE "createdAt" >= NOW() - INTERVAL $$1 day$$;'

# Resolve миграции
gh workflow run admin-ops.yml -R brsvdmtr/wishlist \
  -f action=resolve-migration -f migration_name=20260418_add_xyz

# Edit env var на сервере
gh workflow run admin-ops.yml -R brsvdmtr/wishlist \
  -f action=edit-env-var -f env_key=SECURITY_RATE_LIMIT_ENABLED -f env_value=false

# Получить run id и watch
RUN=$(gh run list -R brsvdmtr/wishlist --workflow=admin-ops.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN -R brsvdmtr/wishlist --exit-status
gh run view $RUN -R brsvdmtr/wishlist --log | grep 'out:' | tail -40
```
