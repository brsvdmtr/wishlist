/* Calendar feature — Entry / Paywall / Onboarding screens */

/* =================================================================
 * SCREEN — Locked state on /events tab (free user, first time)
 * Faded mock calendar behind a glass card pitching the feature.
 * ================================================================= */
function CalLocked() {
  return (
    <Phone label="Locked · free user">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="События"
        subtitle="декабрь 2025"
        right={<HeaderBtn icon={Glyph.add} />}
      />
      <div className="wb-scroll" style={{position:'relative'}}>
        {/* faded calendar behind */}
        <div className="cal-faded">
          <div className="wb-cal-view-toggle">
            <div className="wb-cal-view-opt active">Месяц</div>
            <div className="wb-cal-view-opt">Неделя</div>
            <div className="wb-cal-view-opt">Список</div>
          </div>
          <div className="wb-cal-weekdays">
            {['пн','вт','ср','чт','пт','сб','вс'].map((w,i) => (
              <div key={w} className={`wb-cal-wd${i>=5?' we':''}`}>{w}</div>
            ))}
          </div>
          <div className="wb-cal-grid">
            {Array.from({length:35}).map((_,i) => {
              const d = i - 0;
              const out = d < 1 || d > 31;
              const isToday = d === 19;
              const cls = out ? 'out' : (isToday ? 'today' : (d===22||d===16||d===31 ? 'event' : ''));
              return <div key={i} className={`wb-cal-cell ${cls}`}>{out?'':d}</div>;
            })}
          </div>
        </div>

        {/* lock overlay */}
        <div className="cal-lock-overlay">
          <div className="cal-lock-card">
            <div className="cal-lock-badge">★ PRO</div>
            <h3 className="cal-lock-title">Подарочный календарь</h3>
            <p className="cal-lock-sub">
              Дни рождения, годовщины, праздники — в одном месте. С идеями подарков и напоминаниями за 7 дней.
            </p>
            <div className="cal-lock-pill">
              <span className="strike">59 ⭐</span>
              <span>19 ⭐ ≈ 35 ₽</span>
              <span style={{opacity:.7, fontWeight:600}}>· навсегда</span>
            </div>
            <button className="wb-btn primary">Разблокировать</button>
          </div>
        </div>
        <NavBar active="events" />
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Paywall (full / scrollable)
 * Big hero, social proof stats, feature list, demo preview, FAQ, CTA
 * ================================================================= */
function CalPaywallFull() {
  return (
    <Phone label="Paywall · full">
      <Header
        left={<HeaderBtn icon={Glyph.close} />}
        title=""
      />
      <div className="wb-scroll" style={{paddingBottom:170}}>
        <div className="cal-paywall-hero">
          <div className="cal-paywall-glyph">▦</div>
          <div className="cal-paywall-eyebrow">Подписка · единоразово</div>
          <h1 className="cal-paywall-h1">Не забывайте<br/>о тех, кто важен</h1>
          <p className="cal-paywall-sub">Подарочный календарь напомнит о днях рождения и подскажет, что подарить.</p>
          <div className="cal-paywall-price-row">
            <div className="cal-paywall-price-now">19<sup>⭐</sup></div>
            <div className="cal-paywall-price-old">59 ⭐</div>
            <div className="cal-paywall-price-tag">−68%</div>
          </div>
        </div>

        <div className="cal-stat-row">
          <div className="cal-stat-cell"><div className="cal-stat-n">2 400+</div><div className="cal-stat-l">пользователей</div></div>
          <div className="cal-stat-cell"><div className="cal-stat-n">4,9 ★</div><div className="cal-stat-l">в Telegram</div></div>
          <div className="cal-stat-cell"><div className="cal-stat-n">97%</div><div className="cal-stat-l">не забыли д.р.</div></div>
        </div>

        <div className="wb-form-label">Что вы получите</div>
        <div className="wb-feat">
          <div className="wb-feat-ic">🎂</div>
          <div><div className="wb-feat-t">Календарь со всеми датами</div><div className="wb-feat-s">Дни рождения друзей подтянутся автоматически</div></div>
        </div>
        <div className="wb-feat">
          <div className="wb-feat-ic">🔔</div>
          <div><div className="wb-feat-t">Напоминания за 7 / 3 / 1 день</div><div className="wb-feat-s">Push в Telegram, тонкие настройки на каждое событие</div></div>
        </div>
        <div className="wb-feat">
          <div className="wb-feat-ic">💡</div>
          <div><div className="wb-feat-t">Идеи подарков из вишлиста</div><div className="wb-feat-s">К каждому событию — что подарить и сколько стоит</div></div>
        </div>
        <div className="wb-feat">
          <div className="wb-feat-ic">🔁</div>
          <div><div className="wb-feat-t">Повторяющиеся события</div><div className="wb-feat-s">Раз настроили — больше не нужно вспоминать</div></div>
        </div>
        <div className="wb-feat">
          <div className="wb-feat-ic">🎁</div>
          <div><div className="wb-feat-t">Связь с Тайным Сантой и складчиной</div><div className="wb-feat-s">Создавайте события прямо из календаря</div></div>
        </div>

        <div className="cal-preview-tile">
          <div className="cal-preview-tile-head">
            <span>Как это выглядит</span>
            <span className="demo-link">Демо ›</span>
          </div>
          <div className="cal-mini-row">
            <div className="cal-mini-d" style={{background:'linear-gradient(135deg,#F06AB4,#C53F88)'}}>
              <div className="cal-mini-d-d">22</div><div>дек</div>
            </div>
            <div className="cal-mini-body">
              <div className="cal-mini-t">🎉 Ноа — 1 годик</div>
              <div className="cal-mini-s">Семейный праздник</div>
            </div>
            <div className="cal-mini-cd">через 3 дня</div>
          </div>
          <div className="cal-mini-row">
            <div className="cal-mini-d" style={{background:'linear-gradient(135deg,#FBBF24,#D97706)'}}>
              <div className="cal-mini-d-d">16</div><div>дек</div>
            </div>
            <div className="cal-mini-body">
              <div className="cal-mini-t">💍 Годовщина свадьбы</div>
              <div className="cal-mini-s">8 лет вместе · ежегодно</div>
            </div>
            <div className="cal-mini-cd">через 28 дн.</div>
          </div>
          <div className="cal-mini-row">
            <div className="cal-mini-d" style={{background:'linear-gradient(135deg,#34C98A,#1E9765)'}}>
              <div className="cal-mini-d-d">31</div><div>дек</div>
            </div>
            <div className="cal-mini-body">
              <div className="cal-mini-t">🎄 Новый год</div>
              <div className="cal-mini-s">Тайный Санта · 6 человек</div>
            </div>
            <div className="cal-mini-cd">через 12 дн.</div>
          </div>
        </div>

        <div className="wb-form-label">Частые вопросы</div>
        <div className="cal-faq">
          <div className="cal-faq-q">Это разовая оплата или подписка? <span className="chev">⌃</span></div>
          <div className="cal-faq-a">Один раз — навсегда. Никаких ежемесячных списаний.</div>
        </div>
        <div className="cal-faq">
          <div className="cal-faq-q">Можно вернуть деньги? <span className="chev">⌄</span></div>
        </div>
        <div className="cal-faq">
          <div className="cal-faq-q">Откуда берутся даты дней рождения? <span className="chev">⌄</span></div>
        </div>
        <div className="cal-faq">
          <div className="cal-faq-q">Что если я не выберу подарок? <span className="chev">⌄</span></div>
        </div>

        <div style={{height:80}} />
      </div>

      <div className="cal-cta-wrap">
        <button className="wb-btn primary">Купить за 19 ⭐</button>
        <div className="cal-cta-fineprint">Оплата через Telegram Stars · 19 ⭐ ≈ 35 ₽</div>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Paywall (sheet variant — bottom-sheet, faster decision)
 * ================================================================= */
function CalPaywallSheet() {
  return (
    <Phone label="Paywall · sheet">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="События"
        subtitle="декабрь 2025"
      />
      <div className="wb-scroll" style={{position:'relative'}}>
        <div className="cal-faded">
          <div className="wb-cal-view-toggle">
            <div className="wb-cal-view-opt active">Месяц</div>
            <div className="wb-cal-view-opt">Неделя</div>
            <div className="wb-cal-view-opt">Список</div>
          </div>
          <div className="wb-cal-weekdays">
            {['пн','вт','ср','чт','пт','сб','вс'].map((w,i) => (
              <div key={w} className={`wb-cal-wd${i>=5?' we':''}`}>{w}</div>
            ))}
          </div>
          <div className="wb-cal-grid">
            {Array.from({length:35}).map((_,i) => {
              const d = i;
              const out = d < 1 || d > 31;
              return <div key={i} className={`wb-cal-cell ${out?'out':''}`}>{out?'':d}</div>;
            })}
          </div>
        </div>

        <div className="wb-sheet-backdrop open" />
        <div className="wb-sheet open" style={{padding:'24px 20px 28px'}}>
          <div className="wb-sheet-handle" />
          <div style={{display:'flex', justifyContent:'center', marginBottom:14}}>
            <div className="cal-paywall-glyph" style={{width:56, height:56, borderRadius:18, background:'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))', fontSize:28, marginBottom:0}}>▦</div>
          </div>
          <div className="wb-sheet-title">Откройте Подарочный календарь</div>
          <div className="wb-sheet-sub">События, идеи и напоминания. Один раз — навсегда.</div>

          <div style={{display:'flex', alignItems:'baseline', gap:8, justifyContent:'center', marginBottom:18}}>
            <div style={{fontSize:36, fontWeight:800, letterSpacing:'-0.04em', color:'var(--wb-text)'}}>19 ⭐</div>
            <div style={{fontSize:14, color:'var(--wb-text-muted)', textDecoration:'line-through', fontWeight:600}}>59 ⭐</div>
            <div className="wb-chip pro">−68%</div>
          </div>

          <div style={{display:'flex', flexDirection:'column', gap:10, marginBottom:18}}>
            {[
              ['🎂','Все даты в одном месте'],
              ['🔔','Напоминания за 7 / 3 / 1 день'],
              ['💡','Идеи из вишлиста к каждому событию'],
              ['🔁','Повторы и ежегодные события'],
            ].map(([ic,t]) => (
              <div key={t} style={{display:'flex', gap:10, alignItems:'center'}}>
                <div style={{fontSize:18, width:28}}>{ic}</div>
                <div style={{fontSize:14, color:'var(--wb-text)', fontWeight:550, letterSpacing:'-0.01em'}}>{t}</div>
              </div>
            ))}
          </div>

          <button className="wb-btn primary" style={{marginBottom:8}}>Купить за 19 ⭐</button>
          <button className="wb-btn ghost">Сначала посмотреть демо</button>
          <div className="cal-cta-fineprint" style={{marginTop:8}}>Telegram Stars · ≈ 35 ₽ · возврат в течение 24 часов</div>
        </div>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Telegram Stars confirmation (system-style)
 * ================================================================= */
function CalStarsConfirm() {
  return (
    <Phone label="Stars confirm">
      <Header title="" />
      <div className="wb-scroll" style={{display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 24px'}}>
        <div style={{
          width:84, height:84, borderRadius:24,
          background:'linear-gradient(135deg, #FBBF24, #D97706)',
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:42, marginBottom:20,
          boxShadow:'0 14px 36px rgba(251,191,36,0.4), inset 0 1px 0 rgba(255,255,255,0.3)'
        }}>⭐</div>
        <div style={{fontSize:22, fontWeight:700, letterSpacing:'-0.025em', color:'var(--wb-text)', marginBottom:6, textAlign:'center'}}>Покупка через Telegram Stars</div>
        <div style={{fontSize:14, color:'var(--wb-text-secondary)', textAlign:'center', marginBottom:24, lineHeight:1.5}}>WishBoard просит оплатить:<br/><span style={{color:'var(--wb-text)', fontWeight:600}}>Подарочный календарь</span></div>

        <div style={{
          background:'var(--wb-card)', border:'1px solid var(--wb-border)',
          borderRadius:20, padding:'18px 20px', width:'100%', backdropFilter:'blur(14px)', marginBottom:20
        }}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0'}}>
            <span style={{fontSize:13, color:'var(--wb-text-secondary)'}}>Цена</span>
            <span style={{fontSize:15, fontWeight:700, color:'var(--wb-text)', fontFeatureSettings:"'tnum'"}}>19 ⭐</span>
          </div>
          <div style={{height:1, background:'var(--wb-hairline)'}} />
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0'}}>
            <span style={{fontSize:13, color:'var(--wb-text-secondary)'}}>Ваш баланс</span>
            <span style={{fontSize:14, color:'var(--wb-text-secondary)', fontFeatureSettings:"'tnum'"}}>183 ⭐</span>
          </div>
          <div style={{height:1, background:'var(--wb-hairline)'}} />
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0'}}>
            <span style={{fontSize:13, color:'var(--wb-text-secondary)'}}>После покупки</span>
            <span style={{fontSize:14, color:'var(--wb-text)', fontWeight:600, fontFeatureSettings:"'tnum'"}}>164 ⭐</span>
          </div>
        </div>

        <div style={{width:'100%'}}>
          <button className="wb-btn primary" style={{marginBottom:10}}>Подтвердить · 19 ⭐</button>
          <button className="wb-btn ghost">Отмена</button>
        </div>

        <div style={{fontSize:11, color:'var(--wb-text-muted)', textAlign:'center', marginTop:24, lineHeight:1.5, padding:'0 12px'}}>
          Возврат в течение 24 часов. Оплата защищена Telegram.
        </div>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Onboarding (after purchase) — 4 steps
 * ================================================================= */
function CalOnb({ step = 1 }) {
  const data = [
    { e:'🎂', h:'Никогда не забывайте о важных датах', s:'Дни рождения, годовщины, праздники — всё в одном календаре.' },
    { e:'🔔', h:'Напомним заранее', s:'За 7, 3 и 1 день. Гибкая настройка для каждого события.' },
    { e:'💡', h:'Подскажем, что подарить', s:'Идеи из вишлиста человека или подборка под бюджет.' },
    { e:'🚀', h:'Готово!', s:'Календарь подключён. Добавим ваше первое событие?' },
  ];
  const d = data[step-1];
  return (
    <Phone label={`Onboarding · ${step} / 4`}>
      <Header
        left={step > 1 ? <HeaderBtn icon={Glyph.back} /> : <div style={{width:40}} />}
        title=""
        right={step < 4 ? <button style={{background:'none', border:'none', color:'var(--wb-text-muted)', fontSize:13, fontWeight:600, padding:'0 14px'}}>Пропустить</button> : <div style={{width:40}} />}
      />
      <div className="wb-onb">
        <div className="wb-onb-visual">
          <div className="wb-onb-glow" />
          <div className="wb-onb-emoji">{d.e}</div>
        </div>
        <div className="wb-onb-dots">
          {[1,2,3,4].map(n => <span key={n} className={n === step ? 'active' : ''} />)}
        </div>
        <h1>{d.h}</h1>
        <p>{d.s}</p>
        <button className="wb-btn primary">{step < 4 ? 'Дальше' : 'Добавить событие'}</button>
        {step < 4 && <button className="wb-btn ghost" style={{marginTop:6}}>Посмотреть позже</button>}
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Empty state (first paid user)
 * ================================================================= */
function CalEmpty() {
  return (
    <Phone label="Empty (paid)">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="События"
        subtitle="декабрь 2025"
        right={<HeaderBtn icon={Glyph.add} />}
      />
      <div className="wb-scroll">
        <div style={{padding:'40px 24px 12px', textAlign:'center'}}>
          <div style={{fontSize:84, marginBottom:18, filter:'drop-shadow(0 14px 30px var(--wb-accent-shadow))'}}>📅</div>
          <h2 style={{fontSize:22, fontWeight:700, letterSpacing:'-0.025em', color:'var(--wb-text)', margin:'0 0 8px'}}>Календарь пуст</h2>
          <p style={{fontSize:14, color:'var(--wb-text-secondary)', margin:'0 0 22px', lineHeight:1.5, letterSpacing:'-0.005em'}}>
            Добавьте важную дату или импортируйте дни рождения друзей из WishBoard.
          </p>
          <div style={{display:'flex', flexDirection:'column', gap:8, padding:'0 8px'}}>
            <button className="wb-btn primary">＋ Добавить событие</button>
            <button className="wb-btn surface">↓ Импорт из друзей · 8</button>
          </div>
        </div>

        <div style={{padding:'24px 16px 8px'}}>
          <div className="wb-form-label" style={{margin:'0 4px 10px'}}>Идеи для старта</div>
        </div>

        {[
          { e:'🎂', t:'День рождения мамы', s:'каждый год', c:'#F06AB4' },
          { e:'💍', t:'Годовщина свадьбы', s:'каждый год', c:'#FBBF24' },
          { e:'🎄', t:'Новый год', s:'31 декабря · ежегодно', c:'#34C98A' },
          { e:'🌷', t:'8 марта', s:'весна · ежегодно', c:'#F892C9' },
          { e:'🛡️', t:'23 февраля', s:'зима · ежегодно', c:'#5B8DEF' },
        ].map(it => (
          <div key={it.t} className="wb-event-card" style={{opacity:.92}}>
            <div style={{
              width:54, height:54, borderRadius:14,
              background:`linear-gradient(135deg, ${it.c}, ${it.c}aa)`,
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:24,
              flexShrink:0, boxShadow:'inset 0 1px 0 rgba(255,255,255,0.18)'
            }}>{it.e}</div>
            <div className="wb-event-body">
              <div className="wb-event-t">{it.t}</div>
              <div className="wb-event-s"><span>{it.s}</span></div>
            </div>
            <div style={{
              width:32, height:32, borderRadius:10,
              background:'var(--wb-accent-soft)', border:'1px solid var(--wb-accent-soft-strong)',
              color:'var(--wb-accent-strong)', display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:18, fontWeight:350
            }}>＋</div>
          </div>
        ))}
        <div style={{height:120}} />
        <NavBar active="events" />
      </div>
    </Phone>
  );
}

Object.assign(window, { CalLocked, CalPaywallFull, CalPaywallSheet, CalStarsConfirm, CalOnb, CalEmpty });
