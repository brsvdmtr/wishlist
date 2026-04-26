/**
 * In-app inbox — section F of the design.
 *
 * Lists CalendarInboxEntry rows by recency, grouped into "Today" / "This week" / "Archive".
 */

'use client';

import React, { useEffect, useState } from 'react';
import type { Locale } from '@wishlist/shared';
import type { TgFetch } from './api';
import * as api from './api';
import type { CalendarInboxItem } from './types';
import { CalHeader, BannerStrip, SectionH, CalIconButton } from './components';
import { ct } from './i18n';

export function CalendarInbox({ tgFetch, locale, onBack, onOpenOccasion }: {
  tgFetch: TgFetch; locale: Locale; onBack: () => void; onOpenOccasion: (id: string) => void;
}) {
  const [entries, setEntries] = useState<CalendarInboxItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getInbox(tgFetch);
        if (!cancelled) setEntries(r.entries);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Inbox load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tgFetch]);

  const onMarkAll = async () => {
    await api.markInboxAllRead(tgFetch);
    setEntries(prev => prev.map(e => ({ ...e, readAt: e.readAt ?? new Date().toISOString() })));
  };

  const today = new Date();
  const today0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const weekAgo = today0 - 7 * 24 * 3600 * 1000;

  const todayItems = entries.filter(e => new Date(e.createdAt).getTime() >= today0);
  const weekItems = entries.filter(e => {
    const t = new Date(e.createdAt).getTime();
    return t < today0 && t >= weekAgo;
  });
  const archiveItems = entries.filter(e => new Date(e.createdAt).getTime() < weekAgo);

  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)', paddingBottom: 'calc(40px + env(safe-area-inset-bottom))' }}>
      <CalHeader
        title={ct('cal_inbox_title', locale)}
        onBack={onBack}
        rightSlot={entries.some(e => !e.readAt) ? <CalIconButton onClick={onMarkAll} label="Read all">✓</CalIconButton> : undefined}
      />

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--wb-text-muted)' }}>…</div>}

      {!loading && entries.length === 0 && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--wb-text-muted)', fontSize: 14 }}>
          {ct('cal_inbox_empty', locale)}
        </div>
      )}

      {todayItems.length > 0 && (
        <>
          <SectionH>{ct('cal_inbox_today', locale)}</SectionH>
          {todayItems.map(e => (
            <BannerStrip
              key={e.id}
              icon={e.emoji}
              title={e.title}
              sub={e.body ?? undefined}
              accent={!e.readAt}
              onClick={() => {
                if (e.occasionId) onOpenOccasion(e.occasionId);
                if (!e.readAt) void api.markInboxRead(tgFetch, e.id);
              }}
            />
          ))}
        </>
      )}

      {weekItems.length > 0 && (
        <>
          <SectionH>{ct('cal_inbox_week', locale)}</SectionH>
          {weekItems.map(e => (
            <BannerStrip
              key={e.id}
              icon={e.emoji}
              title={e.title}
              sub={e.body ?? undefined}
              onClick={() => {
                if (e.occasionId) onOpenOccasion(e.occasionId);
                if (!e.readAt) void api.markInboxRead(tgFetch, e.id);
              }}
            />
          ))}
        </>
      )}

      {archiveItems.length > 0 && (
        <>
          <SectionH>{ct('cal_inbox_archive', locale)}</SectionH>
          <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {archiveItems.map(e => (
              <div
                key={e.id}
                onClick={() => e.occasionId && onOpenOccasion(e.occasionId)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                  borderRadius: 14, background: 'rgba(255,255,255,0.02)', opacity: 0.65,
                  cursor: e.occasionId ? 'pointer' : 'default',
                }}
              >
                <div style={{ fontSize: 20, width: 28, textAlign: 'center' }}>{e.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--wb-text)' }}>{e.title}</div>
                  {e.body && <div style={{ fontSize: 11.5, color: 'var(--wb-text-muted)', marginTop: 1 }}>{e.body}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
