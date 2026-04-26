/**
 * Year Recap — section G of the design.
 *
 * Annual summary: gifts given, birthdays celebrated, on-time %, total spent,
 * top recipient, per-month bar histogram. "Share" generates a deep-link to
 * the same recap that the user can post to Telegram stories.
 */

'use client';

import React, { useEffect, useState } from 'react';
import type { Locale } from '@wishlist/shared';
import { gradients } from '@wishlist/ui-tokens';
import type { TgFetch } from './api';
import * as api from './api';
import type { YearRecapData } from './types';
import { CalHeader, CalIconButton, CtaBar } from './components';
import { ct } from './i18n';

export function CalendarRecap({ tgFetch, locale, year, onBack, onShowToast }: {
  tgFetch: TgFetch; locale: Locale; year: number; onBack: () => void; onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
}) {
  const [data, setData] = useState<YearRecapData | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getYearRecap(tgFetch, year);
        if (!cancelled) setData(r);
      } catch (err) {
        if (!cancelled) onShowToast('Не удалось загрузить отчёт', 'error');
        // eslint-disable-next-line no-console
        console.error('Recap load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [tgFetch, year, onShowToast]);

  if (!data) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--wb-text-muted)' }}>…</div>;
  }

  const totalSpentFormatted = formatSpend(data.spend.byCurrency);
  const avgSpend = data.totals.giftsGiven > 0 && Object.keys(data.spend.byCurrency).length > 0
    ? Math.round(Object.values(data.spend.byCurrency)[0]! / data.totals.giftsGiven)
    : 0;
  const maxBar = Math.max(...data.perMonthGifts, 1);

  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)', paddingBottom: 'calc(120px + env(safe-area-inset-bottom))' }}>
      <CalHeader
        onBack={onBack}
        rightSlot={<CalIconButton label="Share">↗</CalIconButton>}
      />

      {/* Hero */}
      <div style={{
        margin: '0 16px 16px', padding: '26px 22px', borderRadius: 28,
        position: 'relative', overflow: 'hidden',
        background: gradients.recapHero,
        color: '#fff',
        boxShadow: '0 20px 60px rgba(139,123,255,0.25), inset 0 1px 0 rgba(255,255,255,0.16)',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', opacity: 0.8, marginBottom: 6 }}>
          {ct('cal_recap_eyebrow', locale)}
        </div>
        <div style={{ fontSize: 56, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.04em', fontFeatureSettings: '"tnum"' }}>
          {data.year}
        </div>
        <div style={{ fontSize: 14, opacity: 0.85, marginTop: 8, lineHeight: 1.5, maxWidth: 260, letterSpacing: '-0.005em' }}>
          {ct('cal_recap_sub', locale)}
        </div>
      </div>

      {/* Stat grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, margin: '0 16px 16px' }}>
        {/* Gifts given (span2 with histogram) */}
        <RecapCard span2 glyph="🎁" big={String(data.totals.giftsGiven)} label={ct('cal_recap_gifts_given', locale)}>
          <div style={{ marginTop: 12, display: 'flex', gap: 3, height: 36, alignItems: 'flex-end' }}>
            {data.perMonthGifts.map((v, i) => (
              <div key={i} style={{
                flex: 1, height: `${(v / maxBar) * 100}%`, minHeight: 4,
                borderRadius: 3,
                background: v < maxBar / 3 ? 'rgba(255,255,255,0.06)' : 'linear-gradient(180deg, var(--wb-accent), var(--wb-accent-deep))',
                boxShadow: v >= maxBar / 3 ? 'inset 0 1px 0 rgba(255,255,255,0.2)' : 'none',
              }} />
            ))}
          </div>
        </RecapCard>

        {/* Birthdays */}
        <RecapCard glyph="🎂" glyphBg="rgba(240,106,180,0.18)" glyphBorder="rgba(240,106,180,0.32)" big={String(data.totals.birthdays)} label={ct('cal_recap_birthdays', locale)} />

        {/* On-time % */}
        <RecapCard glyph="✓" glyphBg="rgba(74,222,128,0.18)" glyphBorder="rgba(74,222,128,0.32)" big={`${data.totals.onTimePct}%`} label={ct('cal_recap_on_time', locale)} />

        {/* Total spent */}
        {totalSpentFormatted && (
          <RecapCard span2 glyph="★" glyphBg="rgba(251,191,36,0.18)" glyphBorder="rgba(251,191,36,0.32)" big={totalSpentFormatted} label={`${ct('cal_recap_total_spent', locale)} · ${ct('cal_recap_avg', locale)} ${avgSpend}`} />
        )}

        {/* Top recipient */}
        {data.topRecipient && (
          <RecapCard span2 glyph="💝" big={`«${data.topRecipient.name}»`} smallBig label={`${ct('cal_recap_top_sub', locale)} · ${data.topRecipient.count}×`} />
        )}
      </div>

      <CtaBar>
        <button
          onClick={() => {
            // Share via Telegram WebApp shareUrl
            const tg = (window as unknown as { Telegram?: { WebApp?: { openTelegramLink?: (link: string) => void; shareLink?: (link: string) => void } } }).Telegram?.WebApp;
            const text = `WishBoard · ${ct('cal_recap_eyebrow', locale)} ${data.year}`;
            const url = `https://t.me/share/url?url=https://t.me/WishBoardBot/app&text=${encodeURIComponent(text)}`;
            if (tg?.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank');
          }}
          style={{
            padding: '15px 22px', borderRadius: 18, border: 'none',
            background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
            color: '#fff', fontSize: 15, fontWeight: 650, letterSpacing: '-0.015em',
            cursor: 'pointer', minHeight: 52, fontFamily: 'inherit', width: '100%',
            boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
          }}
        >{ct('cal_recap_share', locale)}</button>
      </CtaBar>
    </div>
  );
}

function RecapCard({ children, glyph, big, label, span2, glyphBg, glyphBorder, smallBig }: {
  children?: React.ReactNode;
  glyph: string;
  big: string;
  label: string;
  span2?: boolean;
  glyphBg?: string;
  glyphBorder?: string;
  smallBig?: boolean;
}) {
  return (
    <div style={{
      gridColumn: span2 ? 'span 2' : undefined,
      padding: '18px 14px', borderRadius: 22,
      background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
      WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        display: 'inline-flex', padding: 8, borderRadius: 10,
        background: glyphBg ?? 'var(--wb-accent-soft)',
        border: `1px solid ${glyphBorder ?? 'var(--wb-accent-soft-strong)'}`,
        marginBottom: 12, fontSize: 22, lineHeight: 1,
      }}>{glyph}</div>
      <div style={{
        fontSize: smallBig ? 18 : 30, fontWeight: 750, letterSpacing: '-0.03em',
        color: 'var(--wb-text)', fontFeatureSettings: '"tnum"', lineHeight: smallBig ? 1.3 : 1,
      }}>{big}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--wb-text-secondary)', marginTop: 4, letterSpacing: '-0.005em' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function formatSpend(byCurrency: Record<string, number>): string | null {
  const entries = Object.entries(byCurrency);
  if (entries.length === 0) return null;
  return entries.map(([cur, amount]) => `${amount.toLocaleString('ru-RU')} ${cur}`).join(' + ');
}
