'use client';

import React from 'react';

type CuratedItem = {
  id: string;
  title: string;
  priceText: string | null;
  currency: string;
  imageUrl: string | null;
};

type SelectionData = {
  selection: {
    id: string;
    title: string;
    itemCount: number;
    expiresAt: string;
    items: CuratedItem[];
  };
};

const C = {
  bg: '#1B1B1F',
  surface: '#26262C',
  text: '#F4F4F6',
  textSec: '#9CA3AF',
  textMuted: '#6B7280',
  accent: '#7C6AFF',
  accentSoft: 'rgba(124,106,255,0.12)',
  border: 'rgba(255,255,255,0.06)',
  orange: '#FBBF24',
  orangeSoft: 'rgba(251,191,36,0.1)',
};

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";

const currencySymbols: Record<string, string> = {
  RUB: '₽', USD: '$', EUR: '€', GBP: '£',
};

function formatPrice(priceText: string | null, currency: string) {
  if (!priceText) return null;
  const sym = currencySymbols[currency] ?? currency;
  return `${priceText} ${sym}`;
}

export default function CuratedSelectionClient({ expired, data, token }: { expired: boolean; data: SelectionData | { error: string; expiresAt?: string }; token: string }) {
  const botLink = `https://t.me/WishBoardBot?start=cs_${token}`;

  if (expired) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: font, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center' }}>
        <div style={{ width: 80, height: 80, borderRadius: 24, background: C.orangeSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36, marginBottom: 24 }}>⏱️</div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 12px' }}>Срок действия истёк</h1>
        <p style={{ fontSize: 15, color: C.textSec, lineHeight: 1.5, maxWidth: 320 }}>
          Эта подборка была доступна 45 дней. Попросите отправителя создать новую.
        </p>
        <a
          href="https://t.me/WishBoardBot"
          style={{
            marginTop: 32, padding: '14px 28px', borderRadius: 14,
            background: C.accent, color: '#fff', textDecoration: 'none',
            fontSize: 15, fontWeight: 600,
          }}
        >
          Создать свой вишлист
        </a>
      </div>
    );
  }

  const { selection } = data as SelectionData;
  const previewItems = selection.items.slice(0, 3);
  const moreCount = selection.itemCount - previewItems.length;

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: font, display: 'flex', flexDirection: 'column' }}>
      {/* Hero */}
      <div style={{ padding: '48px 24px 24px', textAlign: 'center' }}>
        <div style={{ width: 72, height: 72, borderRadius: 20, background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, margin: '0 auto 20px' }}>📋</div>
        <div style={{
          display: 'inline-block', padding: '4px 12px', borderRadius: 8,
          background: 'rgba(96,165,250,0.12)', color: '#60A5FA',
          fontSize: 12, fontWeight: 600, marginBottom: 12,
        }}>
          WishBoard
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px', lineHeight: 1.2 }}>
          {selection.title}
        </h1>
        <p style={{ fontSize: 15, color: C.textSec, margin: 0 }}>
          {selection.itemCount} {selection.itemCount === 1 ? 'желание' : selection.itemCount < 5 ? 'желания' : 'желаний'}
        </p>
      </div>

      {/* CTA Button */}
      <div style={{ padding: '0 24px' }}>
        <a
          href={botLink}
          style={{
            display: 'block', padding: '16px 0', borderRadius: 14,
            background: C.accent, color: '#fff', textDecoration: 'none',
            fontSize: 16, fontWeight: 700, textAlign: 'center',
          }}
        >
          Открыть в Telegram
        </a>
      </div>

      {/* Mini preview */}
      <div style={{ padding: '24px 24px 0' }}>
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Превью
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {previewItems.map(item => (
            <div key={item.id} style={{
              background: C.surface, borderRadius: 12, padding: 12,
              border: `1px solid ${C.border}`,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              {item.imageUrl ? (
                <img src={item.imageUrl} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{ width: 44, height: 44, borderRadius: 8, flexShrink: 0, background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🎁</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 14, fontWeight: 600, color: C.text,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{item.title}</div>
                {item.priceText && (
                  <div style={{ fontSize: 13, color: C.accent, fontWeight: 600, marginTop: 2 }}>
                    {formatPrice(item.priceText, item.currency)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        {moreCount > 0 && (
          <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 14, color: C.textMuted }}>
            и ещё {moreCount}...
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ flex: 1 }} />
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5, marginBottom: 16 }}>
          Откройте в Telegram, чтобы просмотреть все желания, сохранить подборку и создать свой вишлист
        </div>
        <a
          href={botLink}
          style={{
            display: 'block', padding: '14px 0', borderRadius: 14,
            background: C.surface, color: C.accent, textDecoration: 'none',
            fontSize: 15, fontWeight: 600, border: `1px solid ${C.border}`,
          }}
        >
          Открыть в Telegram
        </a>
      </div>
    </div>
  );
}
