import React from 'react';
import { t, type Locale } from '@wishlist/shared';

/**
 * Empty-state onboarding for the URL-import screen ("Добавить товар по
 * ссылке"). Shown when the drafts inbox has no items — a 3-step explainer
 * (copy a link → paste it → the app builds the card) so a first-time user
 * understands the feature instead of seeing a bare "empty" label. It needs
 * no dismissal state: the first imported draft replaces it with the list.
 *
 * Composed from v2.1 tokens — see
 * docs/design-system/mockups/approved/url-import-onboarding-empty-state.html.
 * Feature element, not a design-system primitive.
 */

const headStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
};
const iconStyle: React.CSSProperties = {
  width: 60, height: 60, borderRadius: '50%', background: 'var(--wb-accent-soft)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 27,
};
const titleStyle: React.CSSProperties = {
  fontSize: 18, fontWeight: 650, letterSpacing: '-0.02em', marginTop: 14, color: 'var(--wb-text)',
};
const subStyle: React.CSSProperties = {
  fontSize: 13.5, fontWeight: 500, lineHeight: 1.45, color: 'var(--wb-text-secondary)',
  marginTop: 6, maxWidth: 280,
};
const cardStyle: React.CSSProperties = {
  marginTop: 18, padding: '18px 16px 4px', background: 'var(--wb-card)',
  border: '1px solid var(--wb-border)', borderRadius: 22,
  backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
};
const numColStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0,
};
const numStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: '50%', background: 'var(--wb-accent-soft)',
  color: 'var(--wb-accent-strong)', fontSize: 14, fontWeight: 700,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const lineStyle: React.CSSProperties = {
  width: 2, flex: 1, marginTop: 6, borderRadius: 1, background: 'var(--wb-border-light)',
};
const stepBodyStyle: React.CSSProperties = { paddingTop: 3, paddingBottom: 2 };
const stepTitleStyle: React.CSSProperties = {
  fontSize: 14.5, fontWeight: 650, color: 'var(--wb-text)',
};
const stepTextStyle: React.CSSProperties = {
  fontSize: 12.5, fontWeight: 500, lineHeight: 1.45, color: 'var(--wb-text-secondary)', marginTop: 3,
};

export function ImportOnboarding({ locale }: { locale: Locale }) {
  const steps = [
    { n: 1, title: t('drafts_ob_s1_title', locale), text: t('drafts_ob_s1_text', locale) },
    { n: 2, title: t('drafts_ob_s2_title', locale), text: t('drafts_ob_s2_text', locale) },
    { n: 3, title: t('drafts_ob_s3_title', locale), text: t('drafts_ob_s3_text', locale) },
  ];
  return (
    <div style={{ marginTop: 30 }}>
      <div style={headStyle}>
        <div style={iconStyle}>🔗</div>
        <div style={titleStyle}>{t('drafts_ob_title', locale)}</div>
        <div style={subStyle}>{t('drafts_ob_sub', locale)}</div>
      </div>
      <div style={cardStyle}>
        {steps.map((step) => {
          const isLast = step.n === steps.length;
          return (
            <div key={step.n} style={{ display: 'flex', gap: 13, paddingBottom: isLast ? 0 : 16 }}>
              <div style={numColStyle}>
                <div style={numStyle}>{step.n}</div>
                {!isLast && <div style={lineStyle} />}
              </div>
              <div style={stepBodyStyle}>
                <div style={stepTitleStyle}>{step.title}</div>
                <div style={stepTextStyle}>{step.text}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
