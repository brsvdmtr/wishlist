/* global React, Phone, Button */
/*
 * OnboardingScreen — slide 0/3 of the first-run flow.
 * Full-bleed hero, violet glow, pagination dots.
 */

function OnboardingScreen({ onNext, onSkip, step = 0 }) {
  const slides = [
    { emoji: '🎁', title: 'Никаких двойных подарков', body: 'Друзья видят, что можно подарить — без спойлеров для именинника. Бронирование в режиме сюрприза включено по умолчанию.' },
    { emoji: '🔗', title: 'Вставь ссылку — всё само', body: 'Ozon, WB, Маркет, Lamoda, Goldapple. Фото, цена, название подтянутся автоматически. (PRO)' },
    { emoji: '🎄', title: 'Secret Santa за минуту', body: 'Анонимный жребий прямо в Telegram — пригласи всех одной кнопкой.' },
  ];
  const s = slides[step];

  return (
    <Phone>
      <div style={{padding:'8px 16px',textAlign:'right'}}>
        <span style={{fontSize:14,color:'var(--wb-text-muted)',fontWeight:600,cursor:'pointer'}} onClick={onSkip}>Пропустить</span>
      </div>

      <div className="wb-onb">
        <div className="wb-onb-visual">
          <div className="wb-onb-glow" />
          <div className="wb-onb-emoji">{s.emoji}</div>
        </div>
        <h1>{s.title}</h1>
        <p>{s.body}</p>
        <div className="wb-onb-dots">
          {slides.map((_, i) => <span key={i} className={i === step ? 'active' : ''} />)}
        </div>
        <Button variant="primary" onClick={onNext}>
          {step === slides.length - 1 ? 'Создать вишлист' : 'Дальше'}
        </Button>
      </div>
    </Phone>
  );
}

Object.assign(window, { OnboardingScreen });
