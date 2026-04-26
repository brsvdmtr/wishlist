/* global React, Phone, Header, HeaderBtn, Button, BottomNav */
/*
 * PaywallScreen — PRO upsell with feature list and 100⭐/mo CTA.
 * Mirrors docs/design-system/mockups/approved/v2-paywall.html.
 */

function Feat({ icon, title, sub }) {
  return (
    <div className="wb-feat">
      <div className="wb-feat-ic">{icon}</div>
      <div style={{flex:1}}>
        <div className="wb-feat-t">{title}</div>
        <div className="wb-feat-s">{sub}</div>
      </div>
    </div>
  );
}

function PaywallScreen({ onBack, onSubscribe, navActive, onNav }) {
  return (
    <Phone>
      <Header
        left={<HeaderBtn icon="×" onClick={onBack} />}
        title=""
        right={<HeaderBtn icon="?" />}
      />

      <div className="wb-scroll">
        <div style={{padding:'12px 24px 0',textAlign:'center'}}>
          <div style={{fontSize:72, lineHeight:1, marginBottom:8, filter:'drop-shadow(0 12px 24px rgba(124,106,255,0.5))'}}>⭐</div>
        </div>
        <div className="wb-paywall-title">
          WishBoard <span className="wb-gradient-text">PRO</span>
        </div>
        <div className="wb-paywall-sub">
          Больше вишлистов, импорт по ссылке, намёки, комментарии и красивые карточки товаров.
        </div>

        <Feat icon="🔗" title="Импорт по ссылке" sub="Ozon, Wildberries, Яндекс Маркет, Lamoda…" />
        <Feat icon="💬" title="Комментарии к желаниям" sub="Обсуждайте детали с дарителями" />
        <Feat icon="💡" title="Намёки без слов" sub="Подскажи, на что лучше делать ставку" />
        <Feat icon="📦" title="Больше и выше лимиты" sub="До 10 вишлистов · 70 желаний · 5 подписок" />
        <Feat icon="🎨" title="Кастомизация карточек" sub="Обложки, акценты, эмодзи" />

        <div style={{padding:'20px 16px 0'}}>
          <Button variant="primary" onClick={onSubscribe}>
            Оформить за 100 ⭐ / мес
          </Button>
          <div style={{textAlign:'center',fontSize:12,color:'var(--wb-text-muted)',marginTop:10,lineHeight:1.5}}>
            Оплата через Telegram Stars · отмена в любой момент<br/>
            Промокод <b style={{color:'var(--wb-accent-light)'}}>WISHPRO</b> — 30 дней бесплатно
          </div>
        </div>
      </div>

      <BottomNav active={navActive} onSelect={onNav} />
    </Phone>
  );
}

Object.assign(window, { PaywallScreen, Feat });
