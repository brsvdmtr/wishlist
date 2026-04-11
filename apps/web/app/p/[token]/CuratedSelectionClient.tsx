'use client';

import React, { useState } from 'react';

type CuratedItem = {
  id: string;
  title: string;
  priceText: string | null;
  currency: string;
  imageUrl: string | null;
  url: string | null;
  description: string | null;
  position: number;
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
  green: '#34D399',
  greenSoft: 'rgba(52,211,153,0.12)',
  orange: '#FBBF24',
  orangeSoft: 'rgba(251,191,36,0.1)',
  red: '#F87171',
  redSoft: 'rgba(248,113,113,0.12)',
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

export default function CuratedSelectionClient({ expired, data }: { expired: boolean; data: SelectionData | { error: string; expiresAt?: string } }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (expired) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: font, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center' }}>
        <div style={{ width: 80, height: 80, borderRadius: 24, background: C.orangeSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36, marginBottom: 24 }}>⏱️</div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 12px' }}>Срок подборки истёк</h1>
        <p style={{ fontSize: 15, color: C.textSec, lineHeight: 1.5, maxWidth: 320 }}>
          Эта подборка была активна 45 дней и больше недоступна. Попросите отправителя создать новую.
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
  const expiryDate = new Date(selection.expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: font }}>
      {/* Header */}
      <div style={{ padding: '24px 20px 0' }}>
        <div style={{
          display: 'inline-block', padding: '4px 12px', borderRadius: 8,
          background: 'rgba(96,165,250,0.12)', color: '#60A5FA',
          fontSize: 12, fontWeight: 600, marginBottom: 12,
        }}>
          📋 Подборка из вишлиста
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px', lineHeight: 1.2 }}>
          {selection.title}
        </h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, color: C.textSec }}>
            {selection.itemCount} {selection.itemCount === 1 ? 'желание' : selection.itemCount < 5 ? 'желания' : 'желаний'}
          </span>
          <span style={{ fontSize: 12, color: C.orange, background: C.orangeSoft, padding: '2px 8px', borderRadius: 6 }}>
            Действует до {expiryDate}
          </span>
        </div>
      </div>

      {/* Items */}
      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {selection.items.map(item => {
          const isExpanded = expandedId === item.id;
          return (
            <div
              key={item.id}
              onClick={() => setExpandedId(isExpanded ? null : item.id)}
              style={{
                background: C.surface, borderRadius: 14, overflow: 'hidden',
                border: `1px solid ${C.border}`, cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14 }}>
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt=""
                    style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
                  />
                ) : (
                  <div style={{
                    width: 56, height: 56, borderRadius: 10, flexShrink: 0,
                    background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24,
                  }}>🎁</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 15, fontWeight: 600, color: C.text,
                    whiteSpace: isExpanded ? 'normal' : 'nowrap',
                    overflow: isExpanded ? 'visible' : 'hidden',
                    textOverflow: isExpanded ? 'unset' : 'ellipsis',
                  }}>{item.title}</div>
                  {item.priceText && (
                    <div style={{ fontSize: 14, color: C.accent, fontWeight: 600, marginTop: 4 }}>
                      {formatPrice(item.priceText, item.currency)}
                    </div>
                  )}
                </div>
                <span style={{ color: C.textMuted, fontSize: 14, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>›</span>
              </div>

              {isExpanded && (
                <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${C.border}` }}>
                  {item.description && (
                    <p style={{ fontSize: 14, color: C.textSec, lineHeight: 1.5, margin: '12px 0 0' }}>{item.description}</p>
                  )}
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        marginTop: 12, padding: '8px 14px', borderRadius: 10,
                        background: C.accentSoft, color: C.accent,
                        fontSize: 13, fontWeight: 600, textDecoration: 'none',
                      }}
                    >
                      Открыть ссылку ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Info block */}
      <div style={{ padding: '0 20px 20px' }}>
        <div style={{
          borderRadius: 12, padding: '12px 16px', fontSize: 13,
          background: 'rgba(96,165,250,0.08)', color: '#60A5FA', lineHeight: 1.5,
        }}>
          ℹ️ Это подборка из вишлиста. Здесь нельзя бронировать.
        </div>
      </div>

      {/* CTA */}
      <div style={{ padding: '0 20px 40px', textAlign: 'center' }}>
        <a
          href="https://t.me/WishBoardBot"
          style={{
            display: 'block', padding: '14px 0', borderRadius: 14,
            background: C.accent, color: '#fff', textDecoration: 'none',
            fontSize: 15, fontWeight: 600,
          }}
        >
          Создать свой вишлист в WishBoard
        </a>
      </div>
    </div>
  );
}
