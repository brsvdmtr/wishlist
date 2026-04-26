/* global React, Phone, Header, HeaderBtn, Tabs, StatRow, SectionHeader, AvatarStack, Chip, Fab, BottomNav */
/*
 * HomeScreen — "Мои вишлисты" tab with 4 stat tiles, 3 segmented tabs,
 * and a stack of owned-wishlist cards.
 */
const { useState } = React;

function WishlistCard({ wl, onOpen, highlight }) {
  const { emoji, title, count, reserved, participants, progress, chip } = wl;
  return (
    <div className={`wb-wl-card ${highlight ? 'highlight' : ''}`} onClick={() => onOpen(wl)}>
      <div className="wb-wl-card-top">
        <div className="wb-wl-emoji">{emoji}</div>
        <div className="wb-wl-meta">
          <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
            <div className="wb-wl-title">{title}</div>
            {chip && <Chip tone={chip.tone}>{chip.label}</Chip>}
          </div>
          <div className="wb-wl-sub">{count} желаний · {reserved} забронировано</div>
        </div>
      </div>
      <div className="wb-wl-progress"><div style={{width:`${progress}%`}} /></div>
      <div className="wb-wl-foot">
        <AvatarStack people={participants.names} extra={participants.extra} />
        <div className="wb-wl-foot-txt">до др · 14 дней</div>
      </div>
    </div>
  );
}

function HomeScreen({ onOpenWishlist, onCreate, navActive, onNav }) {
  const [tab, setTab] = useState('mine');

  const wishlists = [
    { id: 1, emoji: '🎂', title: 'На день рождения', count: 12, reserved: 4, progress: 33, chip: { tone: 'accent', label: '14 дней' }, participants: { names: ['М','Д','А'], extra: 4 } },
    { id: 2, emoji: '🎄', title: 'Новый год 2026', count: 8, reserved: 2, progress: 25, participants: { names: ['С','К'], extra: 0 } },
    { id: 3, emoji: '💍', title: 'Свадебный', count: 24, reserved: 18, progress: 75, chip: { tone: 'success', label: '75%' }, participants: { names: ['А','Б','В'], extra: 12 } },
  ];

  return (
    <Phone>
      <Header
        left={<HeaderBtn icon="🔍" />}
        title="Мои вишлисты"
        subtitle="3 активных"
        right={<HeaderBtn icon="⚙" />}
      />

      <div className="wb-scroll">
        <StatRow stats={[
          { n: 44, l: 'желаний' },
          { n: 24, l: 'забронировано', tone: 'accent' },
          { n: 8, l: 'подарено', tone: 'success' },
          { n: 1, l: 'истекает', tone: 'warning' },
        ]} />

        <Tabs
          active={tab}
          onSelect={setTab}
          items={[
            { id: 'mine', label: 'Мои' },
            { id: 'sub', label: 'Подписки', badge: 2 },
            { id: 'archive', label: 'Архив' },
          ]}
        />

        <SectionHeader title="Активные" action={{ label: 'Сортировать', onClick: () => {} }} />

        {wishlists.map((wl, i) => (
          <WishlistCard key={wl.id} wl={wl} onOpen={onOpenWishlist} highlight={i === 0} />
        ))}

        <SectionHeader title="Подарки друзьям" />
        <div style={{margin:'0 16px', padding:'14px 16px', background:'var(--wb-card)', border:'1px solid var(--wb-border)', borderRadius:14, display:'flex', alignItems:'center', gap:12}}>
          <div style={{width:40, height:40, borderRadius:12, background:'var(--wb-accent-soft)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20}}>🎁</div>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:600}}>5 активных броней</div>
            <div style={{fontSize:12,color:'var(--wb-text-secondary)',marginTop:2}}>Марина, Денис и ещё трое</div>
          </div>
          <div style={{fontSize:20, color:'var(--wb-text-muted)'}}>›</div>
        </div>
      </div>

      <Fab onClick={onCreate} />
      <BottomNav active={navActive} onSelect={onNav} />
    </Phone>
  );
}

Object.assign(window, { HomeScreen, WishlistCard });
