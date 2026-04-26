/**
 * Import flows — friends' birthdays + country holidays.
 *
 * Both flows share UI: list with pre-checked items, "Import N selected" CTA.
 */

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import type { Locale } from '@wishlist/shared';
import type { TgFetch } from './api';
import * as api from './api';
import { COUNTRY_FOR_LOCALE } from './types';
import type { FriendBdayItem, HolidayItem } from './types';
import { CalHeader, SectionH, CtaBar, monthLabelLong } from './components';
import { ct } from './i18n';

interface Props {
  tgFetch: TgFetch;
  locale: Locale;
  kind: 'friends' | 'holidays';
  onBack: () => void;
  onImported: () => Promise<void>;
  onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

export function CalendarImport({ tgFetch, locale, kind, onBack, onImported, onShowToast }: Props) {
  const [country, setCountry] = useState<string>(COUNTRY_FOR_LOCALE[locale]);
  const [friends, setFriends] = useState<FriendBdayItem[]>([]);
  const [holidays, setHolidays] = useState<HolidayItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (kind === 'friends') {
          const r = await api.listFriendsBdays(tgFetch);
          if (cancelled) return;
          setFriends(r.friends);
          setSelected(new Set(r.friends.filter(f => !f.alreadyImported).map(f => f.userId)));
        } else {
          const r = await api.listHolidays(tgFetch, country);
          if (cancelled) return;
          setHolidays(r.holidays);
          setSelected(new Set(r.holidays.filter(h => !h.alreadyImported).map(h => h.key)));
        }
      } catch (err) {
        if (!cancelled) {
          onShowToast('Не удалось загрузить', 'error');
          // eslint-disable-next-line no-console
          console.error('Import list load failed', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [kind, country, tgFetch, onShowToast]);

  const titleKey = kind === 'friends' ? 'cal_import_friends' : 'cal_import_country';

  const onToggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const onImport = async () => {
    if (selected.size === 0) return;
    setImporting(true);
    try {
      let count = 0;
      if (kind === 'friends') {
        const r = await api.importFriendsBdays(tgFetch, [...selected]);
        count = r.imported;
      } else {
        const r = await api.importHolidays(tgFetch, [...selected], locale);
        count = r.imported;
      }
      onShowToast(`Импортировано: ${count}`, 'success');
      await onImported();
    } catch (err) {
      onShowToast('Ошибка импорта', 'error');
      // eslint-disable-next-line no-console
      console.error('Import failed', err);
    } finally {
      setImporting(false);
    }
  };

  // Group holidays by month
  const holidayGroups = useMemo(() => {
    const m = new Map<number, HolidayItem[]>();
    for (const h of holidays) {
      const arr = m.get(h.month) ?? [];
      arr.push(h);
      m.set(h.month, arr);
    }
    const arr = [...m.entries()].sort(([a], [b]) => a - b);
    return arr;
  }, [holidays]);

  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)', paddingBottom: 'calc(120px + env(safe-area-inset-bottom))' }}>
      <CalHeader title={ct(titleKey, locale)} onBack={onBack} />

      {kind === 'holidays' && (
        <div style={{ display: 'flex', gap: 6, padding: '0 16px 14px', flexWrap: 'wrap' }}>
          {(['RU', 'US', 'CN', 'IN', 'SA', 'ES'] as const).map(c => (
            <button
              key={c}
              onClick={() => setCountry(c)}
              style={{
                padding: '8px 14px', borderRadius: 100,
                background: country === c ? 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))' : 'var(--wb-card)',
                border: country === c ? '1px solid var(--wb-border-strong)' : '1px solid var(--wb-border)',
                fontSize: 12.5, fontWeight: 600,
                color: country === c ? 'var(--wb-text)' : 'var(--wb-text-secondary)',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {ct(`cal_country_${c.toLowerCase()}`, locale)}
            </button>
          ))}
        </div>
      )}

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--wb-text-muted)' }}>…</div>}

      {!loading && kind === 'friends' && (
        friends.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--wb-text-muted)', fontSize: 14 }}>
            Друзей с днями рождения не нашлось
          </div>
        ) : (
          <div>
            <SectionH>{`${friends.length} друзей`}</SectionH>
            {friends.map(f => {
              const checked = selected.has(f.userId);
              const dis = f.alreadyImported;
              return (
                <Row
                  key={f.userId}
                  emoji="🎂"
                  title={f.displayName ?? f.username ?? 'Friend'}
                  sub={f.username ? `@${f.username}` : null}
                  date={f.birthday ? formatBday(f.birthday, f.hideYear) : '?'}
                  checked={checked && !dis}
                  disabled={dis}
                  onToggle={() => !dis && onToggle(f.userId)}
                />
              );
            })}
          </div>
        )
      )}

      {!loading && kind === 'holidays' && holidayGroups.map(([month, items]) => (
        <React.Fragment key={month}>
          <SectionH>{monthLabelLong(month - 1, locale)}</SectionH>
          {items.map(h => {
            const checked = selected.has(h.key);
            const dis = h.alreadyImported;
            return (
              <Row
                key={h.key}
                emoji={h.emoji}
                title={localizedName(h, locale)}
                sub={h.category}
                date={`${h.day}.${String(h.month).padStart(2, '0')}`}
                checked={checked && !dis}
                disabled={dis}
                onToggle={() => !dis && onToggle(h.key)}
              />
            );
          })}
        </React.Fragment>
      ))}

      <CtaBar>
        <button
          onClick={onImport}
          disabled={selected.size === 0 || importing}
          style={{
            padding: '15px 22px', borderRadius: 18, border: 'none',
            background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
            color: '#fff', fontSize: 15, fontWeight: 650, letterSpacing: '-0.015em',
            cursor: selected.size === 0 || importing ? 'default' : 'pointer',
            minHeight: 52, fontFamily: 'inherit', width: '100%',
            boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
            opacity: selected.size === 0 || importing ? 0.5 : 1,
          }}
        >{importing ? '…' : `Импортировать (${selected.size})`}</button>
      </CtaBar>
    </div>
  );
}

function Row({ emoji, title, sub, date, checked, disabled, onToggle }: {
  emoji: string; title: string; sub: string | null; date: string; checked: boolean; disabled: boolean; onToggle: () => void;
}) {
  return (
    <div onClick={onToggle} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      margin: '0 16px 8px', padding: '12px 14px',
      background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
      borderRadius: 16, cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
    }}>
      <div style={{ fontSize: 24, width: 32, textAlign: 'center', flexShrink: 0 }}>{emoji}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--wb-text)', letterSpacing: '-0.012em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--wb-text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--wb-text-muted)', fontWeight: 600, fontFeatureSettings: '"tnum"', minWidth: 50, textAlign: 'right' }}>{date}</div>
      <div style={{
        width: 24, height: 24, borderRadius: 8,
        background: disabled ? 'rgba(255,255,255,0.04)' : checked ? 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))' : 'var(--wb-surface)',
        border: '1px solid var(--wb-border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontSize: 13, fontWeight: 700, flexShrink: 0,
      }}>{disabled ? '✓' : checked ? '✓' : ''}</div>
    </div>
  );
}

function formatBday(iso: string, hideYear: boolean): string {
  const d = new Date(iso);
  return hideYear
    ? `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    : `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

function localizedName(h: HolidayItem, locale: Locale): string {
  switch (locale) {
    case 'en': return h.nameEn ?? h.nameRu ?? h.key;
    case 'zh-CN': return h.nameZhCn ?? h.nameEn ?? h.key;
    case 'hi': return h.nameHi ?? h.nameEn ?? h.key;
    case 'es': return h.nameEs ?? h.nameEn ?? h.key;
    case 'ar': return h.nameAr ?? h.nameEn ?? h.key;
    default: return h.nameRu ?? h.nameEn ?? h.key;
  }
}
