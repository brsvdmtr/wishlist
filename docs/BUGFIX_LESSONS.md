# Bug-fix Lessons

Structured log of bug fixes — symptom + root cause, lesson, rule, better code.
New entries go at the top.

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
