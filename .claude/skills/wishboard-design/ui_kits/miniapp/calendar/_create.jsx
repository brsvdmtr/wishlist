/* Calendar feature — Create/edit flow, notifications, recap. */

/* =================================================================
 * SCREEN — Create event · type picker (step 1)
 * ================================================================= */
function CalCreateType() {
  return (
    <Phone label="Create · type">
      <Header
        left={<HeaderBtn icon={Glyph.close} />}
        title="Новое событие"
        subtitle="шаг 1 из 4"
      />
      <div className="wb-scroll">
        <div style={{padding:'8px 24px 18px', textAlign:'center'}}>
          <div style={{fontSize:14, color:'var(--wb-text-secondary)', lineHeight:1.5}}>Что отмечаем?</div>
        </div>

        <div className="cal-type-grid">
          <div className="cal-type t-bday active">
            <div className="cal-type-emoji">🎂</div>
            <div className="cal-type-t">День рождения</div>
            <div className="cal-type-s">Свой или чей-то</div>
          </div>
          <div className="cal-type t-ann">
            <div className="cal-type-emoji">💍</div>
            <div className="cal-type-t">Годовщина</div>
            <div className="cal-type-s">Свадьба, отношения</div>
          </div>
          <div className="cal-type t-holiday">
            <div className="cal-type-emoji">🎄</div>
            <div className="cal-type-t">Праздник</div>
            <div className="cal-type-s">Из календаря</div>
          </div>
          <div className="cal-type t-custom">
            <div className="cal-type-emoji">✦</div>
            <div className="cal-type-t">Своё</div>
            <div className="cal-type-s">Любая дата</div>
          </div>
        </div>

        <div className="cal-detail-section-h">Или импортируйте</div>
        <div className="cal-info-group">
          <div className="cal-info-row">
            <div className="ic tinted">◉</div>
            <div style={{flex:1}}>
              <div className="lbl">Из друзей WishBoard</div>
              <div className="val">8 дней рождения · в один клик</div>
            </div>
            <div className="trail">›</div>
          </div>
          <div className="cal-info-row">
            <div className="ic">📅</div>
            <div style={{flex:1}}>
              <div className="lbl">Календарь страны</div>
              <div className="val">Россия · 14 праздников</div>
            </div>
            <div className="trail">›</div>
          </div>
        </div>

        <div style={{height:120}} />
      </div>
      <div className="cal-cta-wrap">
        <button className="wb-btn primary">Дальше</button>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Create event · details (step 2: title, emoji, date, repeat)
 * ================================================================= */
function CalCreateDetails() {
  return (
    <Phone label="Create · details">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="День рождения"
        subtitle="шаг 2 из 4"
      />
      <div className="wb-scroll">
        <div className="wb-form-label">Название</div>
        <div className="wb-input-wrap">
          <input className="wb-input" defaultValue="Маша · 30 лет" placeholder="Например, день рождения Маши" />
        </div>

        <div className="wb-form-label">Иконка</div>
        <div className="wb-emoji-picker">
          <div className="wb-emoji-opt active">🎂</div>
          <div className="wb-emoji-opt">🎉</div>
          <div className="wb-emoji-opt">🎁</div>
          <div className="wb-emoji-opt">🍰</div>
          <div className="wb-emoji-opt">🌹</div>
          <div className="wb-emoji-opt">⭐</div>
          <div className="wb-emoji-opt">＋</div>
        </div>

        <div className="wb-form-label">Дата</div>
        <div className="wb-date-picker">
          <div className="wb-date-cell"><div className="wb-date-cell-l">день</div><div className="wb-date-cell-v">14</div></div>
          <div className="wb-date-cell" style={{borderColor:'var(--wb-accent-soft-strong)', background:'linear-gradient(180deg, var(--wb-accent-soft), var(--wb-card))'}}><div className="wb-date-cell-l">месяц</div><div className="wb-date-cell-v">февраль</div></div>
          <div className="wb-date-cell"><div className="wb-date-cell-l">год</div><div className="wb-date-cell-v">1995</div></div>
        </div>

        <div className="wb-form-label">Повторение</div>
        <div className="wb-repeat-row">
          <div className="wb-repeat">Однократно</div>
          <div className="wb-repeat active">Каждый год</div>
          <div className="wb-repeat">Каждый месяц</div>
          <div className="wb-repeat">Своё…</div>
        </div>

        <div className="wb-form-label">Кого поздравляем</div>
        <div className="wb-wishlist-pick">
          <div className="wb-wishlist-pick-ic">M</div>
          <div className="wb-wishlist-pick-body">
            <div className="wb-wishlist-pick-label">Друг</div>
            <div className="wb-wishlist-pick-name">Маша Петрова · @masha_p</div>
          </div>
          <div className="wb-wishlist-pick-trail">›</div>
        </div>

        <div className="cal-banner-strip" style={{margin:'4px 16px 14px', background:'var(--wb-accent-soft)', borderColor:'var(--wb-accent-soft-strong)'}}>
          <div className="ic">💡</div>
          <div className="body">
            <div className="t">У Маши есть вишлист</div>
            <div className="s">5 идей · подтянем к событию автоматически</div>
          </div>
          <div className="wb-toggle on" />
        </div>

        <div style={{height:120}} />
      </div>
      <div className="cal-cta-wrap">
        <button className="wb-btn primary">Дальше</button>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Create event · reminders (step 3)
 * ================================================================= */
function CalCreateReminders() {
  return (
    <Phone label="Create · reminders">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="Маша · 30 лет"
        subtitle="шаг 3 из 4"
      />
      <div className="wb-scroll">
        <div style={{padding:'8px 24px 18px', textAlign:'center'}}>
          <div style={{fontSize:15, color:'var(--wb-text-secondary)', lineHeight:1.5, letterSpacing:'-0.005em'}}>
            Когда напомнить?
          </div>
        </div>

        <div className="cal-info-group">
          <div className="cal-reminder-line">
            <div className="cal-reminder-time">−14 д</div>
            <div className="cal-reminder-text">За 2 недели<div className="sub">время подумать</div></div>
            <div className="wb-toggle" />
          </div>
          <div className="cal-reminder-line">
            <div className="cal-reminder-time">−7 д</div>
            <div className="cal-reminder-text">За неделю<div className="sub">в 10:00</div></div>
            <div className="wb-toggle on" />
          </div>
          <div className="cal-reminder-line">
            <div className="cal-reminder-time">−3 д</div>
            <div className="cal-reminder-text">За 3 дня<div className="sub">в 10:00</div></div>
            <div className="wb-toggle on" />
          </div>
          <div className="cal-reminder-line">
            <div className="cal-reminder-time">−1 д</div>
            <div className="cal-reminder-text">Накануне<div className="sub">в 18:00</div></div>
            <div className="wb-toggle on" />
          </div>
          <div className="cal-reminder-line">
            <div className="cal-reminder-time">0 д</div>
            <div className="cal-reminder-text">В день события<div className="sub">в 09:00</div></div>
            <div className="wb-toggle on" />
          </div>
        </div>

        <div className="cal-detail-section-h">Дополнительно</div>
        <div className="cal-info-group">
          <div className="cal-info-row">
            <div className="ic tinted">💡</div>
            <div style={{flex:1}}>
              <div className="lbl">Идеи подарков</div>
              <div className="val">За 7 дней пришлём подборку</div>
            </div>
            <div className="wb-toggle on" />
          </div>
          <div className="cal-info-row">
            <div className="ic">📊</div>
            <div style={{flex:1}}>
              <div className="lbl">Бюджет</div>
              <div className="val">2 000 — 5 000 ₽</div>
            </div>
            <div className="trail">›</div>
          </div>
        </div>

        <div style={{height:120}} />
      </div>
      <div className="cal-cta-wrap">
        <button className="wb-btn primary">Дальше</button>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Create event · success
 * ================================================================= */
function CalCreateSuccess() {
  return (
    <Phone label="Create · success">
      <Header title="" />
      <div className="wb-scroll" style={{display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 24px 24px'}}>
        <div style={{
          width:120, height:120, borderRadius:36,
          background: 'radial-gradient(circle at 30% 30%, var(--wb-accent-strong), var(--wb-accent-deep))',
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:64, marginBottom:24,
          boxShadow:'0 20px 50px var(--wb-accent-shadow), inset 0 2px 0 rgba(255,255,255,0.25)',
          filter:'drop-shadow(0 0 60px var(--wb-accent-shadow))'
        }}>🎂</div>
        <h2 style={{fontSize:26, fontWeight:700, letterSpacing:'-0.03em', color:'var(--wb-text)', margin:'0 0 8px', textAlign:'center', lineHeight:1.1}}>Событие создано</h2>
        <p style={{fontSize:14, color:'var(--wb-text-secondary)', textAlign:'center', margin:'0 0 22px', lineHeight:1.5, letterSpacing:'-0.005em', maxWidth:280}}>
          Напомним о Машином дне рождения 14 февраля. Через <strong style={{color:'var(--wb-text)'}}>57 дней</strong>.
        </p>

        <div className="cal-stat-row" style={{margin:'0 0 24px', width:'100%'}}>
          <div className="cal-stat-cell"><div className="cal-stat-n">5</div><div className="cal-stat-l">идей подарков</div></div>
          <div className="cal-stat-cell"><div className="cal-stat-n">4</div><div className="cal-stat-l">напоминания</div></div>
          <div className="cal-stat-cell"><div className="cal-stat-n">∞</div><div className="cal-stat-l">каждый год</div></div>
        </div>

        <div style={{width:'100%', display:'flex', flexDirection:'column', gap:8, marginTop:'auto'}}>
          <button className="wb-btn primary">↗ Поделиться с Машей</button>
          <button className="wb-btn surface">＋ Добавить ещё событие</button>
          <button className="wb-btn ghost">Открыть календарь</button>
        </div>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Push notification (iOS lock screen)
 * ================================================================= */
function CalPushLock() {
  return (
    <div className="phone-wrap">
      <div className="cal-lock-wallpaper">
        <div className="cal-lock-date">пятница, 19 декабря</div>
        <div className="cal-lock-time">9:41</div>
        <div className="cal-lock-pushwrap">
          <div className="cal-push">
            <div className="cal-push-app">▦</div>
            <div className="cal-push-body">
              <div className="cal-push-meta">
                <span className="name">WishBoard</span>
                <span className="when">сейчас</span>
              </div>
              <div className="cal-push-t">У Ноа день рождения через 3 дня 🎂</div>
              <div className="cal-push-s">Подобрали 6 идей из вишлиста · от 1 290 ₽. Заглянуть?</div>
              <div className="cal-push-actions">
                <div className="cal-push-action">Идеи</div>
                <div className="cal-push-action">Напомнить позже</div>
              </div>
            </div>
          </div>

          <div className="cal-push" style={{marginTop:14}}>
            <div className="cal-push-app" style={{background:'linear-gradient(135deg, #FBBF24, #D97706)'}}>💍</div>
            <div className="cal-push-body">
              <div className="cal-push-meta">
                <span className="name">WishBoard</span>
                <span className="when">2 мин</span>
              </div>
              <div className="cal-push-t">Сегодня 8 лет вместе ✨</div>
              <div className="cal-push-s">Что подарить Кате? Откройте подборку «8 лет — шерсть и медь».</div>
            </div>
          </div>

          <div className="cal-push" style={{marginTop:14}}>
            <div className="cal-push-app" style={{background:'linear-gradient(135deg, #34C98A, #1E9765)'}}>🎄</div>
            <div className="cal-push-body">
              <div className="cal-push-meta">
                <span className="name">WishBoard · Тайный Санта</span>
                <span className="when">8:00</span>
              </div>
              <div className="cal-push-t">Сегодня жеребьёвка в 19:00</div>
              <div className="cal-push-s">Семья · 6 человек. Все добавили вишлист.</div>
            </div>
          </div>
        </div>
      </div>
      <div className="phone-label">Lock screen · push</div>
    </div>
  );
}

/* =================================================================
 * SCREEN — In-app banner / inbox (notifications inside app)
 * ================================================================= */
function CalInbox() {
  return (
    <Phone label="In-app inbox">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="Уведомления"
        right={<HeaderBtn icon={Glyph.more} />}
      />
      <div className="wb-scroll">
        <div className="cal-detail-section-h">Сегодня</div>

        <div className="cal-banner-strip" style={{borderColor:'var(--wb-accent-soft-strong)', background:'linear-gradient(135deg, var(--wb-accent-soft), var(--wb-card))'}}>
          <div className="ic">🎂</div>
          <div className="body">
            <div className="t">У Ноа день рождения через 3 дня</div>
            <div className="s">Подобрали 6 идей · от 1 290 ₽</div>
          </div>
          <div className="arrow">›</div>
        </div>

        <div className="cal-banner-strip" style={{borderColor:'rgba(251,191,36,0.28)', background:'linear-gradient(135deg, rgba(251,191,36,0.12), var(--wb-card))'}}>
          <div className="ic">💍</div>
          <div className="body">
            <div className="t">Годовщина свадьбы — сегодня</div>
            <div className="s">8 лет вместе. Не забудьте поздравить @katya_v</div>
          </div>
          <div className="arrow">›</div>
        </div>

        <div className="cal-detail-section-h">На этой неделе</div>

        <div className="cal-banner-strip" style={{background:'var(--wb-card)', borderColor:'var(--wb-border)'}}>
          <div className="ic">🎄</div>
          <div className="body">
            <div className="t">Тайный Санта · жеребьёвка 31 декабря</div>
            <div className="s">Все 6 участников добавили вишлисты</div>
          </div>
          <div className="arrow">›</div>
        </div>

        <div className="cal-banner-strip" style={{background:'var(--wb-card)', borderColor:'var(--wb-border)'}}>
          <div className="ic">📊</div>
          <div className="body">
            <div className="t">Готов годовой отчёт за 2025</div>
            <div className="s">18 событий, 12 поздравлений, 3 совместных подарка</div>
          </div>
          <div className="arrow">›</div>
        </div>

        <div className="cal-detail-section-h">Архив</div>

        <div style={{padding:'0 16px', display:'flex', flexDirection:'column', gap:8}}>
          {[
            ['🎓','Поздравление принято','Лена прочитала ваше сообщение · 14 нояб'],
            ['💝','Подарок забронирован','Миша зарезервировал «Электронную книгу» · 12 нояб'],
            ['🎂','Дарья · 28 лет','Прошло 5 нояб'],
          ].map(([ic, t, s], i) => (
            <div key={i} style={{
              display:'flex', alignItems:'center', gap:12, padding:'10px 12px',
              borderRadius:14, background:'rgba(255,255,255,0.02)',
              opacity:.65
            }}>
              <div style={{fontSize:20, width:28, textAlign:'center'}}>{ic}</div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:13, fontWeight:600, color:'var(--wb-text)', letterSpacing:'-0.01em'}}>{t}</div>
                <div style={{fontSize:11.5, color:'var(--wb-text-muted)', marginTop:1}}>{s}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{height:120}} />
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Year recap (annual summary, social-shareable)
 * ================================================================= */
function CalRecap() {
  return (
    <Phone label="Year recap · 2025">
      <Header
        left={<HeaderBtn icon={Glyph.close} />}
        title=""
        right={<HeaderBtn icon={Glyph.share} />}
      />
      <div className="wb-scroll">
        <div className="cal-recap-hero">
          <div className="cal-recap-eyebrow">★ Ваш год в подарках</div>
          <div className="cal-recap-year">2025</div>
          <div className="cal-recap-sub">Спасибо, что не забывали о близких. Вот что у вас получилось ↓</div>
        </div>

        <div className="cal-recap-grid">
          <div className="cal-recap-card span2">
            <div className="glyph">🎁</div>
            <div className="big">12</div>
            <div className="lbl">Подарков подарено</div>
            <div className="cal-recap-bar">
              {[20,40,60,30,80,50,70,45,90,55,65,38].map((h,i) => (
                <div key={i} className={`cal-recap-bar-col ${h < 40 ? 'dim' : ''}`} style={{height: `${h}%`}} />
              ))}
            </div>
            <div style={{display:'flex', justifyContent:'space-between', marginTop:6, fontSize:9.5, color:'var(--wb-text-muted)', fontWeight:600, letterSpacing:0.3, textTransform:'uppercase'}}>
              <span>янв</span><span>мар</span><span>май</span><span>июл</span><span>сен</span><span>ноя</span>
            </div>
          </div>
          <div className="cal-recap-card">
            <div className="glyph" style={{background:'rgba(240,106,180,0.18)', borderColor:'rgba(240,106,180,0.32)'}}>🎂</div>
            <div className="big">18</div>
            <div className="lbl">Дней рождения отмечено</div>
          </div>
          <div className="cal-recap-card">
            <div className="glyph" style={{background:'rgba(74,222,128,0.18)', borderColor:'rgba(74,222,128,0.32)'}}>✓</div>
            <div className="big">94<span style={{fontSize:18}}>%</span></div>
            <div className="lbl">Не забыли вовремя</div>
          </div>
          <div className="cal-recap-card span2">
            <div className="glyph" style={{background:'rgba(251,191,36,0.18)', borderColor:'rgba(251,191,36,0.32)'}}>★</div>
            <div className="big">38 200 <span style={{fontSize:16, opacity:.6}}>₽</span></div>
            <div className="lbl">Потрачено на подарки · средний 3 183 ₽</div>
          </div>
          <div className="cal-recap-card span2">
            <div className="glyph">💝</div>
            <div className="big" style={{fontSize:18, fontWeight:700, lineHeight:1.3}}>«Самый внимательный»</div>
            <div className="lbl" style={{marginTop:6}}>Кому вы подарили чаще всего: <strong style={{color:'var(--wb-text)'}}>Лена</strong>, 4 раза</div>
          </div>
        </div>

        <div style={{padding:'0 16px 16px', display:'flex', flexDirection:'column', gap:8}}>
          <button className="wb-btn primary">↗ Поделиться итогами</button>
          <button className="wb-btn surface">Открыть полный отчёт</button>
        </div>

        <div style={{height:80}} />
      </div>
    </Phone>
  );
}

Object.assign(window, { CalCreateType, CalCreateDetails, CalCreateReminders, CalCreateSuccess, CalPushLock, CalInbox, CalRecap });
