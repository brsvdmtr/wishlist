/* Calendar feature — Event detail screens (multiple states) */

/* =================================================================
 * SCREEN — Event detail · friend's birthday (with linked wishlist)
 * ================================================================= */
function CalDetailBdayWithList() {
  return (
    <Phone label="Detail · bday + wishlist">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title=""
        right={<HeaderBtn icon={Glyph.more} />}
      />
      <div className="wb-scroll">
        <div className="cal-detail-hero theme-bday">
          <div className="cal-detail-emoji">🎂</div>
          <div className="cal-detail-h">Ноа — 1 годик</div>
          <div className="cal-detail-when">22 декабря · понедельник · 12:00</div>
          <div className="cal-detail-cd">
            <div className="cal-detail-cd-cell"><div className="cal-detail-cd-n">3</div><div className="cal-detail-cd-l">дня</div></div>
            <div className="cal-detail-cd-cell"><div className="cal-detail-cd-n">14</div><div className="cal-detail-cd-l">часов</div></div>
            <div className="cal-detail-cd-cell"><div className="cal-detail-cd-n">22</div><div className="cal-detail-cd-l">мин</div></div>
          </div>
        </div>

        <div className="cal-info-group">
          <div className="cal-info-row">
            <div className="ic tinted">○</div>
            <div style={{flex:1}}>
              <div className="lbl">Кого поздравляем</div>
              <div className="val">Ноа Брисванова · @noa_b</div>
            </div>
            <div className="trail">›</div>
          </div>
          <div className="cal-info-row">
            <div className="ic">◷</div>
            <div style={{flex:1}}>
              <div className="lbl">Повторение</div>
              <div className="val">Каждый год</div>
            </div>
          </div>
          <div className="cal-info-row">
            <div className="ic">◔</div>
            <div style={{flex:1}}>
              <div className="lbl">Напоминания</div>
              <div className="val">За 7, 3 и 1 день</div>
            </div>
            <div className="trail">›</div>
          </div>
          <div className="cal-info-row">
            <div className="ic">◉</div>
            <div style={{flex:1}}>
              <div className="lbl">Место</div>
              <div className="val">У них дома · Тверская 12</div>
            </div>
          </div>
        </div>

        <div className="cal-detail-section-h">Идеи · из вишлиста Ноа</div>
        <div className="cal-idea">
          <div className="cal-idea-thumb" style={{background:'linear-gradient(135deg, #FFE0EB, #F892C9)', color:'#fff'}}>🧸</div>
          <div className="cal-idea-body">
            <div className="cal-idea-t">Игрушка-конструктор Bunchems</div>
            <div className="cal-idea-meta"><span className="price">2 890 ₽</span><span>· OZON</span></div>
          </div>
          <div className="cal-idea-add">＋</div>
        </div>
        <div className="cal-idea">
          <div className="cal-idea-thumb" style={{background:'linear-gradient(135deg, #DCEEFF, #86ABF5)', color:'#fff'}}>📚</div>
          <div className="cal-idea-body">
            <div className="cal-idea-t">Тактильная книжка для малышей</div>
            <div className="cal-idea-meta"><span className="price">1 290 ₽</span><span>· Лабиринт</span></div>
          </div>
          <div className="cal-idea-add">＋</div>
        </div>
        <div className="cal-idea">
          <div className="cal-idea-thumb" style={{background:'linear-gradient(135deg, #FFEBC9, #FBBF24)', color:'#fff'}}>🎵</div>
          <div className="cal-idea-body">
            <div className="cal-idea-t">Музыкальный коврик</div>
            <div className="cal-idea-meta"><span className="price">3 450 ₽</span><span>· WildBerries</span></div>
          </div>
          <div className="cal-idea-add">＋</div>
        </div>

        <div style={{padding:'8px 16px 0'}}>
          <button className="wb-btn surface">↗ Открыть вишлист Ноа</button>
        </div>

        <div style={{height:120}} />
      </div>
      <div className="cal-cta-wrap">
        <button className="wb-btn primary">Пометить — что подарю</button>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Event detail · own anniversary (no wishlist, with reminder)
 * ================================================================= */
function CalDetailOwnAnn() {
  return (
    <Phone label="Detail · own / anniv">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title=""
        right={<HeaderBtn icon={Glyph.edit} />}
      />
      <div className="wb-scroll">
        <div className="cal-detail-hero theme-ann">
          <div className="cal-detail-emoji">💍</div>
          <div className="cal-detail-h">Годовщина свадьбы</div>
          <div className="cal-detail-when">16 декабря · вторник · 8 лет вместе</div>
          <div className="cal-detail-cd">
            <div className="cal-detail-cd-cell"><div className="cal-detail-cd-n">−3</div><div className="cal-detail-cd-l">дня</div></div>
            <div className="cal-detail-cd-cell" style={{flex:2}}>
              <div className="cal-detail-cd-l" style={{fontSize:11, opacity:.95, letterSpacing:0.2}}>Прошло</div>
              <div style={{fontSize:14, fontWeight:600, marginTop:2}}>напомним за 12 мес.</div>
            </div>
          </div>
        </div>

        <div className="cal-info-group">
          <div className="cal-info-row">
            <div className="ic tinted">◇</div>
            <div style={{flex:1}}>
              <div className="lbl">Тип</div>
              <div className="val">Годовщина · своё событие</div>
            </div>
          </div>
          <div className="cal-info-row">
            <div className="ic">◷</div>
            <div style={{flex:1}}>
              <div className="lbl">Повторение</div>
              <div className="val">Каждый год · 16 декабря</div>
            </div>
          </div>
          <div className="cal-info-row">
            <div className="ic">○</div>
            <div style={{flex:1}}>
              <div className="lbl">С кем отмечаем</div>
              <div className="val">@katya_v</div>
            </div>
          </div>
        </div>

        <div className="cal-detail-section-h">Напоминания</div>
        <div className="cal-info-group">
          <div className="cal-reminder-line">
            <div className="cal-reminder-time">−7 д</div>
            <div className="cal-reminder-text">Напомнить за неделю<div className="sub">в 10:00 · уже отправлено</div></div>
            <div className="wb-toggle on" />
          </div>
          <div className="cal-reminder-line">
            <div className="cal-reminder-time">−3 д</div>
            <div className="cal-reminder-text">За 3 дня<div className="sub">в 10:00 · уже отправлено</div></div>
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
            <div className="wb-toggle" />
          </div>
        </div>

        <div className="cal-banner-strip" style={{margin:'0 16px 14px'}}>
          <div className="ic">💡</div>
          <div className="body">
            <div className="t">Подберите подарок Кате</div>
            <div className="s">Открыть её вишлист или подборку «8 лет — шерсть и медь»</div>
          </div>
          <div className="arrow">›</div>
        </div>

        <div style={{padding:'0 16px 16px', display:'flex', flexDirection:'column', gap:8}}>
          <button className="wb-btn surface">↗ Поделиться датой с @katya_v</button>
          <button className="wb-btn ghost" style={{color:'#FB7185'}}>Удалить событие</button>
        </div>

        <div style={{height:80}} />
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Event detail · today (NY · with santa, group of 6)
 * ================================================================= */
function CalDetailToday() {
  return (
    <Phone label="Detail · today (NY+Santa)">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title=""
        right={<HeaderBtn icon={Glyph.share} />}
      />
      <div className="wb-scroll">
        <div className="cal-detail-hero theme-ny">
          <div style={{display:'inline-flex', alignItems:'center', gap:6, fontSize:10.5, fontWeight:700, letterSpacing:0.6, textTransform:'uppercase', background:'rgba(255,255,255,0.18)', border:'1px solid rgba(255,255,255,0.22)', padding:'3px 9px', borderRadius:7, marginBottom:10, position:'relative'}}>● Сегодня</div>
          <div className="cal-detail-emoji">🎄</div>
          <div className="cal-detail-h">Новый год · 2026</div>
          <div className="cal-detail-when">31 декабря · среда · уже сегодня!</div>
          <div className="cal-detail-cd">
            <div className="cal-detail-cd-cell"><div className="cal-detail-cd-n">06</div><div className="cal-detail-cd-l">часов</div></div>
            <div className="cal-detail-cd-cell"><div className="cal-detail-cd-n">23</div><div className="cal-detail-cd-l">мин</div></div>
            <div className="cal-detail-cd-cell"><div className="cal-detail-cd-n">12</div><div className="cal-detail-cd-l">сек</div></div>
          </div>
        </div>

        <div className="cal-info-group">
          <div className="cal-info-row">
            <div className="ic tinted">◇</div>
            <div style={{flex:1}}>
              <div className="lbl">Тип</div>
              <div className="val">Праздник · Новый год</div>
            </div>
          </div>
          <div className="cal-info-row">
            <div className="ic">◉</div>
            <div style={{flex:1}}>
              <div className="lbl">Тайный Санта</div>
              <div className="val">Семья · 6 участников</div>
            </div>
            <div className="trail">›</div>
          </div>
          <div className="cal-info-row">
            <div className="ic">◔</div>
            <div style={{flex:1}}>
              <div className="lbl">Сегодня в</div>
              <div className="val">19:00 · обмен подарками</div>
            </div>
          </div>
        </div>

        <div className="cal-shared-strip">
          <div className="wb-stack">
            <div className="wb-av g1">К</div>
            <div className="wb-av g2">М</div>
            <div className="wb-av g3">А</div>
            <div className="wb-av g4">Л</div>
            <div className="wb-av g5">+2</div>
          </div>
          <div style={{flex:1}}>
            <div className="strong" style={{color:'var(--wb-text)', fontWeight:600, fontSize:13, letterSpacing:'-0.005em'}}>6 человек участвуют</div>
            <div style={{fontSize:11.5, color:'var(--wb-text-muted)', marginTop:1}}>Все принесли вишлист · ваш Санта раскрыт</div>
          </div>
          <div style={{fontSize:18, color:'var(--wb-text-muted)'}}>›</div>
        </div>

        <div className="cal-detail-section-h">Ваш подопечный</div>
        <div className="wb-santa-room assigned">
          <div className="wb-santa-room-top">
            <div className="wb-santa-room-ic">🎁</div>
            <div className="wb-santa-room-body">
              <div className="wb-santa-room-t">Андрей Скворцов</div>
              <div className="wb-santa-room-s"><span>@andysk · 32 года</span><span style={{opacity:.5}}>·</span><span>3 идеи в вишлисте</span></div>
            </div>
          </div>
          <div className="wb-santa-room-reveal">
            <div style={{flex:1}}>
              <div className="wb-santa-room-reveal-t">Ваш подарок готов</div>
              <div className="wb-santa-room-reveal-n">Книга «Думай медленно… решай быстро»</div>
            </div>
            <button className="wb-santa-room-reveal-btn">Открыть</button>
          </div>
        </div>

        <div style={{height:120}} />
      </div>

      <div className="cal-cta-wrap">
        <button className="wb-btn primary">Открыть Тайного Санту</button>
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Event detail · past event (read-only, with thank-you note)
 * ================================================================= */
function CalDetailPast() {
  return (
    <Phone label="Detail · past">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title=""
        right={<HeaderBtn icon={Glyph.more} />}
      />
      <div className="wb-scroll">
        <div className="cal-detail-hero theme-bday" style={{filter:'saturate(0.8)'}}>
          <div style={{display:'inline-flex', alignItems:'center', gap:6, fontSize:10.5, fontWeight:700, letterSpacing:0.6, textTransform:'uppercase', background:'rgba(255,255,255,0.18)', border:'1px solid rgba(255,255,255,0.22)', padding:'3px 9px', borderRadius:7, marginBottom:10, position:'relative'}}>✓ Прошло</div>
          <div className="cal-detail-emoji">🎂</div>
          <div className="cal-detail-h">Лена · 27 лет</div>
          <div className="cal-detail-when">14 ноября 2025 · 35 дней назад</div>
        </div>

        <div className="cal-info-group">
          <div className="cal-info-row">
            <div className="ic" style={{background:'rgba(74,222,128,0.18)', color:'#4ADE80'}}>✓</div>
            <div style={{flex:1}}>
              <div className="lbl">Подарили</div>
              <div className="val">Электронную книгу Kindle Paperwhite</div>
            </div>
            <div style={{fontSize:13, color:'var(--wb-text-muted)', fontWeight:600, fontFeatureSettings:"'tnum'"}}>14 800 ₽</div>
          </div>
          <div className="cal-info-row">
            <div className="ic">○</div>
            <div style={{flex:1}}>
              <div className="lbl">Скооперировались</div>
              <div className="val">Вы и @misha · по 7 400 ₽</div>
            </div>
          </div>
        </div>

        <div className="cal-detail-section-h">Благодарность</div>
        <div style={{
          margin:'0 16px 14px', padding:'16px 18px',
          background:'linear-gradient(135deg, rgba(240,106,180,0.12), rgba(139,123,255,0.12))',
          border:'1px solid var(--wb-border)', borderRadius:18, position:'relative'
        }}>
          <div style={{position:'absolute', top:-8, left:18, fontSize:42, color:'var(--wb-accent-soft-strong)', lineHeight:1, fontFamily:'Georgia, serif'}}>"</div>
          <div style={{fontSize:14, lineHeight:1.5, color:'var(--wb-text)', fontStyle:'italic', letterSpacing:'-0.005em', paddingLeft:18}}>
            Самый лучший подарок! Уже скачала первые три книги. Спасибо вам с Мишей ❤️
          </div>
          <div style={{fontSize:11.5, color:'var(--wb-text-muted)', marginTop:10, paddingLeft:18}}>— Лена, 14 нояб, 22:18</div>
        </div>

        <div style={{padding:'0 16px', display:'flex', flexDirection:'column', gap:8}}>
          <button className="wb-btn surface">⟲ Повторить в следующем году</button>
          <button className="wb-btn ghost">Открыть в архиве</button>
        </div>

        <div style={{height:80}} />
      </div>
    </Phone>
  );
}

Object.assign(window, { CalDetailBdayWithList, CalDetailOwnAnn, CalDetailToday, CalDetailPast });
