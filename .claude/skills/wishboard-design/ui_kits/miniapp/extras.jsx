/* Extra screens — compact, data-driven, covering all remaining flows from audit.
 * Each screen is rendered from a shared primitive set: FormField, EmptyState, Tabs,
 * ListItem, WishCard state-tints. Keeps inline-styles near zero.
 */

/* ─── PRIMITIVES ─── */
function FormField({ label, hint, children, error }) {
  return (
    <label className="wb-ff">
      {label && <span className="wb-ff-label">{label}</span>}
      {children}
      {hint && !error && <span className="wb-ff-hint">{hint}</span>}
      {error && <span className="wb-ff-error">{error}</span>}
    </label>
  );
}
function FInput(props) { return <input className="wb-ff-input" {...props} />; }
function FTextarea(props) { return <textarea className="wb-ff-input wb-ff-area" {...props} />; }
function FSelect({ children, ...p }) { return <select className="wb-ff-input" {...p}>{children}</select>; }

function EmptyState({ icon = '🎁', title, sub, cta, onCta }) {
  return (
    <div className="wb-empty">
      <div className="wb-empty-ic">{icon}</div>
      <div className="wb-empty-t">{title}</div>
      {sub && <div className="wb-empty-s">{sub}</div>}
      {cta && <button className="wb-btn primary" onClick={onCta}>{cta}</button>}
    </div>
  );
}

function PillTabs({ items, active, onSelect }) {
  return (
    <div className="wb-ptabs">
      {items.map(it => (
        <button key={it.id} className={`wb-ptab ${active === it.id ? 'on' : ''}`} onClick={() => onSelect(it.id)}>
          {it.label}{it.count != null && <span className="wb-ptab-n">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

function ListItem({ ic, title, sub, trail, onClick, tone, toggle, onToggle }) {
  return (
    <div className={`wb-li ${tone || ''}`} onClick={onClick}>
      {ic && <div className="wb-li-ic">{ic}</div>}
      <div className="wb-li-body">
        <div className="wb-li-t">{title}</div>
        {sub && <div className="wb-li-s">{sub}</div>}
      </div>
      {toggle != null
        ? <button className={`wb-toggle ${toggle ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onToggle && onToggle(!toggle); }}><span /></button>
        : trail && <div className="wb-li-trail">{trail}</div>}
    </div>
  );
}

function WishCardTinted({ tone = '', thumb, title, meta, right, line }) {
  return (
    <div className={`wb-wct ${tone}`}>
      {line && <div className="wb-wct-line" />}
      <div className="wb-wct-thumb">{thumb}</div>
      <div className="wb-wct-body">
        <div className="wb-wct-t">{title}</div>
        {meta && <div className="wb-wct-m">{meta}</div>}
      </div>
      {right && <div className="wb-wct-r">{right}</div>}
    </div>
  );
}

/* ─── ITEM DETAIL (Owner + Guest) ─── */
function ItemDetailScreen({ onBack, mode = 'owner' }) {
  const isOwner = mode === 'owner';
  return (
    <Phone>
      <TopBar onBack={onBack} title={isOwner ? 'Моё желание' : 'Желание Анны'} right="⋯" />
      <div className="wb-scroll">
        <div className="wb-item-hero">
          <div className="wb-item-hero-emoji">🎧</div>
          <div className="wb-item-hero-glow" />
        </div>
        <div className="wb-item-body">
          <div className="wb-chip accent" style={{alignSelf:'flex-start', fontSize:10}}>Техника · высокий приоритет 😍</div>
          <h1 className="wb-item-title">AirPods Pro 2 (USB-C)</h1>
          <div className="wb-item-price">24 990 ₽</div>
          <div className="wb-item-desc">В белом, именно с USB-C чехлом. Можно из RU-магазина, подтвердить серийник перед подарком.</div>
          <div className="wb-stats" style={{gridTemplateColumns:'repeat(3,1fr)', margin:0}}>
            <div className="wb-stat"><div className="wb-stat-n">2</div><div className="wb-stat-l">в вишлистах</div></div>
            <div className="wb-stat"><div className="wb-stat-n" style={{color:'var(--wb-success)'}}>1</div><div className="wb-stat-l">{isOwner ? 'бронь' : 'другая бронь'}</div></div>
            <div className="wb-stat"><div className="wb-stat-n">48ч</div><div className="wb-stat-l">TTL</div></div>
          </div>
          {isOwner ? (
            <div className="wb-card-box">
              <ListItem ic="🔗" title="apple.com / product/MTJV3" sub="источник" trail="→" />
              <ListItem ic="🚫" title="Не дарить китайские аналоги" sub="заметка для дарящих" trail="→" />
              <ListItem ic="⏱" title="Smart reservation" sub="48 часов" trail="Изм. ›" />
            </div>
          ) : (
            <div className="wb-banner info">
              <div className="wb-banner-ic">🎁</div>
              <div>Ты можешь забронировать это желание — Анна не узнает кто именно подарок дарит.</div>
            </div>
          )}
          <div className="wb-section-hdr"><h2>{isOwner ? 'Комментарии · 3' : 'Бронь'}</h2></div>
          {isOwner ? (
            <>
              <div className="wb-comment"><div className="wb-av g2" style={{width:28, height:28, fontSize:12}}>Д</div><div><b>Дима</b> · 2ч<br/>а цвет не имеет значения?</div></div>
              <div className="wb-comment"><div className="wb-av g3" style={{width:28, height:28, fontSize:12}}>Т</div><div><b>Ты</b> · 1ч<br/>белые, USB-C чехол обязателен</div></div>
            </>
          ) : (
            <div className="wb-res-box">
              <div>Ты не бронировал это желание</div>
              <div className="wb-res-box-sub">Можно забронировать публично или тайно (PRO)</div>
            </div>
          )}
        </div>
      </div>
      <div className="wb-cta-bar">
        {isOwner
          ? <><button className="wb-btn secondary">Редактировать</button><button className="wb-btn primary">✓ Купить для себя</button></>
          : <><button className="wb-btn secondary">🔒 Тайная бронь</button><button className="wb-btn primary">🎁 Забронировать</button></>
        }
      </div>
    </Phone>
  );
}

/* ─── GIFT NOTES (4) ─── */
function GiftNotesScreen({ onBack, variant = 'main' }) {
  if (variant === 'onboarding') {
    return (
      <Phone>
        <TopBar onBack={onBack} title="Gift notes" />
        <div className="wb-scroll" style={{padding:'40px 20px'}}>
          <EmptyState icon="📝" title="Помни, что подарил" sub="Записывай, что дарил друзьям — чтобы не повториться в следующий раз. Первая заметка — бесплатно." cta="Создать заметку" />
        </div>
      </Phone>
    );
  }
  if (variant === 'paywall') {
    return (
      <Phone>
        <TopBar onBack={onBack} title="Gift notes PRO" />
        <div className="wb-scroll" style={{padding:20}}>
          <div className="wb-pw-hero">
            <div className="wb-pw-emoji">📝</div>
            <h1>История подарков</h1>
            <div className="wb-pw-sub">Безлимит заметок, фото-чеки, теги, напоминания «не повторись»</div>
          </div>
          <ListItem ic="♾️" title="Безлимит заметок" sub="сейчас 1 из 1 использовано" />
          <ListItem ic="📸" title="Фото-чек к заметке" sub="что именно было" />
          <ListItem ic="🏷" title="Теги по событиям" sub="ДР, НГ, свадьбы, just-because" />
          <ListItem ic="🔔" title="Напоминания «не повторись»" sub="при добавлении нового — покажем что дарил" />
        </div>
        <div className="wb-cta-bar"><button className="wb-btn primary">Купить PRO · 290 ₽/мес</button></div>
      </Phone>
    );
  }
  if (variant === 'occasion') {
    return (
      <Phone>
        <TopBar onBack={onBack} title="ДР Анны · 2025" sub="3 заметки" right="⋯" />
        <div className="wb-scroll">
          <div className="wb-gn-card">
            <div className="wb-gn-date">12 мая 2025</div>
            <div className="wb-gn-title">Chanel Chance 50ml</div>
            <div className="wb-gn-sub">9 800 ₽ · от тебя</div>
            <div className="wb-chip surface" style={{fontSize:10}}>аромат</div>
          </div>
          <div className="wb-gn-card">
            <div className="wb-gn-date">12 мая 2024</div>
            <div className="wb-gn-title">Книга «Щегол» Д. Тартт</div>
            <div className="wb-gn-sub">1 490 ₽ · от тебя</div>
            <div className="wb-chip surface" style={{fontSize:10}}>книга</div>
          </div>
          <div className="wb-gn-card">
            <div className="wb-gn-date">12 мая 2023</div>
            <div className="wb-gn-title">Сертификат Lamoda 5000 ₽</div>
            <div className="wb-gn-sub">от нас с Димой (together)</div>
          </div>
        </div>
        <div className="wb-cta-bar"><button className="wb-btn primary">+ Добавить заметку</button></div>
      </Phone>
    );
  }
  return (
    <Phone>
      <TopBar onBack={onBack} title="Gift notes" right="+" />
      <div className="wb-scroll">
        <PillTabs items={[{id:'all', label:'Все', count:12},{id:'mine', label:'От меня', count:8},{id:'to', label:'Мне', count:4}]} active="all" onSelect={()=>{}} />
        <div className="wb-section-hdr"><h2>2025</h2></div>
        <ListItem ic="🎂" title="ДР Анны" sub="Chanel Chance 50ml · 12 мая" trail="3 ›" />
        <ListItem ic="🎄" title="НГ · семья" sub="термос, книга, носки · 6 янв" trail="3 ›" />
        <div className="wb-section-hdr"><h2>2024</h2></div>
        <ListItem ic="💍" title="Свадьба Оли и Димы" sub="Dyson hairdryer · 24 авг" trail="1 ›" />
        <ListItem ic="🎂" title="ДР Марка" sub="Kindle Paperwhite · 3 авг" trail="1 ›" />
        <ListItem ic="🎂" title="ДР Анны" sub="книга · 12 мая" trail="1 ›" />
      </div>
    </Phone>
  );
}

/* ─── SANTA sub-flows (7) ─── */
function SantaFlowScreen({ onBack, variant }) {
  const title = ({
    create:'Создать кампанию', polls:'Голосования', receiver:'Кого ты даришь',
    chat:'Чат кампании', exclusions:'Правила пар', organizer:'Организатор', join:'Присоединиться',
  })[variant];
  return (
    <Phone>
      <TopBar onBack={onBack} title={title} right={variant === 'organizer' ? '⚙' : null} />
      <div className="wb-scroll">
        {variant === 'create' && <>
          <FormField label="Название"><FInput defaultValue="Санта офис 2025" /></FormField>
          <FormField label="Дата вскрытия" hint="участники узнают пару за час до"><FInput type="datetime-local" defaultValue="2025-12-23T19:00" /></FormField>
          <FormField label="Бюджет подарка"><FInput defaultValue="до 2 000 ₽" /></FormField>
          <FormField label="Правила комментариев">
            <FSelect><option>Все</option><option>Только свои</option><option>Выключить</option></FSelect>
          </FormField>
          <ListItem ic="🚫" title="Правила пар" sub="кто кому точно не дарит" trail="→" />
          <ListItem ic="📝" title="Опросы" sub="спросить у группы про темы" trail="→" />
        </>}
        {variant === 'polls' && <>
          <div className="wb-poll-card">
            <div className="wb-poll-q">Где устроим вскрытие?</div>
            <div className="wb-poll-opt"><span>Офис</span><div className="wb-poll-bar" style={{width:'62%'}} /><b>12</b></div>
            <div className="wb-poll-opt"><span>Бар рядом</span><div className="wb-poll-bar" style={{width:'38%'}} /><b>7</b></div>
            <div className="wb-poll-meta">закрыт · 19 голосов</div>
          </div>
          <div className="wb-poll-card">
            <div className="wb-poll-q">Бюджет подарка?</div>
            <div className="wb-poll-opt"><span>до 1 500 ₽</span><div className="wb-poll-bar" style={{width:'22%'}} /><b>4</b></div>
            <div className="wb-poll-opt active"><span>до 2 000 ₽ ✓</span><div className="wb-poll-bar" style={{width:'68%'}} /><b>13</b></div>
            <div className="wb-poll-opt"><span>до 3 000 ₽</span><div className="wb-poll-bar" style={{width:'10%'}} /><b>2</b></div>
          </div>
          <button className="wb-btn secondary" style={{margin:'0 16px'}}>+ Новый опрос</button>
        </>}
        {variant === 'receiver' && <>
          <div className="wb-santa-reveal">
            <div className="wb-santa-reveal-label">Ты даришь</div>
            <div className="wb-av g2" style={{width:84, height:84, fontSize:32, margin:'14px auto'}}>М</div>
            <div className="wb-santa-reveal-name">Мария С.</div>
            <div className="wb-santa-reveal-sub">Бюджет — до 2 000 ₽</div>
          </div>
          <div className="wb-section-hdr"><h2>Вишлист Марии</h2></div>
          <WishCardTinted tone="accent" thumb="📚" title="«Щегол» Д. Тартт" meta="1 490 ₽" right={<span className="wb-chip accent" style={{fontSize:10}}>в бюджет</span>} line />
          <WishCardTinted thumb="🕯" title="Свеча Diptyque Baies" meta="6 900 ₽ · выше бюджета" />
          <WishCardTinted tone="success" thumb="🧴" title="Набор Sabon" meta="1 890 ₽" right={<span className="wb-chip success" style={{fontSize:10}}>✓ выбрано</span>} line />
        </>}
        {variant === 'chat' && <>
          <div className="wb-gg-msg"><div className="wb-av g1" style={{width:28, height:28, fontSize:11, flexShrink:0}}>О</div><div><div className="wb-gg-author">Оля · орг</div><div className="wb-gg-bubble">Напоминаю: вскрытие в пятницу в 19:00, бар Mitzva.</div></div></div>
          <div className="wb-gg-msg"><div className="wb-av g2" style={{width:28, height:28, fontSize:11, flexShrink:0}}>Д</div><div><div className="wb-gg-author">Дима</div><div className="wb-gg-bubble">А можно вегетарианский стол забронировать?</div></div></div>
          <div className="wb-gg-msg me"><div><div className="wb-gg-bubble">+1 за веган-стол</div></div></div>
          <div className="wb-gg-msg"><div className="wb-av g1" style={{width:28, height:28, fontSize:11, flexShrink:0}}>О</div><div><div className="wb-gg-author">Оля · орг</div><div className="wb-gg-bubble">Забронировала 👍</div></div></div>
          <div style={{height:60}} />
      </>}
        {variant === 'exclusions' && <>
          <div className="wb-banner info">
            <div className="wb-banner-ic">⚙</div>
            <div>Отметь пары, которые не должны дарить друг другу — партнёры, семья, коллеги конфликтующие</div>
          </div>
          <ListItem ic="👥" title="Оля ↔ Дима" sub="партнёры" trail="✓" tone="on" />
          <ListItem ic="👥" title="Анна ↔ Мария" sub="сёстры" trail="✓" tone="on" />
          <ListItem ic="👥" title="Саша ↔ Макс" sub="не указывать" trail="+" />
          <ListItem ic="👥" title="Катя ↔ Марк" sub="не указывать" trail="+" />
          <button className="wb-btn secondary" style={{margin:'8px 16px'}}>+ Новое исключение</button>
        </>}
        {variant === 'organizer' && <>
          <div className="wb-stats" style={{gridTemplateColumns:'repeat(3,1fr)'}}>
            <div className="wb-stat"><div className="wb-stat-n">14</div><div className="wb-stat-l">участников</div></div>
            <div className="wb-stat"><div className="wb-stat-n" style={{color:'var(--wb-success)'}}>12</div><div className="wb-stat-l">подтверждены</div></div>
            <div className="wb-stat"><div className="wb-stat-n" style={{color:'var(--wb-warning)'}}>2</div><div className="wb-stat-l">ожидают</div></div>
          </div>
          <div className="wb-section-hdr"><h2>Действия организатора</h2></div>
          <ListItem ic="🎲" title="Провести жеребьёвку" sub="все подтвердятся — запустишь" trail="→" />
          <ListItem ic="🚫" title="Правила пар" sub="2 исключения" trail="→" />
          <ListItem ic="📝" title="Опросы" sub="2 активных" trail="→" />
          <ListItem ic="💬" title="Написать всем" sub="объявление в чат" trail="→" />
          <ListItem ic="✂" title="Закрыть приём" sub="больше никто не вступит" trail="→" />
          <div className="wb-banner warning" style={{margin:'8px 16px'}}>
            <div className="wb-banner-ic">⚠</div><div>После жеребьёвки изменить участников нельзя.</div>
          </div>
        </>}
        {variant === 'join' && <>
          <div className="wb-join-card">
            <div className="wb-join-emoji">🎅</div>
            <h1>Санта офис 2025</h1>
            <div className="wb-join-sub">Организует Оля · 12 участников · бюджет до 2 000 ₽</div>
          </div>
          <div className="wb-section-hdr"><h2>Что нужно сделать</h2></div>
          <ListItem ic="1️⃣" title="Подтвердить участие" sub="до 18 декабря" trail="✓" tone="on" />
          <ListItem ic="2️⃣" title="Заполнить мини-вишлист" sub="5 желаний в бюджет — помоги санте" trail="→" />
          <ListItem ic="3️⃣" title="Ждать жеребьёвки" sub="23 декабря, 18:00" trail="⏱" />
          <ListItem ic="4️⃣" title="Купить подарок" sub="после вскрытия пары" trail="🎁" />
        </>}
      </div>
      {variant === 'chat' && <div className="wb-gg-chat-input"><input className="wb-gg-input-field" placeholder="Сообщение..." /><button className="wb-gg-send-btn">↑</button></div>}
      {variant !== 'chat' && <div className="wb-cta-bar">
        {variant === 'create' && <button className="wb-btn primary">Создать кампанию</button>}
        {variant === 'receiver' && <button className="wb-btn primary">✓ Сохранить выбор</button>}
        {variant === 'exclusions' && <button className="wb-btn primary">Готово</button>}
        {variant === 'organizer' && <button className="wb-btn primary">🎲 Провести жеребьёвку</button>}
        {variant === 'join' && <button className="wb-btn primary">Подтвердить участие</button>}
      </div>}
    </Phone>
  );
}

/* ─── GROUP GIFT sub-flows (4) ─── */
function GGFlowScreen({ onBack, variant }) {
  const title = ({ paywall:'Group gift PRO', create:'Общий подарок', join:'Присоединиться', chat:'Чат подарка' })[variant];
  return (
    <Phone>
      <TopBar onBack={onBack} title={title} />
      <div className="wb-scroll">
        {variant === 'paywall' && <>
          <div className="wb-pw-hero">
            <div className="wb-pw-emoji">👥</div>
            <h1>Общие подарки</h1>
            <div className="wb-pw-sub">Скидывайтесь группой, следите кто внёс, пишите в чате</div>
          </div>
          <ListItem ic="💳" title="Отслеживание взносов" sub="кто оплатил, сколько осталось" />
          <ListItem ic="💬" title="Встроенный чат" sub="обсудить подарок не покидая приложение" />
          <ListItem ic="🎯" title="Автоматические доли" sub="делим бюджет поровну или кастом" />
          <ListItem ic="📌" title="Pinned-сообщения" sub="реквизиты организатора всегда на виду" />
        </>}
        {variant === 'create' && <>
          <FormField label="Что дарим"><FInput placeholder="Pandora браслет · для Марии" /></FormField>
          <FormField label="Общий бюджет" hint="разделится на участников поровну"><FInput defaultValue="18 900 ₽" /></FormField>
          <FormField label="Срок сбора"><FInput type="date" defaultValue="2025-05-10" /></FormField>
          <div className="wb-section-hdr"><h2>Участники</h2></div>
          <ListItem ic="👤" title="Ты" sub="организатор · 4 725 ₽" trail="✓" tone="on" />
          <ListItem ic="➕" title="Добавить участника" trail="+" />
          <FormField label="Реквизиты для перевода"><FTextarea rows="2" placeholder="Т-Банк 5432 1234 5678" /></FormField>
        </>}
        {variant === 'join' && <>
          <div className="wb-join-card">
            <div className="wb-join-emoji">💍</div>
            <h1>Pandora Rose браслет</h1>
            <div className="wb-join-sub">для Марии · ДР 12 мая · 4 участника</div>
          </div>
          <div className="wb-gg-hero" style={{margin:'0 16px 14px'}}>
            <div style={{fontSize:11, fontWeight:700, color:'var(--wb-accent-light)', textTransform:'uppercase', letterSpacing:0.4}}>твоя доля</div>
            <div style={{fontSize:28, fontWeight:800, letterSpacing:'-0.02em', marginTop:4}}>4 725 ₽</div>
            <div style={{fontSize:12, color:'var(--wb-text-secondary)', marginTop:2}}>из общего бюджета 18 900 ₽</div>
          </div>
          <div className="wb-section-hdr"><h2>Участники · 3 из 4</h2></div>
          <ListItem ic="О" title="Оля · организатор" sub="4 725 ₽ ✓" trail={<span className="wb-chip success" style={{fontSize:10}}>✓</span>} />
          <ListItem ic="Д" title="Дима" sub="4 725 ₽ ✓" trail={<span className="wb-chip success" style={{fontSize:10}}>✓</span>} />
          <ListItem ic="А" title="Анна" sub="ожидаем взнос" trail={<span className="wb-chip surface" style={{fontSize:10}}>·</span>} />
        </>}
        {variant === 'chat' && <>
          <div className="wb-gg-pinned"><div style={{fontSize:16}}>📌</div><div><b>Оля · орг</b><br/>Скидываемся по 4 725 ₽ · Т-Банк 5432… · комм «Pandora Мария»</div></div>
          <div className="wb-gg-msg"><div className="wb-av g2" style={{width:28, height:28, fontSize:11, flexShrink:0}}>Д</div><div><div className="wb-gg-author">Дима</div><div className="wb-gg-bubble">отправил 🚀</div></div></div>
          <div className="wb-gg-msg me"><div><div className="wb-gg-bubble">+1, тоже скинул</div></div></div>
          <div className="wb-gg-msg"><div className="wb-av g1" style={{width:28, height:28, fontSize:11, flexShrink:0}}>О</div><div><div className="wb-gg-author">Оля · орг</div><div className="wb-gg-bubble">Двое пришло, ждём Анну 🙏</div></div></div>
          <div style={{height:60}} />
        </>}
      </div>
      {variant === 'chat'
        ? <div className="wb-gg-chat-input"><input className="wb-gg-input-field" placeholder="Сообщение..." /><button className="wb-gg-send-btn">↑</button></div>
        : <div className="wb-cta-bar">
            {variant === 'paywall' && <button className="wb-btn primary">Купить PRO · 290 ₽/мес</button>}
            {variant === 'create' && <button className="wb-btn primary">Создать и разослать</button>}
            {variant === 'join' && <button className="wb-btn primary">💳 Внести 4 725 ₽</button>}
          </div>}
    </Phone>
  );
}

/* ─── SHOWCASE EDITOR ─── */
function ShowcaseEditorScreen({ onBack }) {
  return (
    <Phone>
      <TopBar onBack={onBack} title="Настройка Showcase" sub="публичный профиль PRO" />
      <div className="wb-scroll">
        <FormField label="Фон обложки"><div className="wb-cover-picker">
          <div className="wb-cov active" style={{background:'linear-gradient(135deg,#8B7BFF,#E85D8E,#F4A261)'}} />
          <div className="wb-cov" style={{background:'linear-gradient(135deg,#34C98A,#8B7BFF)'}} />
          <div className="wb-cov" style={{background:'linear-gradient(135deg,#F04E6E,#F4A261)'}} />
          <div className="wb-cov" style={{background:'linear-gradient(135deg,#0a0a0b,#2a2a2f)'}} />
          <div className="wb-cov upload">+</div>
        </div></FormField>
        <FormField label="Handle" hint="wishboard.app/m/maria.sokolova"><FInput defaultValue="maria.sokolova" /></FormField>
        <FormField label="Bio (до 160 символов)"><FTextarea rows="3" defaultValue="Fashion-редактор, пишу для Vogue Russia. Коллекционирую ароматы и книги о живописи." /></FormField>
        <div className="wb-section-hdr"><h2>Публичные вишлисты</h2></div>
        <ListItem ic="🎂" title="ДР · 12 мая" sub="14 желаний" toggle={true} onToggle={() => {}} />
        <ListItem ic="📚" title="Art & Design" sub="22 желания" toggle={true} onToggle={() => {}} />
        <ListItem ic="🌸" title="Ароматы" sub="9 желаний" toggle={true} onToggle={() => {}} />
        <ListItem ic="🔒" title="ДР Димы · surprise" sub="приватный" toggle={false} onToggle={() => {}} />
        <div className="wb-section-hdr"><h2>Контакты</h2></div>
        <ListItem ic="✉" title="Показать email" sub="m@sokolova.co" toggle={false} onToggle={() => {}} />
        <ListItem ic="💬" title="Показать Telegram" sub="@maria_s" toggle={true} onToggle={() => {}} />
      </div>
      <div className="wb-cta-bar"><button className="wb-btn secondary">Предпросмотр</button><button className="wb-btn primary">Сохранить</button></div>
    </Phone>
  );
}

/* ─── EDGE SCREENS ─── */
function EdgeScreen({ onBack, variant }) {
  const cfg = {
    drafts: { title:'Черновики', empty:{icon:'📋', t:'Нет черновиков', s:'Когда начнёшь добавлять желание и выйдешь — оно сохранится сюда'} },
    archive: { title:'Архив', empty:{icon:'📦', t:'Архив пуст', s:'Архивированные вишлисты и желания появятся здесь'} },
    myReservations: { title:'Мои брони', sub:'что я подарил и бронирую' },
    share: { title:'Поделиться вишлистом', sub:'ДР · 28 апреля' },
    linkManagement: { title:'Ссылки и доступы' },
    curated: { title:'Подборка · Для мамы', sub:'12 желаний от редакции' },
    secretPaywall: { title:'Тайные брони PRO' },
  };
  const c = cfg[variant];
  return (
    <Phone>
      <TopBar onBack={onBack} title={c.title} sub={c.sub} right={variant === 'share' ? '⋯' : null} />
      <div className="wb-scroll">
        {variant === 'drafts' && <>
          <div className="wb-wish"><div className="wb-wish-thumb">🎧</div><div className="wb-wish-body"><div className="wb-wish-t">AirPods Pro…</div><div className="wb-wish-meta">черновик · нет цены</div></div><span className="wb-chip surface" style={{fontSize:10}}>draft</span></div>
          <div className="wb-wish"><div className="wb-wish-thumb">📷</div><div className="wb-wish-body"><div className="wb-wish-t">Плёночный фотик</div><div className="wb-wish-meta">черновик · 2 дня назад</div></div><span className="wb-chip surface" style={{fontSize:10}}>draft</span></div>
          <div className="wb-wish"><div className="wb-wish-thumb">🕯</div><div className="wb-wish-body"><div className="wb-wish-t">Свеча Diptyque</div><div className="wb-wish-meta">черновик · нет описания</div></div><span className="wb-chip surface" style={{fontSize:10}}>draft</span></div>
        </>}
        {variant === 'archive' && <>
          <div className="wb-banner info"><div className="wb-banner-ic">📦</div><div>Элементы в архиве не видны никому кроме тебя. Можно восстановить в любой момент.</div></div>
          <div className="wb-section-hdr"><h2>Вишлисты · 2</h2></div>
          <ListItem ic="🎂" title="ДР 2024" sub="в архиве с 20 мая 2024 · 14 желаний" trail="↺" />
          <ListItem ic="🎄" title="НГ 2023" sub="в архиве с 15 янв 2024 · 8 желаний" trail="↺" />
          <div className="wb-section-hdr"><h2>Желания · 4</h2></div>
          <ListItem ic="🎧" title="AirPods Max" sub="архивировано · была завышенная цена" trail="↺" />
          <ListItem ic="⌚" title="Apple Watch Ultra" sub="архивировано · уже купил себе" trail="↺" />
        </>}
        {variant === 'myReservations' && <>
          <PillTabs items={[{id:'a', label:'Активные', count:4},{id:'h', label:'История', count:12}]} active="a" onSelect={()=>{}} />
          <WishCardTinted tone="accent" thumb="🧣" title="Шарф Acne" meta="Анна · ДР 12 мая · 8 900 ₽" right={<span className="wb-chip accent" style={{fontSize:10}}>публично</span>} line />
          <WishCardTinted tone="accent" thumb="💄" title="Chanel Chance" meta="Мария · surprise" right={<span className="wb-chip accent" style={{fontSize:10}}>🔒 тайно</span>} line />
          <WishCardTinted tone="warning" thumb="📚" title="«Щегол»" meta="Оля · цена изменилась" right={<span className="wb-chip warning" style={{fontSize:10}}>⚠</span>} line />
          <WishCardTinted thumb="🎁" title="Свеча Diptyque" meta="Марк · подарил 5 апр" />
        </>}
        {variant === 'share' && <>
          <div className="wb-share-card">
            <div className="wb-share-qr">▦▦▦</div>
            <div className="wb-share-link">wishboard.app/w/abc1234</div>
            <div className="wb-share-meta">приватный · только по ссылке · surprise mode</div>
          </div>
          <div className="wb-section-hdr"><h2>Режим доступа</h2></div>
          <ListItem ic="🔗" title="По ссылке" sub="выбрано — только у кого есть линк" trail="✓" tone="on" />
          <ListItem ic="👥" title="Друзьям" sub="только фолловерам" />
          <ListItem ic="🌐" title="Публичный" sub="видят все (PRO)" trail="🔒" />
          <div className="wb-section-hdr"><h2>Режим сюрприза</h2></div>
          <ListItem ic="🎭" title="Surprise" sub="владелец не видит, кто забронировал" toggle={true} onToggle={() => {}} />
          <ListItem ic="⏱" title="Smart reservation TTL" sub="48 часов" trail="Изм. ›" />
          <ListItem ic="💬" title="Комментарии" sub="включены" toggle={true} onToggle={() => {}} />
        </>}
        {variant === 'linkManagement' && <>
          <div className="wb-section-hdr"><h2>Активные ссылки</h2></div>
          <ListItem ic="🔗" title="ДР · 28 апреля" sub="14 просмотров · создана 3 апр" trail="⋯" />
          <ListItem ic="🔗" title="НГ семейный" sub="42 просмотра · создана 12 дек" trail="⋯" />
          <ListItem ic="🔗" title="Новоселье" sub="7 просмотров · создана 1 апр" trail="⋯" />
          <div className="wb-section-hdr"><h2>Отозванные</h2></div>
          <ListItem ic="🚫" title="ДР 2024 (старая)" sub="отозвана 20 мая 2024" tone="dim" />
          <div className="wb-banner info" style={{margin:'8px 16px'}}>
            <div className="wb-banner-ic">🛡</div><div>Отзыв ссылки мгновенно закрывает доступ для всех, кто её получил.</div>
          </div>
        </>}
        {variant === 'curated' && <>
          <div className="wb-curated-cover"><div className="wb-curated-title">Для мамы</div><div className="wb-curated-sub">12 идей от редакции · 890 ₽ – 12 000 ₽</div></div>
          <WishCardTinted thumb="🌷" title="Букет тюльпанов" meta="от 2 500 ₽ · Flowwow" right={<span className="wb-chip surface" style={{fontSize:10}}>+</span>} />
          <WishCardTinted thumb="🧴" title="Крем La Mer" meta="9 800 ₽ · Rive Gauche" right={<span className="wb-chip surface" style={{fontSize:10}}>+</span>} />
          <WishCardTinted thumb="🍰" title="Торт Три шоколада" meta="3 400 ₽ · с доставкой" right={<span className="wb-chip surface" style={{fontSize:10}}>+</span>} />
          <WishCardTinted thumb="📖" title="Альбом Моне" meta="3 900 ₽ · литрес" right={<span className="wb-chip surface" style={{fontSize:10}}>+</span>} />
          <WishCardTinted thumb="🎟" title="Билет в Эрмитаж" meta="890 ₽" right={<span className="wb-chip surface" style={{fontSize:10}}>+</span>} />
        </>}
        {variant === 'secretPaywall' && <>
          <div className="wb-pw-hero">
            <div className="wb-pw-emoji">🔒</div>
            <h1>Тайные брони</h1>
            <div className="wb-pw-sub">Бронируй анонимно — владелец не узнает кто и что забронировал</div>
          </div>
          <ListItem ic="👤" title="Анонимная бронь" sub="владелец видит только «забронировано»" />
          <ListItem ic="⚡" title="Conflict-resolution" sub="если публично заняли — один тап вернуть" />
          <ListItem ic="⚠" title="Auto-diff уведомления" sub="владелец правит → покажем diff" />
          <ListItem ic="💳" title="Auto-refund" sub="владелец отметил купленым — бронь снимется" />
          <ListItem ic="🎯" title="5 derived states" sub="ACTIVE · UPDATED · CONFLICT · FULFILLED · UNAVAILABLE" />
        </>}
        {c.empty && variant !== 'drafts' && variant !== 'archive' && <EmptyState icon={c.empty.icon} title={c.empty.t} sub={c.empty.s} />}
      </div>
      <div className="wb-cta-bar">
        {variant === 'share' && <><button className="wb-btn secondary">Скопировать</button><button className="wb-btn primary">Поделиться →</button></>}
        {variant === 'linkManagement' && <button className="wb-btn primary">+ Создать ссылку</button>}
        {variant === 'curated' && <button className="wb-btn primary">Добавить все в вишлист</button>}
        {variant === 'secretPaywall' && <button className="wb-btn primary">Купить PRO · 290 ₽/мес</button>}
        {variant === 'myReservations' && null}
        {variant === 'drafts' && <button className="wb-btn secondary">Очистить всё</button>}
        {variant === 'archive' && null}
      </div>
    </Phone>
  );
}

/* ─── STATIC (FAQ, Changelog, Legal, Referral, first-share) ─── */
function StaticScreen({ onBack, variant }) {
  if (variant === 'faq') return (
    <Phone>
      <StatusBar /><TopBar onBack={onBack} title="FAQ" />
      <div className="wb-scroll">
        <div className="wb-faq-q">Как работает тайная бронь?</div>
        <div className="wb-faq-a">Владелец вишлиста видит, что желание занято, но не видит кто именно забронировал. Доступно в PRO.</div>
        <div className="wb-faq-q">Что такое smart reservation?</div>
        <div className="wb-faq-a">Бронь автоматически освобождается через N часов (по умолчанию 48), если ты не подтвердил покупку. Защищает от «забытых» броней.</div>
        <div className="wb-faq-q">Можно ли подарок от нескольких людей?</div>
        <div className="wb-faq-a">Да — в PRO есть Group Gift. Создаёшь общий сбор, скидываетесь долями, чат внутри.</div>
        <div className="wb-faq-q">Как ссылка отзывается?</div>
        <div className="wb-faq-a">Настройки → Ссылки → ⋯ → Отозвать. Мгновенно закрывает доступ для всех, у кого была ссылка.</div>
        <div className="wb-faq-q">PRO подписка привязана к устройству?</div>
        <div className="wb-faq-a">Нет — к Telegram-аккаунту. Работает на всех устройствах, где ты логинишься.</div>
      </div>
    </Phone>
  );
  if (variant === 'changelog') return (
    <Phone>
      <StatusBar /><TopBar onBack={onBack} title="История версий" />
      <div className="wb-scroll">
        <div className="wb-cl-ver">
          <div className="wb-cl-v">v2.1 · Refresh</div>
          <div className="wb-cl-d">21 апр 2026</div>
        </div>
        <ul className="wb-cl-ul">
          <li>Glass surfaces + mesh gradient</li>
          <li>Тема и акценты (4 цвета, PRO)</li>
          <li>Календарь событий обновлён</li>
        </ul>
        <div className="wb-cl-ver">
          <div className="wb-cl-v">v2.0 · North Star</div>
          <div className="wb-cl-d">19 апр 2026</div>
        </div>
        <ul className="wb-cl-ul">
          <li>Общие подарки (Group Gift)</li>
          <li>Тайные брони с conflict-resolution</li>
          <li>Secret Santa кампании</li>
          <li>Showcase PRO-профили</li>
        </ul>
        <div className="wb-cl-ver">
          <div className="wb-cl-v">v1.8</div>
          <div className="wb-cl-d">12 мар 2026</div>
        </div>
        <ul className="wb-cl-ul">
          <li>Smart reservation с TTL</li>
          <li>Gift Notes (beta)</li>
        </ul>
      </div>
    </Phone>
  );
  if (variant === 'legal') return (
    <Phone>
      <StatusBar /><TopBar onBack={onBack} title="Правовое" />
      <div className="wb-scroll">
        <ListItem ic="📜" title="Пользовательское соглашение" trail="›" />
        <ListItem ic="🔒" title="Политика конфиденциальности" trail="›" />
        <ListItem ic="🍪" title="Cookie & трекинг" trail="›" />
        <ListItem ic="💳" title="Условия подписки" trail="›" />
        <ListItem ic="⚖" title="Возврат средств" trail="›" />
        <ListItem ic="📮" title="Жалобы и модерация" trail="›" />
        <ListItem ic="🏢" title="Реквизиты компании" trail="›" />
      </div>
    </Phone>
  );
  if (variant === 'legalDoc') return (
    <Phone>
      <StatusBar /><TopBar onBack={onBack} title="Соглашение" sub="v3.2 · 12 мар 2026" />
      <div className="wb-scroll">
        <div className="wb-legal-doc">
          <h2>1. Термины</h2>
          <p>«Сервис» — приложение WishBoard, работающее как Telegram Mini App. «Пользователь» — лицо, использующее Сервис.</p>
          <h2>2. Регистрация</h2>
          <p>Регистрация осуществляется через Telegram-аккаунт. Отдельного пароля не требуется.</p>
          <h2>3. Персональные данные</h2>
          <p>Сервис обрабатывает имя и фото из Telegram. Списки желаний — видны только адресатам ссылки.</p>
          <h2>4. Подписка PRO</h2>
          <p>Подписка списывается ежемесячно. Отмена в настройках → Подписка. Доступ к PRO сохраняется до конца оплаченного периода.</p>
          <h2>5. Контент пользователей</h2>
          <p>Ответственность за содержимое вишлистов несёт пользователь. Сервис не модерирует приватные списки.</p>
        </div>
      </div>
    </Phone>
  );
  if (variant === 'referral') return (
    <Phone>
      <StatusBar /><TopBar onBack={onBack} title="Рефералы" sub="история начислений" />
      <div className="wb-scroll">
        <div className="wb-stats" style={{gridTemplateColumns:'repeat(3,1fr)'}}>
          <div className="wb-stat"><div className="wb-stat-n">12</div><div className="wb-stat-l">приглашено</div></div>
          <div className="wb-stat"><div className="wb-stat-n" style={{color:'var(--wb-success)'}}>5</div><div className="wb-stat-l">PRO купили</div></div>
          <div className="wb-stat"><div className="wb-stat-n" style={{color:'var(--wb-accent-light)'}}>4 мес</div><div className="wb-stat-l">бонус PRO</div></div>
        </div>
        <div className="wb-section-hdr"><h2>История</h2></div>
        <ListItem ic="✅" title="Мария С. купила PRO" sub="+1 мес · 12 апр" trail="+1 мес" />
        <ListItem ic="✅" title="Дима К. купил PRO" sub="+1 мес · 3 апр" trail="+1 мес" />
        <ListItem ic="⏱" title="Анна В. — зарегистрировалась" sub="14 мар · ждём подписку" />
        <ListItem ic="✅" title="Оля Н. купила PRO" sub="+1 мес · 2 мар" trail="+1 мес" />
        <ListItem ic="⏱" title="Марк П. — зарегистрировался" sub="28 фев" />
        <ListItem ic="✅" title="Катя С. купила PRO" sub="+1 мес · 15 фев" trail="+1 мес" />
      </div>
      <div className="wb-cta-bar"><button className="wb-btn primary">Позвать ещё друзей</button></div>
    </Phone>
  );
  if (variant === 'firstShare') return (
    <Phone>
      <div className="wb-modal-backdrop">
        <div className="wb-modal-card">
          <div className="wb-modal-emoji">🎉</div>
          <h1>Первый вишлист готов!</h1>
          <div className="wb-modal-sub">Поделись ссылкой с друзьями, чтобы они увидели твои желания и могли забронировать.</div>
          <button className="wb-btn primary">Поделиться сейчас</button>
          <button className="wb-btn ghost" onClick={onBack}>Позже</button>
        </div>
      </div>
    </Phone>
  );
  return null;
}

Object.assign(window, {
  FormField, FInput, FTextarea, FSelect,
  EmptyState, PillTabs, ListItem, WishCardTinted,
  ItemDetailScreen, GiftNotesScreen, SantaFlowScreen, GGFlowScreen,
  ShowcaseEditorScreen, EdgeScreen, StaticScreen,
});
