// Legal menu — extracted from MiniApp.tsx (F4 Wave A).
// Cold path (Settings → Legal). Lists LEGAL_DOCS; tapping a row tells the
// parent to open the viewer with that docId.
// Data file shared with LegalDocViewerScreen.tsx — both lazy, both pull the
// same legal-docs.ts chunk.

'use client';

import { t, type Locale } from '@wishlist/shared';
import { LEGAL_DOCS } from './data/legal-docs';

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";

export interface LegalMenuScreenProps {
  locale: Locale;
  onOpenDoc: (docId: string) => void;
}

export function LegalMenuScreen({ locale, onOpenDoc }: LegalMenuScreenProps) {
  return (
    <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
      <h1 style={{
        fontSize: 26, fontWeight: 700, fontFamily: font,
        color: 'var(--wb-text)', letterSpacing: '-0.035em',
        lineHeight: 1.05, margin: '0 0 4px',
      }}>
        {t('legal_hub_title', locale)}
      </h1>
      <p style={{
        fontSize: 13, color: 'var(--wb-text-muted)',
        margin: '0 0 20px', lineHeight: 1.4,
      }}>
        {t('legal_hub_subtitle', locale)}
      </p>

      <div style={{
        background: 'var(--wb-card)', borderRadius: 16, overflow: 'hidden',
      }}>
        {LEGAL_DOCS.map((doc, idx) => (
          <div key={doc.id}>
            {idx > 0 && (
              <div style={{
                borderTop: '1px solid var(--wb-border)',
                margin: '0 16px',
              }} />
            )}
            <div
              onClick={() => onOpenDoc(doc.id)}
              onPointerDown={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.45'; }}
              onPointerUp={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
              onPointerLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '14px 16px', cursor: 'pointer',
                transition: 'opacity 0.12s',
              }}
            >
              <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0 }}>{doc.icon}</span>
              <span style={{
                flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--wb-text)',
              }}>{doc.title[locale] ?? doc.title.en}</span>
              <span style={{
                fontSize: 14, color: 'var(--wb-text-muted)', flexShrink: 0,
              }}>{'›'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
