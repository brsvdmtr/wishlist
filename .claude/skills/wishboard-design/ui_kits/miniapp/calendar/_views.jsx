/* Calendar feature — Main views: month, week, list, year, today-card.
 * These reuse wb-cal-* + wb-event-* tokens from ../index.html and
 * extend with year-grid styles from cal.css. */

const weekdays = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

/* sample events keyed by day (December 2025) */
const decEvents = {
  16: { e: '💍', cls: 'warn',  t: 'Годовщина свадьбы',  type:'ann' },
  19: { e: '🎁', cls: 'accent', t: 'Сегодня', type: 'today' },
  22: { e: '🎂', cls: 'pink',  t: 'Ноа — 1 годик',     type: 'bday' },
  31: { e: '🎄', cls: 'green', t: 'Новый год',          type: 'holiday' },
};

/* ────── Month grid cell helper ────── */
function MonthGrid({ selected = 19, today = 19 }) {
  // december 2025 starts on Monday (1). 31 days.
  const firstDay = 1; // 0 = Sunday, 1 = Monday for 1 dec 2025
  const days = 31;
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push({ out: true, d: 30 - (firstDay - i - 1) });
  for (let d = 1; d <= days; d++) cells.push({ d, out: false });
  while (cells.length < 35) cells.push({ d: cells.length - days - firstDay + 1, out: true });

  return (
    <>
      <div className="wb-cal-weekdays">
        {weekdays.map((w, i) => <div key={w} className={`wb-cal-wd${i >= 5 ? ' we' : ''}`}>{w}</div>)}
      </div>
      <div className="wb-cal-grid">
        {cells.map((c, i) => {
          if (c.out) return <div key={i} className="wb-cal-cell out">{c.d}</div>;
          const ev = decEvents[c.d];
          const isToday = c.d === today;
          const isSel = c.d === selected;
          let cls = '';
          if (isSel) cls = 'today';
          else if (isToday) cls = 'today';
          else if (ev) cls = 'event';
          return (
            <div key={i} className={`wb-cal-cell ${cls}`} style={isSel ? {boxShadow: '0 0 0 2px var(--wb-accent)'} : {}}>
              {c.d}
              {ev && <span className="wb-cal-emoji">{ev.e}</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* =================================================================
 * SCREEN — Month view (current state · 19 dec selected, today)
 * ================================================================= */
function CalMonth() {
  return (
    <Phone label="Month view">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="События"
        subtitle="декабрь 2025"
        right={<HeaderBtn icon={Glyph.add} />}
      />
      <div className="wb-scroll">
        <div className="wb-cal-view-toggle">
          <div className="wb-cal-view-opt active">Месяц</div>
          <div className="wb-cal-view-opt">Неделя</div>
          <div className="wb-cal-view-opt">Список</div>
        </div>
        <div className="wb-cal-filters">
          <div className="wb-cal-filter on"><span className="wb-cal-filter-dot" style={{background:'#F06AB4'}} />Дни рождения · 12</div>
          <div className="wb-cal-filter on"><span className="wb-cal-filter-dot" style={{background:'#34C98A'}} />Праздники · 4</div>
          <div className="wb-cal-filter"><span className="wb-cal-filter-dot" style={{background:'var(--wb-accent)'}} />Свои · 2</div>
        </div>
        <div className="wb-cal-header">
          <div className="wb-cal-title">декабрь 2025</div>
          <div className="wb-cal-nav">
            <div className="wb-cal-nav-btn">‹</div>
            <div className="wb-cal-nav-btn">›</div>
          </div>
        </div>
        <MonthGrid />

        {/* today card */}
        <div className="wb-cal-today-card" style={{
          background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-strong))',
          padding: '14px 16px',
          color: '#fff',
        }}>
          <div style={{position:'relative'}}>
            <div style={{fontSize:11, fontWeight:700, letterSpacing:0.6, textTransform:'uppercase', opacity:.85}}>Сегодня · 19 дек</div>
            <div style={{fontSize:17, fontWeight:700, letterSpacing:'-0.02em', marginTop:3, lineHeight:1.3}}>До дня рождения Ноа — 3 дня</div>
            <div style={{fontSize:12.5, opacity:.85, marginTop:3}}>Подобрали 6 идей · от 800 ₽</div>
          </div>
        </div>

        <div className="cal-detail-section-h">Ближайшие события</div>

        <div className="wb-cal-agenda-date"><div className="wb-cal-agenda-date-d">22</div><div className="wb-cal-agenda-date-m">дек · пн</div><div className="wb-cal-agenda-date-line" /></div>
        <div className="wb-event-card">
          <div className="wb-event-date pink"><div className="wb-event-date-d">22</div><div className="wb-event-date-m">дек</div></div>
          <div className="wb-event-body">
            <div className="wb-event-t"><span className="wb-event-ic">🎂</span>Ноа — 1 годик</div>
            <div className="wb-event-s"><span className="wb-event-countdown">через 3 дня</span><span>Семейный праздник</span></div>
          </div>
          <div className="wb-event-trail">›</div>
        </div>

        <div style={{height:120}} />
        <NavBar active="events" />
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — List / agenda view
 * ================================================================= */
function CalList() {
  const items = [
    { day:'19', dow:'пт · сегодня', e:'🎁', cls:'accent', t:'WishBoard · 3 года', s:'Спецпредложение', cd:'сегодня' },
    { day:'22', dow:'пн', e:'🎂', cls:'pink', t:'Ноа — 1 годик', s:'Семейный праздник · 12:00', cd:'через 3 дня' },
    { day:'25', dow:'чт', e:'🎄', cls:'green', t:'Католическое Рождество', s:'Праздник', cd:'через 6 дней' },
    { day:'31', dow:'чт', e:'🎄', cls:'green', t:'Новый год', s:'Тайный Санта · 6 человек', cd:'через 12 дн.' },
    { sep:'январь 2026' },
    { day:'07', dow:'ср', e:'☦️', cls:'green', t:'Рождество Христово', s:'Праздник · ежегодно', cd:'через 19 дн.' },
    { day:'14', dow:'ср', e:'🎂', cls:'pink', t:'Лена · 27 лет', s:'@lenchik · из друзей', cd:'через 26 дн.' },
    { day:'25', dow:'вс', e:'🎓', cls:'accent', t:'День студента', s:'Праздник', cd:'через 37 дн.' },
    { sep:'февраль 2026' },
    { day:'14', dow:'сб', e:'💝', cls:'pink', t:'День святого Валентина', s:'Праздник', cd:'через 57 дн.' },
    { day:'23', dow:'пн', e:'🛡️', cls:'green', t:'День защитника', s:'Праздник', cd:'через 66 дн.' },
  ];
  return (
    <Phone label="List / agenda">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="События"
        subtitle="все"
        right={<HeaderBtn icon={Glyph.filter} />}
      />
      <div className="wb-scroll">
        <div className="wb-cal-view-toggle">
          <div className="wb-cal-view-opt">Месяц</div>
          <div className="wb-cal-view-opt">Неделя</div>
          <div className="wb-cal-view-opt active">Список</div>
        </div>

        <div className="wb-search-bar" style={{marginTop:0}}>
          <span className="wb-search-ic">⌕</span>
          <input className="wb-search-input" placeholder="Поиск по событиям" />
        </div>

        {items.map((it, idx) => {
          if (it.sep) return (
            <div key={idx} className="cal-detail-section-h" style={{paddingTop:14}}>{it.sep}</div>
          );
          return (
            <React.Fragment key={idx}>
              <div className="wb-cal-agenda-date">
                <div className="wb-cal-agenda-date-d">{it.day}</div>
                <div className="wb-cal-agenda-date-m">{months[idx % 12]} · {it.dow}</div>
                <div className="wb-cal-agenda-date-line" />
              </div>
              <div className="wb-event-card">
                <div className={`wb-event-date ${it.cls}`}>
                  <div className="wb-event-date-d">{it.day}</div>
                  <div className="wb-event-date-m">дек</div>
                </div>
                <div className="wb-event-body">
                  <div className="wb-event-t"><span className="wb-event-ic">{it.e}</span>{it.t}</div>
                  <div className="wb-event-s">
                    <span className="wb-event-countdown">{it.cd}</span>
                    <span>{it.s}</span>
                  </div>
                </div>
                <div className="wb-event-trail">›</div>
              </div>
            </React.Fragment>
          );
        })}
        <div style={{height:140}} />
        <NavBar active="events" />
      </div>
    </Phone>
  );
}

/* =================================================================
 * SCREEN — Year overview (12 small grids · 2025)
 * ================================================================= */
function CalYear() {
  // sample: which days have which type per month
  const yearMap = {
    0: [['7','holiday']],
    1: [['14','custom'], ['23','holiday']],
    2: [['8','holiday']],
    3: [['12','custom']],
    4: [['1','holiday'], ['9','holiday'], ['28','bday']],
    5: [['12','holiday']],
    6: [['4','bday'], ['18','custom']],
    7: [['15','custom']],
    8: [['1','custom'], ['22','bday']],
    9: [['5','custom']],
    10:[['4','holiday'], ['11','bday']],
    11:[['16','warn'], ['19','today'], ['22','bday'], ['25','holiday'], ['31','holiday']],
  };

  return (
    <Phone label="Year overview">
      <Header
        left={<HeaderBtn icon={Glyph.back} />}
        title="2025"
        right={<HeaderBtn icon={Glyph.filter} />}
      />
      <div className="wb-scroll">
        <div className="wb-cal-view-toggle">
          <div className="wb-cal-view-opt">Месяц</div>
          <div className="wb-cal-view-opt">Неделя</div>
          <div className="wb-cal-view-opt">Список</div>
          <div className="wb-cal-view-opt active">Год</div>
        </div>

        <div className="cal-stat-row">
          <div className="cal-stat-cell"><div className="cal-stat-n">18</div><div className="cal-stat-l">событий</div></div>
          <div className="cal-stat-cell"><div className="cal-stat-n">12</div><div className="cal-stat-l">дней рожд.</div></div>
          <div className="cal-stat-cell"><div className="cal-stat-n">3 ⭐</div><div className="cal-stat-l">подарили</div></div>
        </div>

        <div className="cal-year-grid">
          {months.map((m, mIdx) => {
            const isCurrent = mIdx === 11;
            const events = yearMap[mIdx] || [];
            const hasEvent = events.length > 0;
            return (
              <div key={m} className={`cal-year-month ${hasEvent ? 'has-event' : ''} ${isCurrent ? 'current' : ''}`}>
                <div className="cal-year-mh">
                  <span>{m}</span>
                  {hasEvent && <span className="n">{events.length}</span>}
                </div>
                <div className="cal-year-grid-mini">
                  {Array.from({length: 35}).map((_, i) => {
                    const d = i + 1;
                    if (d > 31) return <div key={i} className="cal-year-cell" style={{visibility:'hidden'}} />;
                    const ev = events.find(([day]) => parseInt(day) === d);
                    if (!ev) return <div key={i} className="cal-year-cell" />;
                    return <div key={i} className={`cal-year-cell event-${ev[1]}`} />;
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="cal-detail-section-h">Легенда</div>
        <div style={{display:'flex', flexWrap:'wrap', gap:8, padding:'0 16px 24px'}}>
          {[
            ['#F06AB4', 'Дни рождения'],
            ['#34C98A', 'Праздники'],
            ['var(--wb-accent)', 'Свои'],
            ['#FBBF24', 'Годовщины'],
          ].map(([c, l]) => (
            <div key={l} style={{
              display:'inline-flex', alignItems:'center', gap:6,
              padding:'5px 10px', borderRadius:100,
              background:'var(--wb-card)', border:'1px solid var(--wb-border)',
              fontSize:11.5, color:'var(--wb-text-secondary)', fontWeight:550
            }}>
              <span style={{width:10, height:10, borderRadius:3, background:c}} />
              {l}
            </div>
          ))}
        </div>

        <div style={{height:120}} />
        <NavBar active="events" />
      </div>
    </Phone>
  );
}

Object.assign(window, { CalMonth, CalList, CalYear });
