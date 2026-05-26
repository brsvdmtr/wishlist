// Gift Notes onboarding flow — 4-step explainer shown once after the
// user unlocks Gift Notes. Extracted from MiniApp.tsx (was top-level
// helper at lines 3429-3621) as part of F4 Wave A++. Lazy-loaded via
// next/dynamic from MiniApp.tsx — cold-path (one-shot post-unlock).
//
// Self-contained: only needs `locale` + 2 callbacks. Uses CSS vars
// directly instead of the MiniApp `C.*` colour helpers so it doesn't
// need closure access to the parent module.

'use client';

import { useState, type CSSProperties } from 'react';
import { t, type Locale } from '@wishlist/shared';

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";

const ACCENT = 'var(--wb-accent)';
const ACCENT_GLOW = 'var(--wb-accent-shadow-soft, rgba(139,123,255,0.25))';
const ACCENT_SOFT = 'var(--wb-accent-soft, rgba(139,123,255,0.14))';
const BG = 'var(--wb-bg)';
const CARD = 'var(--wb-card)';
const SURFACE = 'var(--wb-surface)';
const SURFACE_HOVER = 'var(--wb-surface-hover)';
const BORDER = 'var(--wb-border)';
const BORDER_LIGHT = 'var(--wb-border-strong)';
const TEXT = 'var(--wb-text)';
const TEXT_SEC = 'var(--wb-text-secondary)';
const TEXT_MUTED = 'var(--wb-text-muted)';
const SUCCESS = 'var(--wb-success, #4ADE80)';
const WARNING = 'var(--wb-warning, #FBBF24)';
const DANGER = 'var(--wb-danger, #FB7185)';

const ORANGE_SOFT = 'rgba(251,191,36,0.12)';

export interface GiftNotesOnboardingContentProps {
  locale: Locale;
  onFinishSkip: () => void;
  onFinishCreate: () => void;
}

export function GiftNotesOnboardingContent({
  locale, onFinishSkip, onFinishCreate,
}: GiftNotesOnboardingContentProps) {
  const [step, setStep] = useState(0);

  const finish = (createFirst: boolean) => {
    try { window.localStorage.setItem('gift_notes_onboarded', '1'); } catch { /* ok */ }
    if (createFirst) onFinishCreate(); else onFinishSkip();
  };

  const dots = (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 20 }}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{
          width: 20, height: 4, borderRadius: 2,
          background: i === step
            ? ACCENT
            : i < step
              ? 'rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.4)'
              : SURFACE_HOVER,
        }} />
      ))}
    </div>
  );

  const nextBtn = (
    <button
      onClick={() => setStep(step + 1)}
      style={{
        width: '100%', padding: 14, borderRadius: 14, border: 'none',
        background: `linear-gradient(135deg, ${ACCENT} 0%, #9B8AFF 100%)`,
        color: '#fff', fontSize: 15, fontWeight: 700,
        cursor: 'pointer', fontFamily: font,
        boxShadow: `0 4px 16px ${ACCENT_GLOW}`,
      }}
    >
      {t('gn_ob_next', locale)}
    </button>
  );

  const skipBtn = (
    <button
      onClick={() => finish(false)}
      style={{
        width: '100%', padding: 10, border: 'none',
        background: 'transparent', color: TEXT_MUTED,
        fontSize: 12, cursor: 'pointer', fontFamily: font, marginTop: 8,
      }}
    >
      {t('gn_ob_skip', locale)}
    </button>
  );

  const wrap: CSSProperties = {
    padding: '24px 20px 20px',
    minHeight: 'calc(100vh - 60px)',
    display: 'flex', flexDirection: 'column',
  };

  const heroTitle = (align: 'left' | 'center'): CSSProperties => ({
    fontSize: 26, fontWeight: 700,
    color: TEXT, marginBottom: 10,
    fontFamily: font, lineHeight: 1.05,
    letterSpacing: '-0.035em',
    textAlign: align,
  });

  const heroBody: CSSProperties = {
    fontSize: 15, color: TEXT_SEC,
    lineHeight: 1.5, maxWidth: 320, margin: '0 auto 16px',
    letterSpacing: '-0.005em',
    textAlign: 'center',
  };

  if (step === 0) {
    return (
      <div style={{ ...wrap, animation: 'fadeIn 0.25s ease' }}>
        {dots}
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div style={{
            width: 80, height: 80, borderRadius: 24,
            background: 'linear-gradient(145deg, rgba(74, 222, 128, 0.2), rgba(74, 222, 128, 0.08))',
            border: '1px solid rgba(74, 222, 128, 0.25)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 40, margin: '0 auto 16px', color: SUCCESS,
          }}>✓</div>
          <h2 style={heroTitle('center')}>{t('gn_ob_s1_title', locale)}</h2>
          <p style={heroBody}>{t('gn_ob_s1_body', locale)}</p>
        </div>
        <div style={{ background: CARD, borderRadius: 16, padding: 16, marginBottom: 16 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: TEXT_MUTED,
            textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10,
          }}>{t('gn_ob_s1_checklist', locale)}</div>
          {[t('gn_ob_s1_c1', locale), t('gn_ob_s1_c2', locale), t('gn_ob_s1_c3', locale), t('gn_ob_s1_c4', locale)].map((text, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 0',
              borderTop: i > 0 ? `1px solid ${BORDER}` : 'none',
            }}>
              <span style={{ color: SUCCESS, fontSize: 16, flexShrink: 0 }}>✓</span>
              <span style={{ fontSize: 14, color: TEXT }}>{text}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 'auto' }}>{nextBtn}</div>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div style={{ ...wrap, animation: 'fadeIn 0.25s ease' }}>
        {dots}
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📝</div>
          <h2 style={heroTitle('center')}>{t('gn_ob_s2_title', locale)}</h2>
          <p style={heroBody}>{t('gn_ob_s2_body', locale)}</p>
        </div>
        <div style={{ background: CARD, borderRadius: 16, padding: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{
              background: SURFACE, border: `1px solid ${ACCENT}`,
              borderRadius: 12, padding: '10px 12px',
              boxShadow: '0 0 0 3px rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.12)',
            }}>
              <div style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                {t('gn_ob_s2_label_who', locale)}
              </div>
              <div style={{ fontSize: 14, color: TEXT, fontWeight: 500 }}>
                {t('gn_ob_s2_demo_person', locale)}
              </div>
            </div>
            <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                {t('gn_ob_s2_label_when', locale)}
              </div>
              <div style={{ fontSize: 14, color: TEXT, fontWeight: 500 }}>
                {t('gn_ob_s2_demo_date', locale)}
              </div>
            </div>
            <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                {t('gn_ob_s2_label_type', locale)}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, background: ACCENT, color: '#fff', fontWeight: 500 }}>
                  {t('gn_ob_s2_chip_bday', locale)}
                </div>
                <div style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, background: BG, color: TEXT_SEC, fontWeight: 500 }}>
                  {t('gn_ob_s2_chip_anniv', locale)}
                </div>
                <div style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, background: BG, color: TEXT_SEC, fontWeight: 500 }}>
                  {t('gn_ob_s2_chip_holiday', locale)}
                </div>
              </div>
            </div>
            <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                {t('gn_ob_s2_label_recurring', locale)}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, background: ACCENT, color: '#fff', fontWeight: 500 }}>
                  {t('gn_ob_s2_chip_yearly', locale)}
                </div>
                <div style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11, background: BG, color: TEXT_SEC, fontWeight: 500 }}>
                  {t('gn_ob_s2_chip_once', locale)}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div style={{
          padding: '12px 14px', background: BG, borderRadius: 12,
          borderLeft: `3px solid ${ACCENT}`,
          fontSize: 13, color: TEXT_SEC, lineHeight: 1.6, marginBottom: 20,
        }}>
          {t('gn_ob_s2_info', locale)}
        </div>
        <div style={{ marginTop: 'auto' }}>{nextBtn}{skipBtn}</div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div style={{ ...wrap, animation: 'fadeIn 0.25s ease' }}>
        {dots}
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>💡</div>
          <h2 style={heroTitle('center')}>{t('gn_ob_s3_title', locale)}</h2>
          <p style={heroBody}>{t('gn_ob_s3_body', locale)}</p>
        </div>
        <div style={{
          background: CARD, borderRadius: 14, padding: 14, marginBottom: 12,
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
            background: `linear-gradient(180deg, ${WARNING}, #f59e0b)`,
          }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: ORANGE_SOFT,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }}>🎂</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>
                {t('gn_ob_s3_demo_title', locale)}
              </div>
              <div style={{ fontSize: 11, color: TEXT_MUTED }}>
                {t('gn_ob_s3_demo_sub', locale)}
              </div>
            </div>
            <div style={{
              fontSize: 10, fontWeight: 700, color: WARNING,
              background: ORANGE_SOFT, padding: '3px 7px', borderRadius: 6,
            }}>
              {t('gn_ob_s3_demo_chip', locale)}
            </div>
          </div>
          {[
            { text: t('gn_ob_s3_idea_1', locale), price: t('gn_ob_s3_idea_1_price', locale) },
            { text: t('gn_ob_s3_idea_2', locale), price: t('gn_ob_s3_idea_2_price', locale) },
            { text: t('gn_ob_s3_idea_3', locale), price: t('gn_ob_s3_idea_3_price', locale) },
          ].map((idea, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', background: SURFACE, borderRadius: 10,
              marginTop: 6, borderLeft: `2px solid ${ACCENT}`,
            }}>
              <span style={{ color: ACCENT, fontSize: 14, lineHeight: 1 }}>•</span>
              <span style={{ flex: 1, fontSize: 13, color: TEXT }}>{idea.text}</span>
              <span style={{ fontSize: 11, color: TEXT_MUTED }}>{idea.price}</span>
            </div>
          ))}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: 8, marginTop: 6, borderRadius: 10,
            background: 'transparent', border: `1px dashed ${BORDER_LIGHT}`,
            fontSize: 12, color: TEXT_MUTED,
          }}>
            {t('gn_ob_s3_add', locale)}
          </div>
        </div>
        <div style={{
          padding: '12px 14px', background: BG, borderRadius: 12,
          borderLeft: `3px solid ${ACCENT}`,
          fontSize: 13, color: TEXT_SEC, lineHeight: 1.6, marginBottom: 20,
        }}>
          {t('gn_ob_s3_info', locale)}
        </div>
        <div style={{ marginTop: 'auto' }}>{nextBtn}{skipBtn}</div>
      </div>
    );
  }

  // step === 3 — final: timeline + CTA
  const tl = [
    { dot: ACCENT, label: t('gn_ob_s4_tl1_label', locale), desc: t('gn_ob_s4_tl1_desc', locale), color: ACCENT, hasLine: true },
    { dot: WARNING, label: t('gn_ob_s4_tl2_label', locale), desc: t('gn_ob_s4_tl2_desc', locale), color: WARNING, hasLine: true },
    { dot: DANGER, label: t('gn_ob_s4_tl3_label', locale), desc: t('gn_ob_s4_tl3_desc', locale), color: DANGER, hasLine: true },
    { dot: SUCCESS, label: t('gn_ob_s4_tl4_label', locale), desc: t('gn_ob_s4_tl4_desc', locale), color: SUCCESS, hasLine: false },
  ];

  return (
    <div style={{ ...wrap, animation: 'fadeIn 0.25s ease' }}>
      {dots}
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔔</div>
        <h2 style={heroTitle('center')}>{t('gn_ob_s4_title', locale)}</h2>
        <p style={heroBody}>{t('gn_ob_s4_body', locale)}</p>
      </div>
      <div style={{ background: CARD, borderRadius: 16, padding: '14px 16px 10px', marginBottom: 20 }}>
        {tl.map((ev, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: ev.dot, flexShrink: 0 }} />
              {ev.hasLine && <div style={{ width: 2, height: 32, background: SURFACE_HOVER }} />}
            </div>
            <div style={{ paddingBottom: ev.hasLine ? 12 : 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: ev.color }}>{ev.label}</div>
              <div style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 2, lineHeight: 1.4 }}>{ev.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 'auto' }}>
        <button
          onClick={() => finish(true)}
          style={{
            width: '100%', padding: 14, borderRadius: 14, border: 'none',
            background: `linear-gradient(135deg, ${ACCENT} 0%, #9B8AFF 100%)`,
            color: '#fff', fontSize: 15, fontWeight: 700,
            cursor: 'pointer', fontFamily: font,
            boxShadow: `0 4px 16px ${ACCENT_GLOW}`,
          }}
        >
          {t('gn_ob_s4_cta', locale)}
        </button>
        <button
          onClick={() => finish(false)}
          style={{
            width: '100%', padding: 10, border: 'none',
            background: 'transparent', color: TEXT_MUTED,
            fontSize: 12, cursor: 'pointer', fontFamily: font, marginTop: 8,
          }}
        >
          {t('gn_ob_s4_skip', locale)}
        </button>
      </div>
    </div>
  );
}

