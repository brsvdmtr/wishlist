/**
 * Calendar main screen — header + view toggle + filters + view body.
 * Hosts month / week / list / year sub-views.
 */

'use client';

import React, { useMemo, useState } from 'react';
import type { Locale } from '@wishlist/shared';
import { gradients } from '@wishlist/ui-tokens';
import type { OccasionListItem, CalendarView, TodayContext } from './types';
import { inferTheme, defaultEmojiForType } from './types';
import {
  CalHeader, CalIconButton, ViewToggle, FilterChips, EventCard, SectionH,
  monthLabelShort, monthLabelLong, weekdayLabels, useMonthGridCells,
} from './components';
import { ct, ctDays } from './i18n';

interface Filters { birthdays: boolean; anniversaries: boolean; holidays: boolean; own: boolean }

interface Props {
  locale: Locale;
  occasions: OccasionListItem[];
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  todayContext: TodayContext | null;
  view: CalendarView;
  onViewChange: (v: CalendarView) => void;
  loading: boolean;
  onBack: () => void;
  onAdd: () => void;
  onOpenOccasion: (id: string) => void;
  onOpenInbox: () => void;
  onOpenRecap: (year: number) => void;
  onOpenImportFriends: () => void;
  onOpenImportHolidays: () => void;
}

export function CalendarMain(props: Props) {
  const { locale, occasions, filters, view, todayContext } = props;
  const now = new Date();
  const [navYear, setNavYear] = useState(now.getUTCFullYear());
  const [navMonth, setNavMonth] = useState(now.getUTCMonth());

  // Filter active occasions by user toggles
  const filtered = useMemo(() => {
    return occasions.filter(o => {
      if (o.status !== 'ACTIVE') return false;
      if (o.type === 'BIRTHDAY' && !filters.birthdays) return false;
      if (o.type === 'ANNIVERSARY' && !filters.anniversaries) return false;
      if (o.type === 'HOLIDAY' && !filters.holidays) return false;
      if (o.type === 'OTHER' && !filters.own) return false;
      return true;
    });
  }, [occasions, filters]);

  // Empty-state: no events at all (regardless of filters)
  const isEmpty = occasions.filter(o => o.status === 'ACTIVE').length === 0;

  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)', paddingBottom: 'calc(120px + env(safe-area-inset-bottom))' }}>
      <CalHeader
        title={ct('cal_title', locale)}
        subtitle={`${monthLabelLong(navMonth, locale)} ${navYear}`}
        onBack={props.onBack}
        rightSlot={
          <div style={{ display: 'flex', gap: 6 }}>
            <CalIconButton onClick={props.onOpenInbox} label="Inbox">🔔</CalIconButton>
            <CalIconButton onClick={props.onAdd} label="Add">+</CalIconButton>
          </div>
        }
      />

      <ViewToggle<CalendarView>
        value={view}
        onChange={props.onViewChange}
        options={[
          { key: 'month', label: ct('cal_view_month', locale) },
          { key: 'week',  label: ct('cal_view_week', locale) },
          { key: 'list',  label: ct('cal_view_list', locale) },
          { key: 'year',  label: ct('cal_view_year', locale) },
        ]}
      />

      {(view === 'month' || view === 'week') && (
        <FilterChips items={[
          { key: 'birthdays', label: `${ct('cal_filter_birthdays', locale)} · ${countByType(occasions, 'BIRTHDAY')}`, dotColor: '#F06AB4', on: filters.birthdays, onToggle: () => props.onFiltersChange({ ...filters, birthdays: !filters.birthdays }) },
          { key: 'holidays',  label: `${ct('cal_filter_holidays', locale)} · ${countByType(occasions, 'HOLIDAY')}`, dotColor: '#34C98A', on: filters.holidays, onToggle: () => props.onFiltersChange({ ...filters, holidays: !filters.holidays }) },
          { key: 'anniversaries', label: `${ct('cal_filter_anniversaries', locale)} · ${countByType(occasions, 'ANNIVERSARY')}`, dotColor: '#FBBF24', on: filters.anniversaries, onToggle: () => props.onFiltersChange({ ...filters, anniversaries: !filters.anniversaries }) },
          { key: 'own',  label: `${ct('cal_filter_own', locale)} · ${countByType(occasions, 'OTHER')}`, dotColor: 'var(--wb-accent)', on: filters.own, onToggle: () => props.onFiltersChange({ ...filters, own: !filters.own }) },
        ]} />
      )}

      {!isEmpty && (
        <ImportPills
          onImportHolidays={props.onOpenImportHolidays}
          onImportFriends={props.onOpenImportFriends}
          locale={locale}
        />
      )}

      {view === 'month' && (
        <>
          <MonthHeader
            year={navYear} monthIdx={navMonth}
            onPrev={() => stepMonth(navYear, navMonth, -1, setNavYear, setNavMonth)}
            onNext={() => stepMonth(navYear, navMonth, +1, setNavYear, setNavMonth)}
            onToday={() => { setNavYear(now.getUTCFullYear()); setNavMonth(now.getUTCMonth()); }}
            locale={locale}
          />
          <MonthGrid year={navYear} monthIdx={navMonth} occasions={filtered} locale={locale} onCellClick={(date) => {
            // Find first event on that date and open it
            const ev = filtered.find(o => isSameDayLocal(occasionNextDate(o), date));
            if (ev) props.onOpenOccasion(ev.id);
          }} />
          {todayContext?.soonest && <TodayCard locale={locale} ctx={todayContext} onOpen={() => props.onOpenOccasion(todayContext.soonest!.id)} />}
          <SectionH>{ct('cal_upcoming', locale)}</SectionH>
          {filtered.length === 0
            ? <Empty locale={locale} {...emptyHandlers(props)} isFiltered={!isEmpty} />
            : (
              <UpcomingList items={filtered.slice(0, 6)} locale={locale} onOpen={props.onOpenOccasion} />
            )}
        </>
      )}

      {view === 'week' && <WeekView locale={locale} occasions={filtered} onOpen={props.onOpenOccasion} />}
      {view === 'list' && <ListView locale={locale} occasions={filtered} onOpen={props.onOpenOccasion} />}
      {view === 'year' && <YearView locale={locale} occasions={filtered} year={navYear} onChangeYear={setNavYear} onOpenRecap={() => props.onOpenRecap(navYear - 1)} />}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function countByType(arr: OccasionListItem[], type: OccasionListItem['type']): number {
  return arr.filter(o => o.type === type && o.status === 'ACTIVE').length;
}

function stepMonth(
  y: number, m: number, delta: number,
  setY: (next: number) => void, setM: (next: number) => void,
) {
  let nm = m + delta;
  let ny = y;
  while (nm < 0) { nm += 12; ny -= 1; }
  while (nm > 11) { nm -= 12; ny += 1; }
  setY(ny); setM(nm);
}

function occasionNextDate(o: OccasionListItem): Date | null {
  if (!o.nextDate) return null;
  return new Date(o.nextDate);
}

function isSameDayLocal(a: Date | null, b: Date): boolean {
  if (!a) return false;
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function emptyHandlers(props: Props) {
  return {
    onAddEvent: props.onAdd,
    onImportFriends: props.onOpenImportFriends,
    onImportHolidays: props.onOpenImportHolidays,
  };
}

// ─── MonthHeader ──────────────────────────────────────────────────────────

function MonthHeader({ year, monthIdx, onPrev, onNext, onToday, locale }: { year: number; monthIdx: number; onPrev: () => void; onNext: () => void; onToday: () => void; locale: Locale }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px 12px' }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--wb-text-muted)', letterSpacing: 0.8, textTransform: 'uppercase' }}>{year}</div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--wb-text)' }}>{monthLabelLong(monthIdx, locale)}</div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onPrev} style={navBtnStyle}>‹</button>
        <button onClick={onToday} style={{ ...navBtnStyle, width: 'auto', padding: '0 12px', fontSize: 12 }}>{ct('cal_today', locale)}</button>
        <button onClick={onNext} style={navBtnStyle}>›</button>
      </div>
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  width: 34, height: 34, borderRadius: 12,
  background: 'var(--wb-surface)', border: '1px solid var(--wb-border)',
  color: 'var(--wb-text-secondary)', fontSize: 15, fontWeight: 500,
  fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
  WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
};

// ─── MonthGrid ────────────────────────────────────────────────────────────

function MonthGrid({ year, monthIdx, occasions, locale, onCellClick }: { year: number; monthIdx: number; occasions: OccasionListItem[]; locale: Locale; onCellClick: (date: Date) => void }) {
  const { cells } = useMonthGridCells(year, monthIdx);
  const today = new Date();

  // Build a map: date-key → occasion (first match)
  const dayMap = useMemo(() => {
    const map = new Map<string, OccasionListItem>();
    for (const o of occasions) {
      const next = occasionNextDate(o);
      if (!next) continue;
      const key = `${next.getUTCFullYear()}-${next.getUTCMonth()}-${next.getUTCDate()}`;
      if (!map.has(key)) map.set(key, o);
    }
    return map;
  }, [occasions]);

  const wd = weekdayLabels(locale);

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 12px 6px' }}>
        {wd.map((w, i) => (
          <div key={w} style={{
            textAlign: 'center', fontSize: 10, fontWeight: 600,
            color: 'var(--wb-text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.6,
            padding: '4px 0', opacity: i >= 5 ? 0.55 : 1,
          }}>{w}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 12px 14px', gap: 2 }}>
        {cells.map((c, i) => {
          const isToday = !c.out && c.date.getUTCFullYear() === today.getUTCFullYear() && c.date.getUTCMonth() === today.getUTCMonth() && c.date.getUTCDate() === today.getUTCDate();
          const ev = !c.out ? dayMap.get(`${c.date.getUTCFullYear()}-${c.date.getUTCMonth()}-${c.date.getUTCDate()}`) : null;
          const theme = ev ? inferTheme(ev) : 'custom';
          let bg: string | undefined;
          let border: string | undefined;
          if (ev && theme === 'bday') { bg = 'rgba(240,106,180,0.15)'; border = '1px solid rgba(240,106,180,0.40)'; }
          else if (ev && theme === 'anniversary') { bg = 'rgba(251,191,36,0.14)'; border = '1px solid rgba(251,191,36,0.40)'; }
          else if (ev && theme === 'holiday') { bg = 'rgba(74,222,128,0.15)'; border = '1px solid rgba(74,222,128,0.40)'; }
          else if (ev) { bg = 'var(--wb-accent-soft)'; border = '1px solid var(--wb-accent-soft-strong)'; }
          if (isToday && !ev) { bg = 'var(--wb-surface)'; border = '1px solid var(--wb-border-strong)'; }

          return (
            <button
              key={i}
              disabled={c.out}
              onClick={() => !c.out && onCellClick(c.date)}
              style={{
                aspectRatio: '1 / 1', position: 'relative',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                borderRadius: 12,
                border: border ?? 'none',
                background: bg ?? 'transparent',
                fontSize: 13, fontWeight: 550, fontFamily: 'inherit', fontFeatureSettings: '"tnum"',
                color: c.out ? 'var(--wb-text-muted)' : ev ? 'var(--wb-text)' : 'var(--wb-text-secondary)',
                opacity: c.out ? 0.3 : 1,
                cursor: c.out ? 'default' : 'pointer',
                padding: 0,
              }}
            >
              <span>{c.d}</span>
              {ev && <span style={{ fontSize: 10, lineHeight: 1, marginTop: 1 }}>{ev.emoji ?? defaultEmojiForType(ev.type)}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ─── TodayCard ────────────────────────────────────────────────────────────

function TodayCard({ locale, ctx, onOpen }: { locale: Locale; ctx: TodayContext; onOpen: () => void }) {
  if (!ctx.soonest) return null;
  const s = ctx.soonest;
  return (
    <div onClick={onOpen} style={{
      margin: '0 16px 14px', padding: '14px 16px', borderRadius: 20,
      position: 'relative', overflow: 'hidden',
      background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-strong))',
      color: '#fff', cursor: 'pointer',
      boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
    }}>
      <div style={{ position: 'absolute', top: '-30%', right: '-10%', width: 160, height: 160, background: 'radial-gradient(circle, rgba(255,255,255,0.18), transparent 70%)' }} />
      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', opacity: 0.85 }}>
          {ct('cal_today', locale)}
        </div>
        <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em', marginTop: 3, lineHeight: 1.3 }}>
          {(s.emoji ?? defaultEmojiForType(s.type))} {s.title} — {ctDays(s.daysUntil, locale)}
        </div>
        {s.ideasCount > 0 && (
          <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 3 }}>
            {s.ideasCount} {ct('cal_ideas_label', locale).toLowerCase()}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── UpcomingList ─────────────────────────────────────────────────────────

function UpcomingList({ items, locale, onOpen }: { items: OccasionListItem[]; locale: Locale; onOpen: (id: string) => void }) {
  const sorted = [...items].sort((a, b) => (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999));
  return (
    <div>
      {sorted.slice(0, 8).map(o => {
        const next = occasionNextDate(o);
        if (!next) return null;
        return (
          <EventCard
            key={o.id}
            day={next.getUTCDate()}
            monthLabel={monthLabelShort(next.getUTCMonth(), locale)}
            theme={inferTheme(o)}
            emoji={o.emoji ?? defaultEmojiForType(o.type)}
            title={o.title}
            countdown={o.daysUntil != null ? ctDays(o.daysUntil, locale) : null}
            sub={o.personName ?? null}
            onClick={() => onOpen(o.id)}
          />
        );
      })}
    </div>
  );
}

// ─── WeekView ─────────────────────────────────────────────────────────────

function WeekView({ locale, occasions, onOpen }: { locale: Locale; occasions: OccasionListItem[]; onOpen: (id: string) => void }) {
  const now = new Date();
  // Get current week's Monday
  const dow = (now.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d;
  });
  const wd = weekdayLabels(locale);
  return (
    <div>
      {days.map((d, i) => {
        const events = occasions.filter(o => isSameDayLocal(occasionNextDate(o), d));
        return (
          <React.Fragment key={d.toISOString()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px 6px' }}>
              <div style={{ fontSize: 22, fontWeight: 750, letterSpacing: '-0.025em', color: 'var(--wb-text)', fontFeatureSettings: '"tnum"' }}>{d.getUTCDate()}</div>
              <div style={{ fontSize: 12, color: 'var(--wb-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3, paddingBottom: 3 }}>
                {monthLabelShort(d.getUTCMonth(), locale)} · {wd[i]}
              </div>
              <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, var(--wb-divider), transparent)' }} />
            </div>
            {events.length === 0 && (
              <div style={{ padding: '6px 20px 14px', fontSize: 12, color: 'var(--wb-text-muted)' }}>—</div>
            )}
            {events.map(o => (
              <EventCard
                key={o.id}
                day={d.getUTCDate()}
                monthLabel={monthLabelShort(d.getUTCMonth(), locale)}
                theme={inferTheme(o)}
                emoji={o.emoji ?? defaultEmojiForType(o.type)}
                title={o.title}
                countdown={o.daysUntil != null ? ctDays(o.daysUntil, locale) : null}
                sub={o.personName ?? null}
                onClick={() => onOpen(o.id)}
              />
            ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── ListView (full agenda, grouped by month) ─────────────────────────────

function ListView({ locale, occasions, onOpen }: { locale: Locale; occasions: OccasionListItem[]; onOpen: (id: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, { year: number; month: number; items: OccasionListItem[] }>();
    for (const o of occasions) {
      const next = occasionNextDate(o);
      if (!next) continue;
      const key = `${next.getUTCFullYear()}-${next.getUTCMonth()}`;
      const g = map.get(key) ?? { year: next.getUTCFullYear(), month: next.getUTCMonth(), items: [] };
      g.items.push(o);
      map.set(key, g);
    }
    const arr = [...map.values()];
    arr.sort((a, b) => (a.year - b.year) || (a.month - b.month));
    for (const g of arr) g.items.sort((a, b) => (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999));
    return arr;
  }, [occasions]);

  if (groups.length === 0) {
    return <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--wb-text-muted)', fontSize: 14 }}>{ct('cal_no_upcoming', locale)}</div>;
  }

  return (
    <div>
      {groups.map(g => (
        <React.Fragment key={`${g.year}-${g.month}`}>
          <SectionH>{`${monthLabelLong(g.month, locale)} ${g.year}`}</SectionH>
          {g.items.map(o => {
            const next = occasionNextDate(o)!;
            return (
              <EventCard
                key={o.id}
                day={next.getUTCDate()}
                monthLabel={monthLabelShort(next.getUTCMonth(), locale)}
                theme={inferTheme(o)}
                emoji={o.emoji ?? defaultEmojiForType(o.type)}
                title={o.title}
                countdown={o.daysUntil != null ? ctDays(o.daysUntil, locale) : null}
                sub={o.personName ?? null}
                onClick={() => onOpen(o.id)}
              />
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── YearView (12 mini grids) ─────────────────────────────────────────────

function YearView({ locale, occasions, year, onChangeYear, onOpenRecap }: { locale: Locale; occasions: OccasionListItem[]; year: number; onChangeYear: (y: number) => void; onOpenRecap: () => void }) {
  // For each month: list of (day, theme) tuples
  const yearMap = useMemo(() => {
    const m: Record<number, Array<{ day: number; theme: ReturnType<typeof inferTheme> }>> = {};
    for (let i = 0; i < 12; i++) m[i] = [];
    for (const o of occasions) {
      const next = occasionNextDate(o);
      if (!next || next.getUTCFullYear() !== year) continue;
      m[next.getUTCMonth()]!.push({ day: next.getUTCDate(), theme: inferTheme(o) });
    }
    return m;
  }, [occasions, year]);

  const totalEvents = Object.values(yearMap).reduce((s, arr) => s + arr.length, 0);
  const bdayCount = occasions.filter(o => o.type === 'BIRTHDAY').length;
  const giftsGiven = occasions.filter(o => o.actualGiftAmount && o.actualGiftAmount > 0).length;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, margin: '0 16px 14px' }}>
        <button onClick={() => onChangeYear(year - 1)} style={statCellLikeBtn}>‹ {year - 1}</button>
        <div style={{ ...statCellLikeBtn, background: 'var(--wb-card-strong)', cursor: 'default' }}>{year}</div>
        <button onClick={() => onChangeYear(year + 1)} style={statCellLikeBtn}>{year + 1} ›</button>
      </div>
      <div style={{ display: 'flex', gap: 8, margin: '0 16px 14px' }}>
        <Stat n={String(totalEvents)} label="событий" />
        <Stat n={String(bdayCount)} label="дни рожд." />
        <Stat n={String(giftsGiven) + ' 🎁'} label="подарков" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: '0 16px 16px' }}>
        {Array.from({ length: 12 }, (_, mi) => mi).map(mi => {
          const events = yearMap[mi] ?? [];
          const hasEvents = events.length > 0;
          const isCurrent = mi === new Date().getUTCMonth() && year === new Date().getUTCFullYear();
          const dim = new Date(Date.UTC(year, mi + 1, 0)).getUTCDate();
          return (
            <div key={mi} style={{
              padding: '12px 10px 10px', borderRadius: 16, minHeight: 130,
              background: isCurrent ? 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))' : 'var(--wb-card)',
              border: hasEvents ? '1px solid var(--wb-accent-soft-strong)' : isCurrent ? '1px solid var(--wb-border-strong)' : '1px solid var(--wb-border)',
              display: 'flex', flexDirection: 'column', gap: 8,
              WebkitBackdropFilter: 'blur(10px)' as never, backdropFilter: 'blur(10px)' as never,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: 'var(--wb-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                <span>{monthLabelShort(mi, locale)}</span>
                {hasEvents && (
                  <span style={{ background: 'var(--wb-accent-soft)', color: 'var(--wb-accent-strong)', fontSize: 9.5, padding: '2px 6px', borderRadius: 6, fontWeight: 700 }}>
                    {events.length}
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, flex: 1, alignContent: 'start' }}>
                {Array.from({ length: dim }).map((_, di) => {
                  const day = di + 1;
                  const ev = events.find(e => e.day === day);
                  const bg = !ev ? 'rgba(255,255,255,0.04)'
                    : ev.theme === 'bday' ? 'rgba(240,106,180,0.55)'
                    : ev.theme === 'anniversary' ? 'rgba(251,191,36,0.55)'
                    : ev.theme === 'holiday' ? 'rgba(52,201,138,0.5)'
                    : 'var(--wb-accent)';
                  return <div key={di} style={{ height: 9, borderRadius: 2, background: bg }} />;
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: '0 16px 24px' }}>
        <button onClick={onOpenRecap} style={{
          width: '100%', padding: '14px 16px', borderRadius: 16,
          background: gradients.recapHero, color: '#fff', border: 'none',
          fontSize: 14, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit',
          letterSpacing: '-0.005em',
        }}>
          ★ Открыть итоги {year - 1}
        </button>
      </div>
    </div>
  );
}

const statCellLikeBtn: React.CSSProperties = {
  flex: 1, padding: '10px', borderRadius: 12,
  background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
  textAlign: 'center', fontSize: 13, fontWeight: 600,
  color: 'var(--wb-text)', cursor: 'pointer', fontFamily: 'inherit',
};

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div style={{
      flex: 1, padding: '12px 10px', borderRadius: 16,
      background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
      textAlign: 'center',
      WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
    }}>
      <div style={{ fontSize: 20, fontWeight: 750, letterSpacing: '-0.025em', color: 'var(--wb-text)', fontFeatureSettings: '"tnum"' }}>{n}</div>
      <div style={{ fontSize: 11, color: 'var(--wb-text-muted)', marginTop: 2, fontWeight: 550 }}>{label}</div>
    </div>
  );
}

// ─── Import pills (always visible when calendar has events) ───────────────
//
// Empty state surfaces these as primary CTAs (`Empty` below). For a populated
// calendar we still want one-tap entry to "Import country holidays" / "Import
// friends' birthdays" — earlier this was only reachable from the empty-state
// screen, which became unreachable as soon as the user added their first event.

function ImportPills({ onImportHolidays, onImportFriends, locale }: {
  onImportHolidays: () => void;
  onImportFriends: () => void;
  locale: Locale;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '0 16px 14px', flexWrap: 'wrap' }}>
      <button onClick={onImportHolidays} style={pillBtnStyle}>
        📅 {ct('cal_import_country', locale)}
      </button>
      <button onClick={onImportFriends} style={pillBtnStyle}>
        ↓ {ct('cal_empty_import_friends', locale)}
      </button>
    </div>
  );
}

const pillBtnStyle: React.CSSProperties = {
  flex: 1, minWidth: 'fit-content',
  padding: '10px 14px', borderRadius: 100,
  background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
  color: 'var(--wb-text)', fontSize: 12.5, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' as const,
  WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
};

// ─── Empty state (when no events at all) ──────────────────────────────────

function Empty({ locale, onAddEvent, onImportFriends, onImportHolidays, isFiltered }: {
  locale: Locale; onAddEvent: () => void; onImportFriends: () => void; onImportHolidays: () => void; isFiltered: boolean;
}) {
  if (isFiltered) {
    return <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--wb-text-muted)', fontSize: 13 }}>{ct('cal_no_upcoming', locale)}</div>;
  }
  return (
    <div>
      <div style={{ padding: '40px 24px 12px', textAlign: 'center' }}>
        <div style={{ fontSize: 84, marginBottom: 18, filter: 'drop-shadow(0 14px 30px var(--wb-accent-shadow))' }}>📅</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--wb-text)', margin: '0 0 8px' }}>
          {ct('cal_empty_title', locale)}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--wb-text-secondary)', margin: '0 0 22px', lineHeight: 1.5, letterSpacing: '-0.005em' }}>
          {ct('cal_empty_sub', locale)}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 8px' }}>
          <button onClick={onAddEvent} style={primaryBtnStyle}>{ct('cal_empty_add_event', locale)}</button>
          <button onClick={onImportFriends} style={surfaceBtnStyle}>{ct('cal_empty_import_friends', locale)}</button>
          <button onClick={onImportHolidays} style={surfaceBtnStyle}>📅 {ct('cal_import_country', locale)}</button>
        </div>
      </div>
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '15px 22px', borderRadius: 18, border: 'none',
  background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
  color: '#fff', fontSize: 15, fontWeight: 650, letterSpacing: '-0.015em',
  cursor: 'pointer', minHeight: 52, fontFamily: 'inherit',
  boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
};

const surfaceBtnStyle: React.CSSProperties = {
  padding: '15px 22px', borderRadius: 18,
  background: 'var(--wb-card-strong)',
  border: '1px solid var(--wb-border-strong)',
  color: 'var(--wb-text)', fontSize: 15, fontWeight: 650,
  cursor: 'pointer', minHeight: 52, fontFamily: 'inherit',
  WebkitBackdropFilter: 'blur(14px)' as never, backdropFilter: 'blur(14px)' as never,
};
