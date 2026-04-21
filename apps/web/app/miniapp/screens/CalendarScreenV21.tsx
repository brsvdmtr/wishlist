'use client';

import React, { useState } from 'react';
import { Button } from '@wishlist/ui';

/**
 * v2.1 Calendar screen — full UI scaffold for an upcoming feature.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * (CalendarScreen).
 *
 * **Status: stub.** No backend yet. All interactions show a "coming soon"
 * toast via `onComingSoon` callback. Once backend lands (events / birthdays
 * / Santa-tied dates), wire real data + handlers in place of the demo
 * fixtures.
 */

export interface CalendarScreenV21Props {
  onBack: () => void;
  /** Fired on every interactive element until backend lands. */
  onComingSoon: (label?: string) => void;
}

interface CalCell {
  d: number;
  out?: boolean;
  we?: boolean;
  today?: boolean;
  event?: 'accent' | 'bday' | 'ny' | 'wed';
  emoji?: string;
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Fixtures — December 2026 demo grid, mirrors the v2.1 mockup exactly.
const CELLS: CalCell[] = [
  { d: 30, out: true }, { d: 1 },
  { d: 2 }, { d: 3 }, { d: 4 }, { d: 5, we: true }, { d: 6, we: true },
  { d: 7 }, { d: 8 }, { d: 9 }, { d: 10, event: 'accent', emoji: '🎂' }, { d: 11 }, { d: 12, we: true }, { d: 13, we: true },
  { d: 14 }, { d: 15 }, { d: 16, event: 'wed', emoji: '💍' }, { d: 17 }, { d: 18 }, { d: 19, we: true, today: true }, { d: 20, we: true },
  { d: 21 }, { d: 22, event: 'bday', emoji: '🎉' }, { d: 23 }, { d: 24 }, { d: 25 }, { d: 26, we: true }, { d: 27, we: true },
  { d: 28 }, { d: 29 }, { d: 30 }, { d: 31, event: 'ny', emoji: '🎄' }, { d: 1, out: true }, { d: 2, out: true, we: true }, { d: 3, out: true, we: true },
];

const EVENTS = [
  { date: '10', month: 'дек', tone: 'accent', icon: '🎂', title: 'Др Миши Петрова', countdown: 'через 2 дня', sub: '3 идеи в вишлисте' },
  { date: '22', month: 'дек', tone: 'pink', icon: '🎉', title: 'Ноа 1 годик', countdown: null, sub: 'Семейный праздник · 12:00' },
  { date: '16', month: 'дек', tone: 'warn', icon: '💍', title: 'Годовщина свадьбы', countdown: null, sub: '8 лет вместе · повтор ежегодно' },
  { date: '31', month: 'дек', tone: 'green', icon: '🎄', title: 'Новый год', countdown: 'через 12 дней', sub: 'Тайный Санта · 6 участников' },
] as const;

export function CalendarScreenV21({ onBack, onComingSoon }: CalendarScreenV21Props) {
  const [selected, setSelected] = useState(19);

  return (
    <div style={{
      padding: '12px 0 calc(40px + env(safe-area-inset-bottom))',
      minHeight: '100%',
      color: 'var(--wb-text)',
    }}>
      {/* Header — back chevron + Centered "Календарь" + add */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', gap: 8 }}>
        <button onClick={onBack} style={{
          width: 40, height: 40, borderRadius: 14,
          background: 'var(--wb-surface)', border: '1px solid var(--wb-border)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)' as never,
          backdropFilter: 'blur(20px) saturate(140%)' as never,
          color: 'var(--wb-text)', fontSize: 17, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>←</button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 650, letterSpacing: '-0.018em' }}>
          Календарь
        </div>
        <button onClick={() => onComingSoon('Добавление события скоро будет доступно')} style={{
          width: 40, height: 40, borderRadius: 14,
          background: 'var(--wb-surface)', border: '1px solid var(--wb-border)',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)' as never,
          backdropFilter: 'blur(20px) saturate(140%)' as never,
          color: 'var(--wb-text)', fontSize: 18, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>+</button>
      </div>

      {/* Year + month + nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--wb-text-muted)', letterSpacing: '0.8px', textTransform: 'uppercase' as const }}>
            2026
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.025em' }}>
            Декабрь
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { kind: 'prev', label: '‹' },
            { kind: 'today', label: 'Сегодня' },
            { kind: 'next', label: '›' },
          ].map((b) => (
            <button
              key={b.kind}
              onClick={() => onComingSoon('Навигация по месяцам скоро будет доступна')}
              style={{
                height: 34,
                width: b.kind === 'today' ? 'auto' : 34,
                padding: b.kind === 'today' ? '0 12px' : 0,
                borderRadius: 12,
                background: 'var(--wb-surface)',
                border: '1px solid var(--wb-border)',
                color: b.kind === 'today' ? 'var(--wb-text)' : 'var(--wb-text-secondary)',
                fontSize: b.kind === 'today' ? 12 : 15,
                fontWeight: b.kind === 'today' ? 600 : 500,
                fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
                WebkitBackdropFilter: 'blur(12px)' as never,
                backdropFilter: 'blur(12px)' as never,
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Weekdays */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 12px 6px' }}>
        {WEEKDAYS.map((w, i) => (
          <div key={w} style={{
            textAlign: 'center' as const,
            fontSize: 10, fontWeight: 600,
            color: 'var(--wb-text-muted)',
            textTransform: 'uppercase' as const,
            letterSpacing: '0.6px',
            padding: '4px 0',
            opacity: i >= 5 ? 0.55 : 1,
          }}>
            {w}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 12px 14px', gap: 2 }}>
        {CELLS.map((c, i) => {
          const isSelected = !c.out && c.d === selected;
          let cellBg: string | undefined;
          let cellBorder: string | undefined;
          if (isSelected) {
            cellBg = 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))';
          } else if (c.event === 'accent') {
            cellBg = 'var(--wb-accent-soft)';
            cellBorder = '1px solid var(--wb-accent-soft-strong)';
          } else if (c.event === 'bday') {
            cellBg = 'rgba(240,106,180,0.15)';
            cellBorder = '1px solid rgba(240,106,180,0.4)';
          } else if (c.event === 'ny') {
            cellBg = 'rgba(74,222,128,0.15)';
            cellBorder = '1px solid rgba(74,222,128,0.4)';
          } else if (c.event === 'wed') {
            cellBg = 'rgba(251,191,36,0.14)';
            cellBorder = '1px solid rgba(251,191,36,0.4)';
          } else if (c.today) {
            cellBg = 'var(--wb-surface)';
            cellBorder = '1px solid var(--wb-border-strong)';
          }
          return (
            <button
              key={i}
              onClick={() => !c.out && setSelected(c.d)}
              disabled={c.out}
              style={{
                aspectRatio: '1 / 1',
                position: 'relative',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                borderRadius: 12,
                border: cellBorder ?? 'none',
                background: cellBg ?? 'transparent',
                fontSize: 13, fontWeight: 550,
                fontFamily: 'inherit',
                fontFeatureSettings: '"tnum"',
                color: isSelected ? '#fff'
                  : c.out ? 'var(--wb-text-muted)'
                  : c.event ? 'var(--wb-text)'
                  : 'var(--wb-text-secondary)',
                opacity: c.out ? 0.3 : 1,
                cursor: c.out ? 'default' : 'pointer',
                transition: 'all 0.15s ease',
                boxShadow: isSelected ? '0 6px 16px var(--wb-accent-shadow)' : undefined,
              }}
            >
              <span>{c.d}</span>
              {c.emoji && <span style={{ fontSize: 10, lineHeight: 1, marginTop: 1 }}>{c.emoji}</span>}
            </button>
          );
        })}
      </div>

      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0 20px', marginBottom: 10 }}>
        <h2 style={{
          margin: 0, fontSize: 12, fontWeight: 600,
          color: 'var(--wb-text-muted)',
          textTransform: 'uppercase' as const, letterSpacing: '0.7px',
        }}>
          Ближайшие события
        </h2>
        <button
          onClick={() => onComingSoon('Создание события скоро будет доступно')}
          style={{
            fontSize: 13, color: 'var(--wb-accent-strong)', fontWeight: 600,
            background: 'transparent', border: 'none', cursor: 'pointer',
            fontFamily: 'inherit', padding: 0,
          }}
        >
          + Событие
        </button>
      </div>

      {/* Events list */}
      <div style={{ padding: '0 16px' }}>
        {EVENTS.map((e, i) => (
          <div
            key={i}
            onClick={() => onComingSoon('Детали события скоро будут доступны')}
            className="wb-card-pressed"
            style={{
              display: 'flex', gap: 14, alignItems: 'center',
              marginBottom: 10, padding: 14,
              background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
              borderRadius: 18, cursor: 'pointer',
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
              position: 'relative', overflow: 'hidden',
            }}
          >
            <div style={{
              width: 54, height: 54, borderRadius: 14,
              background:
                e.tone === 'accent' ? 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))'
                : e.tone === 'pink' ? 'linear-gradient(135deg, #F06AB4, #C53F88)'
                : e.tone === 'green' ? 'linear-gradient(135deg, #34C98A, #1E9765)'
                : e.tone === 'warn' ? 'linear-gradient(135deg, #FBBF24, #D97706)'
                : 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))',
              border: e.tone === 'accent' || e.tone === 'pink' || e.tone === 'green' || e.tone === 'warn' ? 'none' : '1px solid var(--wb-border)',
              display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, color: '#fff',
              boxShadow: e.tone === 'accent'
                ? '0 6px 18px var(--wb-accent-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.22)'
                : 'inset 0 1px 0 rgba(255,255,255,0.22)',
            }}>
              <div style={{ fontSize: 22, fontWeight: 750, lineHeight: 1, letterSpacing: '-0.025em', fontFeatureSettings: '"tnum"' }}>{e.date}</div>
              <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.85, marginTop: 2, textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>{e.month}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--wb-text)', letterSpacing: '-0.012em', lineHeight: 1.25 }}>
                <span style={{ marginRight: 6 }}>{e.icon}</span>
                {e.title}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--wb-text-secondary)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const }}>
                {e.countdown && (
                  <span style={{
                    fontSize: 11, fontWeight: 700,
                    color: 'var(--wb-accent-strong)',
                    background: 'var(--wb-accent-soft)',
                    padding: '2px 7px', borderRadius: 6,
                    letterSpacing: '0.1px',
                  }}>{e.countdown}</span>
                )}
                <span>{e.sub}</span>
              </div>
            </div>
            <div style={{ fontSize: 18, color: 'var(--wb-text-muted)' }}>›</div>
          </div>
        ))}
      </div>

      {/* Coming-soon banner */}
      <div style={{ padding: '24px 20px 12px' }}>
        <Button
          variant="surface"
          fullWidth
          onClick={() => onComingSoon('Календарь скоро будет полноценно работать с твоими дедлайнами и днями рождения')}
        >
          Скоро появится
        </Button>
      </div>
    </div>
  );
}
