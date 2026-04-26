/* global React, Phone, Header, HeaderBtn, Chip, Button, AvatarStack, Banner, BottomNav, Sheet */
/*
 * WishlistDetailScreen — guest view of a friend's wishlist.
 * Includes hero gradient card, wish rows with state (current, reserved-by-me, done),
 * and a bottom sheet confirming a surprise reservation.
 */
const { useState: useState2 } = React;

function WishRow({ wish, onTap }) {
  const { emoji, title, price, priority, meta, state, chips = [] } = wish;
  return (
    <div className={`wb-wish ${state || ''}`} onClick={() => onTap(wish)}>
      <div className="wb-wish-thumb">{emoji}</div>
      <div className="wb-wish-body">
        <div className="wb-wish-t">{title}</div>
        {price && <div className="wb-wish-price">{price}</div>}
        <div className="wb-wish-meta">
          {priority && <Chip tone={`prio${priority}`}>• {priority === 3 ? 'Высокий' : priority === 2 ? 'Средний' : 'Низкий'}</Chip>}
          {chips.map((c, i) => <Chip key={i} tone={c.tone}>{c.label}</Chip>)}
          {meta && <span>· {meta}</span>}
        </div>
      </div>
      <div className="wb-wish-trail">›</div>
    </div>
  );
}

function WishlistDetailScreen({ onBack, navActive, onNav }) {
  const [sheet, setSheet] = useState2(null); // wish being booked

  const wishes = [
    { id: 1, emoji: '🎧', title: 'AirPods Pro 2 (2024)', price: '24 990 ₽', priority: 3, meta: 'ozon.ru' },
    { id: 2, emoji: '🧸', title: 'Лабубу — коллекционная фигурка', price: '2 890 ₽', priority: 2, state: 'reserved-by-me', chips: [{ tone: 'success', label: '🤫 Твоя бронь' }] },
    { id: 3, emoji: '📚', title: 'Atomic Habits — J. Clear (RU)', price: '790 ₽', priority: 1, meta: 'вайлдберриз', chips: [{ tone: 'warning', label: '+15%' }] },
    { id: 4, emoji: '☕', title: 'Delonghi Dedica EC685', price: '39 990 ₽', state: 'done', meta: 'подарено 3 янв' },
    { id: 5, emoji: '👟', title: 'New Balance 530 White', price: '12 490 ₽', priority: 2 },
  ];

  return (
    <Phone>
      <Header
        left={<HeaderBtn icon="←" onClick={onBack} />}
        title="Вишлист Марины"
        subtitle="5 желаний · до др 14 дней"
        right={<HeaderBtn icon="⋯" />}
      />

      <div className="wb-scroll">
        <div className="wb-hero">
          <div className="wb-hero-top">
            <div className="wb-hero-emoji">🎂</div>
            <div style={{flex:1}}>
              <div className="wb-hero-title">День рождения</div>
              <div className="wb-hero-sub">Марина · 4 мая · сюрприз ON</div>
            </div>
          </div>
          <div className="wb-hero-stats">
            <div className="wb-hero-stat">
              <div className="wb-hero-stat-n">5</div>
              <div className="wb-hero-stat-l">желаний</div>
            </div>
            <div className="wb-hero-stat">
              <div className="wb-hero-stat-n">2</div>
              <div className="wb-hero-stat-l">забронировано</div>
            </div>
            <div className="wb-hero-stat">
              <div className="wb-hero-stat-n">
                <AvatarStack people={['А','Д','К']} extra={1} />
              </div>
              <div className="wb-hero-stat-l" style={{marginTop:6}}>участников</div>
            </div>
          </div>
        </div>

        <Banner tone="info" icon="💡">
          <b>Режим сюрприза включён.</b> Марина не увидит, кто забронировал — пока ты сам не снимешь бронь.
        </Banner>

        <div style={{padding:'0 20px 10px',fontSize:13,fontWeight:700,color:'var(--wb-text-muted)',textTransform:'uppercase',letterSpacing:0.8}}>
          Желания
        </div>

        {wishes.map(w => <WishRow key={w.id} wish={w} onTap={(w) => w.state !== 'done' && !w.state && setSheet(w)} />)}
      </div>

      <BottomNav active={navActive} onSelect={onNav} />

      <Sheet
        open={!!sheet}
        onClose={() => setSheet(null)}
        title={`🎁 Забронировать «${sheet?.title.split('—')[0].trim() || ''}»?`}
        subtitle="Марина не увидит, кто забронировал. Снять бронь можно в любой момент из вкладки «Брони»."
      >
        <Button variant="primary" onClick={() => setSheet(null)}>Забронировать тайно</Button>
        <Button variant="ghost" onClick={() => setSheet(null)} style={{marginTop:8}}>Отмена</Button>
      </Sheet>
    </Phone>
  );
}

Object.assign(window, { WishlistDetailScreen, WishRow });
