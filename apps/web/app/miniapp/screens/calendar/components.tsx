/**
 * Shared low-level components for the Events Calendar feature.
 *
 * Source-of-truth: ui_kits/miniapp/calendar/cal.css + index.html (the design pack).
 * Tokens come from @wishlist/ui-tokens via the wb-* CSS vars on phone root.
 *
 * Note on inline styles: the app's CSS-vars-on-:root pattern means we can use
 * `var(--wb-card)` etc. directly — these resolve at runtime to the correct
 * theme/accent. Where the design uses raw rgba/hex (event-theme gradients),
 * we route through `gradients.eventBdayHero` etc.
 */

import React, { useMemo } from 'react';
import { gradients } from '@wishlist/ui-tokens';
import type { EventTheme } from './types';

// ─── Month grid cell math ─────────────────────────────────────────────────

/**
 * Build the 5- or 6-week cell grid for a month: leading days from previous
 * month, then current month's days, then trailing days padding to 35+ cells.
 * Always returns a multiple of 7. Weekends (sat/sun) are flagged for styling.
 */
export function useMonthGridCells(year: number, monthIdx: number) {
  return useMemo(() => {
    const first = new Date(Date.UTC(year, monthIdx, 1));
    const startWeekday = (first.getUTCDay() + 6) % 7; // 0=Mon
    const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
    const cells: Array<{ d: number; out: boolean; we: boolean; date: Date }> = [];
    const prevMonthDays = new Date(Date.UTC(year, monthIdx, 0)).getUTCDate();
    for (let i = startWeekday - 1; i >= 0; i--) {
      cells.push({
        d: prevMonthDays - i,
        out: true,
        we: ((startWeekday - 1 - i) % 7) >= 5,
        date: new Date(Date.UTC(year, monthIdx - 1, prevMonthDays - i)),
      });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const wd = ((startWeekday + d - 1) % 7);
      cells.push({ d, out: false, we: wd >= 5, date: new Date(Date.UTC(year, monthIdx, d)) });
    }
    while (cells.length % 7 !== 0 || cells.length < 35) {
      const i = cells.length - daysInMonth - startWeekday + 1;
      cells.push({ d: i, out: true, we: ((startWeekday + daysInMonth + i - 1) % 7) >= 5, date: new Date(Date.UTC(year, monthIdx + 1, i)) });
    }
    return { cells, daysInMonth, startWeekday };
  }, [year, monthIdx]);
}

// ─── Header ───────────────────────────────────────────────────────────────

export interface CalHeaderProps {
  title?: string | React.ReactNode;
  subtitle?: string;
  onBack?: () => void;
  rightSlot?: React.ReactNode;
}

export function CalHeader({ title, subtitle, onBack, rightSlot }: CalHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px 8px', gap: 8 }}>
      {onBack ? (
        <button onClick={onBack} aria-label="Back" style={iconBtnStyle}>←</button>
      ) : (
        <div style={{ width: 40 }} />
      )}
      <div style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
        {title && <div style={{ fontSize: 16, fontWeight: 650, letterSpacing: '-0.018em', color: 'var(--wb-text)' }}>{title}</div>}
        {subtitle && <div style={{ fontSize: 12, color: 'var(--wb-text-muted)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {rightSlot ? <div>{rightSlot}</div> : <div style={{ width: 40 }} />}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 40, height: 40, borderRadius: 14,
  background: 'var(--wb-surface)', border: '1px solid var(--wb-border)',
  WebkitBackdropFilter: 'blur(20px) saturate(140%)' as never,
  backdropFilter: 'blur(20px) saturate(140%)' as never,
  color: 'var(--wb-text)', fontSize: 17, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  fontFamily: 'inherit', padding: 0,
};

export function CalIconButton(props: { onClick?: () => void; label?: string; children: React.ReactNode }) {
  return (
    <button onClick={props.onClick} aria-label={props.label} style={iconBtnStyle}>{props.children}</button>
  );
}

// ─── ViewToggle ───────────────────────────────────────────────────────────

export function ViewToggle<T extends string>({
  options, value, onChange,
}: {
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div style={{
      display: 'flex', gap: 4, padding: 3, margin: '0 16px 14px',
      background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
      borderRadius: 12,
      WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
    }}>
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          style={{
            flex: 1, padding: '8px 8px', borderRadius: 9,
            textAlign: 'center', fontSize: 12.5, fontWeight: 600,
            color: value === o.key ? 'var(--wb-text)' : 'var(--wb-text-muted)',
            background: value === o.key ? 'var(--wb-surface)' : 'transparent',
            boxShadow: value === o.key ? '0 2px 6px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.08)' : 'none',
            border: value === o.key ? '1px solid var(--wb-border-strong)' : '1px solid transparent',
            cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '-0.005em',
          }}
        >{o.label}</button>
      ))}
    </div>
  );
}

// ─── FilterChip ───────────────────────────────────────────────────────────

export function FilterChips({ items }: {
  items: Array<{ key: string; label: string; dotColor: string; on: boolean; onToggle: () => void }>;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, padding: '0 16px 14px', flexWrap: 'wrap' }}>
      {items.map(it => (
        <button
          key={it.key}
          onClick={it.onToggle}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '6px 10px',
            background: it.on ? 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))' : 'var(--wb-surface)',
            border: it.on ? '1px solid var(--wb-border-strong)' : '1px solid var(--wb-border)',
            borderRadius: 100, fontSize: 12, fontWeight: 600,
            color: it.on ? 'var(--wb-text)' : 'var(--wb-text-muted)',
            cursor: 'pointer', fontFamily: 'inherit',
            boxShadow: it.on ? 'inset 0 1px 0 rgba(255,255,255,0.05)' : 'none',
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: it.dotColor }} />
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ─── DateTile (54x54 colored gradient with day + 3-letter month) ──────────

export function DateTile({ day, monthLabel, theme }: { day: number | string; monthLabel: string; theme: EventTheme }) {
  const tileBg = theme === 'bday' ? gradients.eventBdayTile
    : theme === 'anniversary' ? gradients.eventAnniversaryTile
    : theme === 'holiday' ? gradients.eventHolidayTile
    : theme === 'today' ? gradients.eventTodayTile
    : 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))';
  const isFlat = theme === 'custom';
  return (
    <div style={{
      width: 54, height: 54, borderRadius: 14,
      background: tileBg,
      border: isFlat ? '1px solid var(--wb-border)' : 'none',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, color: '#fff',
      boxShadow: isFlat ? 'none' : '0 6px 18px var(--wb-accent-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.22)',
    }}>
      <div style={{ fontSize: 22, fontWeight: 750, lineHeight: 1, letterSpacing: '-0.025em', fontFeatureSettings: '"tnum"' }}>{day}</div>
      <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.85, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{monthLabel}</div>
    </div>
  );
}

// ─── EventCard (date tile + body + countdown + trail) ─────────────────────

export interface EventCardProps {
  day: number | string;
  monthLabel: string;
  theme: EventTheme;
  emoji?: string | null;
  title: string;
  countdown?: string | null;
  sub?: string | null;
  onClick?: () => void;
  rightTrail?: React.ReactNode;
}

export function EventCard({ day, monthLabel, theme, emoji, title, countdown, sub, onClick, rightTrail = '›' }: EventCardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', gap: 14, alignItems: 'center',
        margin: '0 16px 10px', padding: 14,
        background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
        borderRadius: 18, cursor: onClick ? 'pointer' : 'default',
        WebkitBackdropFilter: 'blur(14px)' as never, backdropFilter: 'blur(14px)' as never,
      }}
    >
      <DateTile day={day} monthLabel={monthLabel} theme={theme} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--wb-text)', letterSpacing: '-0.012em', lineHeight: 1.25 }}>
          {emoji && <span style={{ marginRight: 6 }}>{emoji}</span>}
          {title}
        </div>
        {(countdown || sub) && (
          <div style={{ fontSize: 12.5, color: 'var(--wb-text-secondary)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {countdown && (
              <span style={{
                fontSize: 11, fontWeight: 700,
                color: 'var(--wb-accent-strong)',
                background: 'var(--wb-accent-soft)',
                padding: '2px 7px', borderRadius: 6,
                letterSpacing: '0.1px',
              }}>{countdown}</span>
            )}
            {sub && <span>{sub}</span>}
          </div>
        )}
      </div>
      {rightTrail && <div style={{ fontSize: 18, color: 'var(--wb-text-muted)' }}>{rightTrail}</div>}
    </div>
  );
}

// ─── BannerStrip ──────────────────────────────────────────────────────────

export function BannerStrip({ icon, title, sub, onClick, accent, rightSlot }: {
  icon: string;
  title: string;
  sub?: string;
  onClick?: () => void;
  accent?: boolean;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        margin: '4px 16px 14px', padding: '12px 14px', borderRadius: 16,
        background: accent
          ? 'linear-gradient(135deg, var(--wb-accent-soft), var(--wb-card))'
          : 'linear-gradient(135deg, rgba(240,106,180,0.18), rgba(139,123,255,0.18))',
        border: accent ? '1px solid var(--wb-accent-soft-strong)' : '1px solid rgba(240,106,180,0.28)',
        display: 'flex', alignItems: 'center', gap: 12, cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 10,
        background: 'rgba(255,255,255,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
        flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--wb-text)', letterSpacing: '-0.01em' }}>{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--wb-text-secondary)', marginTop: 1 }}>{sub}</div>}
      </div>
      {rightSlot ?? (onClick ? <div style={{ fontSize: 18, color: 'var(--wb-text-muted)', flexShrink: 0 }}>›</div> : null)}
    </div>
  );
}

// ─── Toggle ────────────────────────────────────────────────────────────────

export function Toggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
      aria-pressed={on}
      style={{
        width: 46, height: 28, borderRadius: 100,
        background: on ? 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))' : 'rgba(255,255,255,0.08)',
        border: on ? '1px solid transparent' : '1px solid var(--wb-border)',
        position: 'relative', flexShrink: 0,
        transition: 'all .2s ease',
        cursor: 'pointer', padding: 0,
        boxShadow: on ? '0 0 16px var(--wb-accent-shadow-soft)' : 'none',
      }}
    >
      <span style={{
        position: 'absolute', top: 1, left: on ? 21 : 1,
        width: 22, height: 22, borderRadius: '50%',
        background: '#fff', transition: 'left .25s cubic-bezier(.4,0,.2,1)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)', display: 'block',
      }} />
    </button>
  );
}

// ─── ReminderRow ──────────────────────────────────────────────────────────

export function ReminderRow({ offsetLabel, title, sub, on, onChange }: {
  offsetLabel: string;
  title: string;
  sub?: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', borderTop: '1px solid var(--wb-hairline)',
    }}>
      <div style={{
        fontSize: 13, fontWeight: 700, color: 'var(--wb-accent-strong)',
        background: 'var(--wb-accent-soft)',
        border: '1px solid var(--wb-accent-soft-strong)',
        padding: '4px 10px', borderRadius: 8,
        fontFeatureSettings: '"tnum"',
        minWidth: 52, textAlign: 'center', flexShrink: 0,
      }}>{offsetLabel}</div>
      <div style={{ flex: 1, fontSize: 13, color: 'var(--wb-text)', letterSpacing: '-0.005em' }}>
        {title}
        {sub && <div style={{ fontSize: 11.5, color: 'var(--wb-text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

// ─── InfoRow (used on detail screens) ────────────────────────────────────

export function InfoGroup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      margin: '0 16px 16px',
      background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
      borderRadius: 20,
      WebkitBackdropFilter: 'blur(14px)' as never, backdropFilter: 'blur(14px)' as never,
      overflow: 'hidden',
    }}>{children}</div>
  );
}

export function InfoRow({ icon, label, value, trail, tinted, onClick }: {
  icon: string;
  label: string;
  value: React.ReactNode;
  trail?: React.ReactNode;
  tinted?: boolean;
  onClick?: () => void;
}) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '13px 16px', borderTop: '1px solid var(--wb-hairline)',
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 11,
        background: tinted ? 'var(--wb-accent-soft)' : 'var(--wb-surface)',
        border: tinted ? '1px solid var(--wb-accent-soft-strong)' : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 16, flexShrink: 0,
        color: tinted ? 'var(--wb-accent-strong)' : 'var(--wb-text-secondary)',
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--wb-text-muted)', fontWeight: 600, letterSpacing: 0.1 }}>{label}</div>
        <div style={{ fontSize: 14, color: 'var(--wb-text)', fontWeight: 600, marginTop: 1, letterSpacing: '-0.005em' }}>{value}</div>
      </div>
      {trail && <div style={{ fontSize: 18, color: 'var(--wb-text-muted)', flexShrink: 0 }}>{trail}</div>}
    </div>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────

export function SectionH({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: 'var(--wb-text-muted)',
      textTransform: 'uppercase', letterSpacing: '0.6px',
      padding: '6px 22px 8px',
    }}>{children}</div>
  );
}

// ─── Form bits ────────────────────────────────────────────────────────────

export function FormLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: 'var(--wb-text-muted)',
      textTransform: 'uppercase', letterSpacing: 0.7,
      margin: '8px 20px 8px',
    }}>{children}</div>
  );
}

export function CalInput(props: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: 'text' | 'number';
  maxLength?: number;
}) {
  return (
    <div style={{ margin: '0 16px 14px', position: 'relative' }}>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
          borderRadius: 16, padding: '14px 16px',
          fontFamily: 'inherit', fontSize: 15, fontWeight: 500,
          color: 'var(--wb-text)',
          WebkitBackdropFilter: 'blur(14px)' as never, backdropFilter: 'blur(14px)' as never,
          outline: 'none',
        }}
      />
    </div>
  );
}

export function EmojiPicker({ value, options, onChange }: { value: string | null; options: string[]; onChange: (next: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, margin: '0 16px 14px', flexWrap: 'wrap' }}>
      {options.map(e => {
        const active = e === value;
        return (
          <button
            key={e}
            onClick={() => onChange(e)}
            style={{
              width: 44, height: 44, borderRadius: 13,
              background: active ? 'linear-gradient(135deg, var(--wb-accent-soft), var(--wb-card-strong))' : 'var(--wb-card)',
              border: active ? '1px solid var(--wb-accent-soft-strong)' : '1px solid var(--wb-border)',
              fontSize: 22, cursor: 'pointer', fontFamily: 'inherit',
              WebkitBackdropFilter: 'blur(10px)' as never, backdropFilter: 'blur(10px)' as never,
              boxShadow: active ? '0 0 0 3px var(--wb-accent-soft)' : 'none',
              transition: 'all .15s ease', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >{e}</button>
        );
      })}
    </div>
  );
}

export function RepeatChips<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ key: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, margin: '0 16px 14px', overflowX: 'auto' }}>
      {options.map(o => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            style={{
              padding: '8px 14px', borderRadius: 100, flexShrink: 0,
              background: active ? 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))' : 'var(--wb-card)',
              border: active ? '1px solid var(--wb-border-strong)' : '1px solid var(--wb-border)',
              fontSize: 12.5, fontWeight: 600,
              color: active ? 'var(--wb-text)' : 'var(--wb-text-secondary)',
              cursor: 'pointer', fontFamily: 'inherit',
              WebkitBackdropFilter: 'blur(10px)' as never, backdropFilter: 'blur(10px)' as never,
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

// ─── Sticky CTA at bottom ──────────────────────────────────────────────────

// Bottom padding clears the floating bottom-nav (sits ~14px from edge, ~52px tall) +
// the safe-area inset on devices with home-indicator. Otherwise the CTA gets hidden
// behind the tab bar.
export function CtaBar({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'sticky', bottom: 0, left: 0, right: 0,
      padding: `16px 16px calc(96px + env(safe-area-inset-bottom))`,
      background: 'linear-gradient(180deg, transparent, var(--wb-bg) 30%)',
      display: 'flex', flexDirection: 'column', gap: 6,
      pointerEvents: 'none',
    }}>
      <div style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

// ─── Date helpers ─────────────────────────────────────────────────────────

const MONTH_LABELS_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const MONTH_LABELS_EN = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_LABELS_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const MONTH_LABELS_AR = ['ينا','فبر','مار','أبر','ماي','يون','يول','أغس','سبت','أكت','نوف','ديس'];
const MONTH_LABELS_HI = ['जन','फर','मार्च','अप','मई','जून','जुल','अग','सित','अक्ट','नव','दिस'];
const MONTH_LABELS_ZH = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

export function monthLabelShort(monthIdx: number, locale: string): string {
  const arr =
    locale === 'en' ? MONTH_LABELS_EN
    : locale === 'es' ? MONTH_LABELS_ES
    : locale === 'ar' ? MONTH_LABELS_AR
    : locale === 'hi' ? MONTH_LABELS_HI
    : locale === 'zh-CN' ? MONTH_LABELS_ZH
    : MONTH_LABELS_RU;
  return arr[monthIdx] ?? '';
}

const MONTH_LABELS_RU_LONG = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTH_LABELS_EN_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function monthLabelLong(monthIdx: number, locale: string): string {
  if (locale === 'ru') return MONTH_LABELS_RU_LONG[monthIdx] ?? '';
  return MONTH_LABELS_EN_LONG[monthIdx] ?? '';
}

const WEEKDAY_LABELS_RU = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const WEEKDAY_LABELS_EN = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const WEEKDAY_LABELS_AR = ['اثن','ثلا','أرب','خمي','جمع','سبت','أحد'];
const WEEKDAY_LABELS_HI = ['सोम','मंगल','बुध','गुरु','शुक्र','शनि','रवि'];
const WEEKDAY_LABELS_ZH = ['一','二','三','四','五','六','日'];
const WEEKDAY_LABELS_ES = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

export function weekdayLabels(locale: string): string[] {
  if (locale === 'en') return WEEKDAY_LABELS_EN;
  if (locale === 'ar') return WEEKDAY_LABELS_AR;
  if (locale === 'hi') return WEEKDAY_LABELS_HI;
  if (locale === 'zh-CN') return WEEKDAY_LABELS_ZH;
  if (locale === 'es') return WEEKDAY_LABELS_ES;
  return WEEKDAY_LABELS_RU;
}
