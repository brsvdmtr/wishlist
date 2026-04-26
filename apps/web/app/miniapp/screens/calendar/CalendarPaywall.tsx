/**
 * Paywall + Onboarding screens — A & B sections of the design pack.
 *
 * Exports:
 *   • CalendarPaywall — locked teaser + sheet variant + full variant
 *   • CalendarOnboarding — 4-step paid-user onboarding
 */

'use client';

import React, { useState } from 'react';
import type { Locale } from '@wishlist/shared';
import { gradients } from '@wishlist/ui-tokens';
import { CalHeader, CtaBar } from './components';
import { ct } from './i18n';

// ════════════════════════════════════════════════════════════════════════
// CalendarPaywall
// ════════════════════════════════════════════════════════════════════════

export function CalendarPaywall({
  locale, priceXtr, variant, onOpenSheet, onOpenFull, onClose, onUnlock, onBack, loading,
}: {
  locale: Locale;
  priceXtr: number;
  variant: 'lock' | 'sheet' | 'full';
  onOpenSheet: () => void;
  onOpenFull: () => void;
  onClose: () => void;
  onUnlock: () => void;
  onBack: () => void;
  loading: boolean;
}) {
  if (variant === 'full') return <PaywallFull locale={locale} priceXtr={priceXtr} onUnlock={onUnlock} onClose={onClose} loading={loading} />;
  if (variant === 'sheet') return <PaywallSheet locale={locale} priceXtr={priceXtr} onUnlock={onUnlock} onClose={onClose} onOpenFull={onOpenFull} loading={loading} />;
  return <Locked locale={locale} priceXtr={priceXtr} onUnlock={onOpenSheet} onOpenFull={onOpenFull} onBack={onBack} />;
}

function Locked({ locale, priceXtr, onUnlock, onOpenFull, onBack }: { locale: Locale; priceXtr: number; onUnlock: () => void; onOpenFull: () => void; onBack: () => void }) {
  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)', position: 'relative' }}>
      <CalHeader title={ct('cal_title', locale)} onBack={onBack} />

      {/* faded calendar behind */}
      <div style={{ filter: 'blur(2.5px) saturate(0.8)', opacity: 0.5, pointerEvents: 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 12px 6px' }}>
          {['пн','вт','ср','чт','пт','сб','вс'].map(w => (
            <div key={w} style={{ textAlign: 'center', fontSize: 10, fontWeight: 600, color: 'var(--wb-text-muted)', textTransform: 'uppercase', padding: '4px 0' }}>{w}</div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 12px 14px', gap: 2 }}>
          {Array.from({ length: 35 }).map((_, i) => {
            const d = i;
            const out = d < 1 || d > 31;
            return (
              <div key={i} style={{
                aspectRatio: '1/1', display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 12, fontSize: 13, color: out ? 'var(--wb-text-muted)' : 'var(--wb-text-secondary)', opacity: out ? 0.3 : 1,
              }}>{out ? '' : d}</div>
            );
          })}
        </div>
      </div>

      {/* Lock overlay — bottom padding clears the floating bottom-nav (~80px tall, 14px from edge) */}
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0,
        padding: '0 22px calc(110px + env(safe-area-inset-bottom))',
        background: 'linear-gradient(180deg, rgba(8,8,11,0) 0%, rgba(8,8,11,0.55) 30%, rgba(8,8,11,0.96) 75%)',
        zIndex: 6, pointerEvents: 'none',
      }}>
        <div style={{
          pointerEvents: 'auto', maxWidth: 520, margin: '0 auto',
          background: 'var(--wb-card-strong)', border: '1px solid var(--wb-border-strong)',
          borderRadius: 24, padding: '22px 20px 18px',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)' as never, backdropFilter: 'blur(24px) saturate(180%)' as never,
          boxShadow: '0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)',
          position: 'relative', overflow: 'hidden',
        }}>
          <div aria-hidden="true" style={{ position: 'absolute', top: '-40%', right: '-30%', width: 240, height: 240, background: gradients.accentRadialGlow }} />

          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 100,
            background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
            color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
            marginBottom: 10, position: 'relative', boxShadow: '0 6px 16px var(--wb-accent-shadow-soft)',
          }}>★ PRO</div>

          <h3 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--wb-text)', lineHeight: 1.15, margin: '0 0 6px', position: 'relative' }}>
            {ct('cal_paywall_lock_title', locale)}
          </h3>
          <p style={{ fontSize: 13.5, color: 'var(--wb-text-secondary)', lineHeight: 1.5, letterSpacing: '-0.005em', margin: '0 0 16px', position: 'relative' }}>
            {ct('cal_paywall_lock_sub', locale)}
          </p>

          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontSize: 13, fontWeight: 700, color: '#FCD34D',
            background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.22)',
            padding: '6px 12px', borderRadius: 100, marginBottom: 14,
            fontFeatureSettings: '"tnum"', position: 'relative',
          }}>
            <span>{priceXtr} ⭐ ≈ {priceXtr * 2} ₽</span>
            <span style={{ opacity: 0.7, fontWeight: 600 }}>{ct('cal_paywall_forever', locale)}</span>
          </div>

          <button onClick={onUnlock} style={primaryBtnStyle}>{ct('cal_paywall_unlock', locale)}</button>
          <button onClick={onOpenFull} style={{ ...ghostBtnStyle, marginTop: 4, position: 'relative' }}>{ct('cal_paywall_demo_first', locale)}</button>
        </div>
      </div>
    </div>
  );
}

function PaywallSheet({ locale, priceXtr, onUnlock, onClose, onOpenFull, loading }: { locale: Locale; priceXtr: number; onUnlock: () => void; onClose: () => void; onOpenFull: () => void; loading: boolean }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', WebkitBackdropFilter: 'blur(4px)' as never, backdropFilter: 'blur(4px)' as never }} />
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        background: 'var(--wb-bg-elev)', border: '1px solid var(--wb-border)', borderBottom: 'none',
        borderRadius: '28px 28px 0 0', padding: '24px 20px calc(28px + env(safe-area-inset-bottom))',
        boxShadow: '0 -20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ width: 40, height: 4, background: 'rgba(255,255,255,0.18)', borderRadius: 2, margin: '-10px auto 20px' }} />
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <div style={{ width: 56, height: 56, borderRadius: 18, background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: '#fff' }}>📅</div>
        </div>
        <div style={{ fontSize: 19, fontWeight: 650, textAlign: 'center', letterSpacing: '-0.025em', color: 'var(--wb-text)', marginBottom: 8 }}>
          {ct('cal_paywall_lock_title', locale)}
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--wb-text-secondary)', textAlign: 'center', marginBottom: 20, lineHeight: 1.5 }}>
          {ct('cal_paywall_lock_sub', locale)}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.04em', color: 'var(--wb-text)' }}>{priceXtr} ⭐</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          {[
            ['🎂', 'Все даты в одном месте'],
            ['🔔', 'Напоминания за 7 / 3 / 1 день'],
            ['💡', 'Идеи из вишлиста к каждому событию'],
            ['🔁', 'Повторы и ежегодные события'],
          ].map(([ic, t]) => (
            <div key={t} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ fontSize: 18, width: 28 }}>{ic}</div>
              <div style={{ fontSize: 14, color: 'var(--wb-text)', fontWeight: 550, letterSpacing: '-0.01em' }}>{t}</div>
            </div>
          ))}
        </div>

        <button onClick={onUnlock} disabled={loading} style={{ ...primaryBtnStyle, marginBottom: 8, opacity: loading ? 0.5 : 1 }}>
          {loading ? '…' : ct('cal_paywall_cta', locale, { n: priceXtr })}
        </button>
        <button onClick={onOpenFull} style={ghostBtnStyle}>{ct('cal_paywall_demo_first', locale)}</button>
      </div>
    </div>
  );
}

function PaywallFull({ locale, priceXtr, onUnlock, onClose, loading }: { locale: Locale; priceXtr: number; onUnlock: () => void; onClose: () => void; loading: boolean }) {
  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)' }}>
      <CalHeader onBack={onClose} />

      {/* Hero */}
      <div style={{
        margin: '0 16px 16px', padding: '26px 22px 22px', borderRadius: 28,
        position: 'relative', overflow: 'hidden',
        background: gradients.paywallHero,
        color: '#fff',
        boxShadow: '0 20px 60px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
      }}>
        <div aria-hidden="true" style={{ position: 'absolute', top: '-30%', right: '-20%', width: 280, height: 280, background: 'radial-gradient(circle, rgba(255,255,255,0.22), transparent 65%)' }} />

        <div style={{
          position: 'relative', zIndex: 1, width: 64, height: 64, borderRadius: 20,
          background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.24)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32,
          marginBottom: 14, WebkitBackdropFilter: 'blur(10px)' as never, backdropFilter: 'blur(10px)' as never,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3), 0 6px 16px rgba(0,0,0,0.18)',
        }}>📅</div>
        <div style={{ position: 'relative', fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', opacity: 0.78, marginBottom: 6 }}>
          {ct('cal_paywall_eyebrow', locale)}
        </div>
        <h1 style={{ position: 'relative', fontSize: 30, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.035em', margin: '0 0 10px' }}>
          {ct('cal_paywall_h1', locale)}
        </h1>
        <p style={{ position: 'relative', fontSize: 14, lineHeight: 1.5, opacity: 0.92, maxWidth: 280, letterSpacing: '-0.005em' }}>
          {ct('cal_paywall_sub', locale)}
        </p>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 18 }}>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.04em', fontFeatureSettings: '"tnum"' }}>
            {priceXtr}<sup style={{ fontSize: 18, fontWeight: 700, opacity: 0.9 }}>⭐</sup>
          </div>
        </div>
      </div>

      {/* Features */}
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--wb-text-muted)', textTransform: 'uppercase', letterSpacing: 0.7, margin: '8px 20px 8px' }}>
        Что вы получите
      </div>
      {[
        ['🎂', 'Календарь со всеми датами', 'Дни рождения друзей подтянутся автоматически'],
        ['🔔', 'Напоминания за 7 / 3 / 1 день', 'Push в Telegram, тонкие настройки на каждое событие'],
        ['💡', 'Идеи подарков из вишлиста', 'К каждому событию — что подарить и сколько стоит'],
        ['🔁', 'Повторяющиеся события', 'Раз настроили — больше не нужно вспоминать'],
        ['🎁', 'Связь с Тайным Сантой и складчиной', 'Создавайте события прямо из календаря'],
      ].map(([ic, t, s]) => (
        <div key={t} style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
          background: 'var(--wb-card)', border: '1px solid var(--wb-border)', borderRadius: 18,
          margin: '0 16px 8px',
          WebkitBackdropFilter: 'blur(14px)' as never, backdropFilter: 'blur(14px)' as never,
        }}>
          <div style={{
            width: 42, height: 42, borderRadius: 13,
            background: 'linear-gradient(135deg, var(--wb-accent-soft-strong), var(--wb-accent-soft))',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
            flexShrink: 0, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
          }}>{ic}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--wb-text)', letterSpacing: '-0.012em' }}>{t}</div>
            <div style={{ fontSize: 12.5, color: 'var(--wb-text-secondary)', marginTop: 2 }}>{s}</div>
          </div>
        </div>
      ))}

      <CtaBar>
        <button onClick={onUnlock} disabled={loading} style={{ ...primaryBtnStyle, opacity: loading ? 0.5 : 1 }}>
          {loading ? '…' : ct('cal_paywall_cta', locale, { n: priceXtr })}
        </button>
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--wb-text-muted)' }}>
          Telegram Stars · ≈ {priceXtr * 2} ₽
        </div>
      </CtaBar>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// CalendarOnboarding
// ════════════════════════════════════════════════════════════════════════

export function CalendarOnboarding({ locale, onSkip, onCreateFirst }: { locale: Locale; onSkip: () => void; onCreateFirst: () => void }) {
  const [step, setStep] = useState(1);
  const data = [
    { e: '🎂', h: ct('cal_onb1_h', locale), s: ct('cal_onb1_s', locale) },
    { e: '🔔', h: ct('cal_onb2_h', locale), s: ct('cal_onb2_s', locale) },
    { e: '💡', h: ct('cal_onb3_h', locale), s: ct('cal_onb3_s', locale) },
    { e: '🚀', h: ct('cal_onb4_h', locale), s: ct('cal_onb4_s', locale) },
  ][step - 1] ?? { e: '', h: '', s: '' };
  const isLast = step === 4;

  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)', display: 'flex', flexDirection: 'column' }}>
      <CalHeader
        onBack={step > 1 ? () => setStep(step - 1) : undefined}
        rightSlot={!isLast ? (
          <button onClick={onSkip} style={{ background: 'none', border: 'none', color: 'var(--wb-text-muted)', fontSize: 13, fontWeight: 600, padding: '0 14px', cursor: 'pointer', fontFamily: 'inherit' }}>
            {ct('cal_skip', locale)}
          </button>
        ) : undefined}
      />

      {/* Bottom padding clears the floating bottom-nav (sits ~14–80px from edge). */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '24px 28px calc(110px + env(safe-area-inset-bottom))' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', minHeight: 220 }}>
          <div style={{
            width: 220, height: 220, borderRadius: '50%',
            background: 'radial-gradient(circle, var(--wb-accent-shadow) 0%, transparent 70%)',
            position: 'absolute', filter: 'blur(20px)',
          }} />
          {/* Designed glyph: gradient-tinted rounded-square container with emoji inside.
              Native emoji at 96px on Telegram WebView (esp. 🔔/💡) renders blocky;
              wrapping it in a 140px container with a colored fill masks the upscale. */}
          <div style={{
            position: 'relative',
            width: 140, height: 140, borderRadius: 36,
            background: 'linear-gradient(135deg, var(--wb-accent-soft-strong), var(--wb-accent-soft))',
            border: '1px solid var(--wb-accent-soft-strong)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 80, lineHeight: 1,
            boxShadow: '0 24px 60px var(--wb-accent-shadow), inset 0 2px 0 rgba(255,255,255,0.18)',
            WebkitBackdropFilter: 'blur(20px)' as never, backdropFilter: 'blur(20px)' as never,
          }}>
            {data.e}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 5, justifyContent: 'center', marginBottom: 20 }}>
          {[1, 2, 3, 4].map(n => (
            <span key={n} style={{
              width: n === step ? 22 : 6, height: 6, borderRadius: 3,
              background: n === step ? 'var(--wb-accent)' : 'var(--wb-text-muted)',
              opacity: n === step ? 1 : 0.25,
              transition: 'all .25s ease',
            }} />
          ))}
        </div>
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.035em', margin: '0 0 10px', textAlign: 'center', color: 'var(--wb-text)', lineHeight: 1.08 }}>{data.h}</h1>
        <p style={{ fontSize: 15, color: 'var(--wb-text-secondary)', margin: '0 0 28px', textAlign: 'center', lineHeight: 1.5, letterSpacing: '-0.005em' }}>{data.s}</p>
        <button onClick={() => isLast ? onCreateFirst() : setStep(step + 1)} style={primaryBtnStyle}>
          {isLast ? ct('cal_onb_first_event', locale) : ct('cal_next', locale)}
        </button>
        {!isLast && (
          <button onClick={onSkip} style={{ ...ghostBtnStyle, marginTop: 6 }}>
            {ct('cal_onb_later', locale)}
          </button>
        )}
      </div>
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '15px 22px', borderRadius: 18, border: 'none',
  background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
  color: '#fff', fontSize: 15, fontWeight: 650, letterSpacing: '-0.015em',
  cursor: 'pointer', minHeight: 52, fontFamily: 'inherit', width: '100%',
  boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
};
const ghostBtnStyle: React.CSSProperties = {
  padding: '12px 22px', borderRadius: 18,
  background: 'transparent', border: 'none',
  color: 'var(--wb-text-secondary)', fontSize: 14, fontWeight: 650,
  cursor: 'pointer', fontFamily: 'inherit', width: '100%',
};
