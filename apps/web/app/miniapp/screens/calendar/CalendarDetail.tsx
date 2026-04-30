/**
 * Event-detail screen — covers all 4 variants from the design pack:
 *   D-1 friend birthday + wishlist
 *   D-2 own / anniversary (no wishlist, with reminder editor)
 *   D-3 today event (with countdown timer; Santa room block when linked)
 *   D-4 past event (read-only, with thank-you note quote, "repeat next year")
 *
 * Layout adapts based on:
 *   • linkedWishlist  → ideas from that wishlist + "Open wishlist" CTA
 *   • linkedSanta     → santa-room block + "Open Santa" CTA
 *   • status === DONE → thank-you/log-gift section
 *   • daysUntil < 0   → past styling (faded hero, no countdown)
 *   • daysUntil === 0 → today styling (live timer)
 */

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '@wishlist/shared';
import { gradients } from '@wishlist/ui-tokens';
import type { TgFetch } from './api';
import * as api from './api';
import type { OccasionDetail, EventTheme, EventRecurrence } from './types';
import { inferTheme, defaultEmojiForType } from './types';
import { Sheet } from '@wishlist/ui';
import {
  CalHeader, CalIconButton, InfoGroup, InfoRow, SectionH, ReminderRow, BannerStrip, Toggle,
  EmojiPicker, RepeatChips, DayPickerSheet, MonthPickerSheet, YearPickerSheet,
  monthLabelLong, weekdayLabels, useIsKeyboardOpen,
} from './components';
import { ct, ctDays, ctDaysAgo } from './i18n';

interface Props {
  tgFetch: TgFetch;
  locale: Locale;
  occasion: OccasionDetail;
  onBack: () => void;
  onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
  onMutated: () => Promise<void>;
}

export function CalendarDetail({ tgFetch, locale, occasion: o, onBack, onShowToast, onMutated }: Props) {
  const theme: EventTheme = useMemo(() => inferTheme({ type: o.type, daysUntil: o.daysUntil }), [o.type, o.daysUntil]);
  const isPast = (o.daysUntil ?? 0) < 0 || o.status === 'DONE';
  const isToday = o.daysUntil === 0 && !isPast;
  const dateInfo = useMemo(() => formatDate(o.nextDate ?? o.eventDate, locale), [o.nextDate, o.eventDate, locale]);
  const [editing, setEditing] = useState(false);
  // Hide the sticky CtaBar when the on-screen keyboard is open: the user is
  // actively typing in an inline form (idea text / thank-you note / edit
  // sheet), so the bar would just hover over the form content. Each inline
  // form ships its own Save/Cancel — the global Edit/Delete bar adds nothing
  // while typing. Re-shows the moment focus leaves and the keyboard collapses.
  const kbOpen = useIsKeyboardOpen();
  const heroBg = isPast
    ? 'linear-gradient(135deg, rgba(80,80,90,0.6), rgba(40,40,50,0.6))'
    : theme === 'bday' ? gradients.eventBdayHero
    : theme === 'anniversary' ? gradients.eventAnniversaryHero
    : theme === 'holiday' ? gradients.eventHolidayHero
    : gradients.eventTodayHero;

  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)' }}>
      <CalHeader
        onBack={onBack}
        rightSlot={<CalIconButton label={ct('cal_edit', locale)} onClick={() => setEditing(true)}>✎</CalIconButton>}
      />

      {/* Hero */}
      {/*
        WebKit/Safari quirk (W76 — fixed once, regressed): a child with
        `filter: blur(...)` paints its rectangular bounds OUTSIDE the parent's
        `border-radius + overflow: hidden` clip path, leaving a faint corner
        "tail" around the rounded corner. Mitigation:
          • `isolation: isolate` on the parent — forces a new stacking context
            so the child filter is composited within the clip mask.
          • `willChange: transform` on the blurred child — anchors it to that
            stacking context.
        Both are required; either one alone is not enough on iOS Telegram.
      */}
      <div style={{
        margin: '6px 16px 14px', padding: 22, borderRadius: 26,
        color: '#fff', position: 'relative', overflow: 'hidden',
        background: heroBg,
        filter: isPast ? 'saturate(0.8)' : undefined,
        boxShadow: isPast ? 'none' : '0 18px 48px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
        isolation: 'isolate',
      }}>
        <div aria-hidden="true" style={{ position: 'absolute', bottom: '-50%', left: '-20%', width: 280, height: 280, background: 'radial-gradient(circle, rgba(255,255,255,0.18), transparent 65%)', filter: 'blur(8px)', willChange: 'transform' }} />

        {/* Status pill */}
        {(isPast || isToday) && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
            background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.22)',
            padding: '3px 9px', borderRadius: 7, marginBottom: 10, position: 'relative',
          }}>
            {isToday ? `● ${ct('cal_pinned_today', locale)}` : ct('cal_pinned_past', locale)}
          </div>
        )}

        <div style={{ fontSize: 48, lineHeight: 1, filter: 'drop-shadow(0 6px 12px rgba(0,0,0,0.25))', marginBottom: 8 }}>
          {o.emoji ?? defaultEmojiForType(o.type)}
        </div>
        <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: '-0.03em', lineHeight: 1.1, margin: '0 0 4px', position: 'relative' }}>
          {o.title}
        </div>
        <div style={{ fontSize: 13, opacity: 0.9, fontWeight: 500, letterSpacing: '-0.005em', position: 'relative' }}>
          {dateInfo}{o.eventTime ? ` · ${o.eventTime}` : ''}
        </div>

        {/* Countdown */}
        {!isPast && (
          <Countdown nextDate={o.nextDate ?? o.eventDate} locale={locale} />
        )}
      </div>

      {/* Info group */}
      <InfoGroup>
        {(o.linkedUser || o.personName) && (
          <InfoRow
            tinted
            icon="○"
            label={ct('cal_who_label', locale)}
            value={o.linkedUser
              ? `${o.linkedUser.profile?.displayName ?? o.linkedUser.firstName ?? ''}${o.linkedUser.profile?.username ? ` · @${o.linkedUser.profile.username}` : ''}`
              : (o.personName ?? '')
            }
            trail={o.linkedUser ? '›' : undefined}
          />
        )}
        {o.recurrence !== 'NONE' && (
          <InfoRow icon="◷" label={ct('cal_repeat_label', locale)} value={o.recurrence === 'YEARLY' ? ct('cal_recur_yearly', locale) : ct('cal_recur_monthly', locale)} />
        )}
        <InfoRow
          icon="◔"
          label={ct('cal_reminders_label', locale)}
          value={o.reminders.length > 0
            ? o.reminders.filter(r => r.enabled).map(r => formatOffset(r.offsetDays, locale)).join(', ')
            : '—'}
        />
        {o.location && <InfoRow icon="◉" label={ct('cal_field_location', locale)} value={o.location} />}
      </InfoGroup>

      {/* Linked wishlist ideas (D-1 variant) */}
      {!isPast && o.linkedWishlist && o.linkedWishlistItems.length > 0 && (
        <>
          <SectionH>
            {ct('cal_ideas_from_wishlist', locale, { name: o.linkedUser?.profile?.displayName ?? o.linkedUser?.firstName ?? o.linkedWishlist.title })}
          </SectionH>
          {o.linkedWishlistItems.map(item => (
            <div key={item.id} style={{
              margin: '0 16px 8px', padding: 14, borderRadius: 18,
              background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
              display: 'flex', gap: 12, alignItems: 'center',
              WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: 14,
                background: item.imageUrl ? `center/cover url(${item.imageUrl})` : 'linear-gradient(135deg, var(--wb-accent-soft-strong), var(--wb-accent-soft))',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0,
              }}>{!item.imageUrl && '🎁'}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--wb-text)', letterSpacing: '-0.012em', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--wb-text-muted)', marginTop: 3, display: 'flex', gap: 6 }}>
                  {item.priceText && <span style={{ fontWeight: 700, color: 'var(--wb-text-secondary)', fontFeatureSettings: '"tnum"' }}>{item.priceText}</span>}
                  {item.sourceDomain && <span>· {item.sourceDomain}</span>}
                </div>
              </div>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                background: 'var(--wb-accent-soft)', border: '1px solid var(--wb-accent-soft-strong)',
                color: 'var(--wb-accent-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, flexShrink: 0,
              }}>＋</div>
            </div>
          ))}
          <div style={{ padding: '8px 16px 0' }}>
            <button style={surfaceBtnStyle}>↗ {ct('cal_open_wishlist', locale, { name: o.linkedUser?.profile?.displayName ?? o.linkedUser?.firstName ?? o.linkedWishlist.title })}</button>
          </div>
        </>
      )}

      {/* Linked Santa (D-3 variant) */}
      {!isPast && o.linkedSanta && (
        <>
          <SectionH>Тайный Санта</SectionH>
          <BannerStrip
            icon="🎁"
            title={o.linkedSanta.title}
            sub={`${o.linkedSanta._count.participants} участников · ${o.linkedSanta.status}`}
            onClick={() => { /* could route to Santa screen */ }}
            accent
          />
        </>
      )}

      {/* User-curated gift ideas attached to this event. Available for both
          upcoming and past events: past events keep ideas as a record of what
          was considered, useful when looking back at recurring events. */}
      <IdeasSection tgFetch={tgFetch} occasion={o} locale={locale} onChanged={onMutated} onShowToast={onShowToast} />

      {/* Reminders editor — render when not past */}
      {!isPast && (
        <RemindersEditor tgFetch={tgFetch} occasionId={o.id} locale={locale} reminders={o.reminders} onChanged={onMutated} onShowToast={onShowToast} />
      )}

      {/* Past — thank-you / log gift section */}
      {isPast && (
        <PastSection tgFetch={tgFetch} occasion={o} locale={locale} onChanged={onMutated} onShowToast={onShowToast} />
      )}

      {!kbOpen && (
        // CTA stack — rendered as a normal in-flow block at the end of the
        // detail body. Earlier this lived inside a sticky CtaBar that floated
        // above content, which read as the buttons being "nailed in" mid-page
        // and overlapping the hero whenever the page was scrolled. Now the
        // user reaches Edit/Delete by scrolling to the bottom of the screen,
        // matching long-page detail UX in iOS apps. Bottom padding clears the
        // FloatingNav (~14px from edge, ~52px tall) + safe-area inset.
        <div style={{
          padding: 'calc(8px) 16px calc(96px + env(safe-area-inset-bottom))',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {/* Contextual primary CTA only — Santa room link or wishlist gift-mark.
              The "Готово ✓" / mark-as-done button was removed: it called
              completeOccasion() with no confirmation, dropping the event off the
              ACTIVE list with no easy way back — users perceived it as an
              irreversible delete-by-mistake. Marking as completed now happens
              via the past-event "Что подарили?" log-gift form. */}
          {!isPast && o.linkedSanta && (
            <button style={primaryBtnStyle}>{`Открыть Тайного Санту`}</button>
          )}
          {!isPast && !o.linkedSanta && o.linkedWishlist && (
            <button style={primaryBtnStyle}>{ct('cal_mark_my_gift', locale)}</button>
          )}
          {isPast && o.recurrence !== 'YEARLY' && (
            <button onClick={async () => {
              await api.updateOccasion(tgFetch, o.id, { recurrence: 'YEARLY' });
              onShowToast(ct('cal_recur_yearly', locale), 'success');
              await onMutated();
            }} style={surfaceBtnStyle}>{ct('cal_repeat_next_year', locale)}</button>
          )}
          <button onClick={() => setEditing(true)} style={surfaceBtnStyle}>{ct('cal_edit', locale)}</button>
          <button onClick={async () => {
            if (!confirm(ct('cal_delete', locale) + '?')) return;
            await api.deleteOccasion(tgFetch, o.id);
            onShowToast(ct('cal_delete', locale), 'success');
            onBack();
          }} style={ghostDangerBtnStyle}>{ct('cal_delete', locale)}</button>
        </div>
      )}

      <EditOccasionSheet
        open={editing}
        onClose={() => setEditing(false)}
        tgFetch={tgFetch}
        occasion={o}
        locale={locale}
        onSaved={async () => { setEditing(false); await onMutated(); }}
        onShowToast={onShowToast}
      />
    </div>
  );
}

// ─── Countdown sub-component (live timer for today / static for upcoming) ─

function Countdown({ nextDate, locale }: { nextDate: string | null; locale: Locale }) {
  const target = nextDate ? new Date(nextDate) : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const ms = target.getTime() - now;
    if (ms < 0) return;
    if (ms < 24 * 3600 * 1000) {
      // Live tick once a second
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
    }
  }, [target, now]);

  if (!target) return null;
  const ms = target.getTime() - now;
  if (ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const cells = days > 0
    ? [{ n: days, l: 'дн' }, { n: hours, l: 'ч' }, { n: mins, l: 'мин' }]
    : [{ n: hours, l: 'ч' }, { n: mins, l: 'мин' }, { n: secs, l: 'сек' }];

  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 18, position: 'relative' }}>
      {cells.map((c, i) => (
        <div key={i} style={{
          flex: 1, padding: '10px 8px',
          background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.22)',
          borderRadius: 14, textAlign: 'center',
          WebkitBackdropFilter: 'blur(8px)' as never, backdropFilter: 'blur(8px)' as never,
        }}>
          <div style={{ fontSize: 22, fontWeight: 750, letterSpacing: '-0.025em', lineHeight: 1, fontFeatureSettings: '"tnum"' }}>
            {String(c.n).padStart(2, '0')}
          </div>
          <div style={{ fontSize: 9.5, fontWeight: 700, opacity: 0.85, letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 4 }}>{c.l}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Reminders editor ─────────────────────────────────────────────────────

const REMINDER_PRESETS = [
  { offsetDays: -14, key: 'cal_reminder_2w' as const },
  { offsetDays: -7, key: 'cal_reminder_1w' as const },
  { offsetDays: -3, key: 'cal_reminder_3d' as const },
  { offsetDays: -1, key: 'cal_reminder_1d' as const },
  { offsetDays: 0, key: 'cal_reminder_0d' as const },
];

function RemindersEditor({ tgFetch, occasionId, locale, reminders, onChanged, onShowToast }: {
  tgFetch: TgFetch; occasionId: string; locale: Locale; reminders: OccasionDetail['reminders']; onChanged: () => Promise<void>; onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const handleToggle = async (offsetDays: number, currentlyEnabled: boolean) => {
    setBusy(offsetDays);
    try {
      const existing = reminders.find(r => r.offsetDays === offsetDays);
      if (existing) {
        if (currentlyEnabled) {
          await api.deleteReminder(tgFetch, occasionId, existing.id);
        } else {
          await api.updateReminder(tgFetch, occasionId, existing.id, { enabled: true });
        }
      } else {
        await api.createReminder(tgFetch, occasionId, { offsetDays });
      }
      await onChanged();
    } catch (err) {
      onShowToast('Не удалось сохранить напоминание', 'error');
      // eslint-disable-next-line no-console
      console.error('Reminder toggle failed', err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SectionH>{ct('cal_reminders_label', locale)}</SectionH>
      <InfoGroup>
        {REMINDER_PRESETS.map(p => {
          const existing = reminders.find(r => r.offsetDays === p.offsetDays);
          const on = !!existing && existing.enabled;
          return (
            <ReminderRow
              key={p.offsetDays}
              offsetLabel={formatOffset(p.offsetDays, locale)}
              title={ct(p.key, locale)}
              sub={existing?.timeOfDay ? `в ${existing.timeOfDay}${existing.sentAt ? ' · уже отправлено' : ''}` : undefined}
              on={on}
              onChange={() => busy === null && void handleToggle(p.offsetDays, on)}
            />
          );
        })}
      </InfoGroup>
    </>
  );
}

// ─── Ideas section ─────────────────────────────────────────────────────────
//
// User-curated gift ideas attached to an event. Backend already supports the
// full lifecycle (POST /tg/gift-occasions/:id/ideas, PATCH/DELETE/complete on
// /tg/gift-occasion-ideas/:ideaId). Earlier UI versions exposed this; the v2.1
// rewrite replaced it with the linked-wishlist preview only — losing the
// option to attach standalone ideas. Restoring it here.

type IdeaCurrency = 'RUB' | 'USD' | 'EUR' | 'GBP';
const IDEA_CURRENCIES: IdeaCurrency[] = ['RUB', 'USD', 'EUR', 'GBP'];

function IdeasSection({ tgFetch, occasion, locale, onChanged, onShowToast }: {
  tgFetch: TgFetch; occasion: OccasionDetail; locale: Locale;
  onChanged: () => Promise<void>;
  onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
}) {
  const visible = useMemo(() => occasion.ideas.filter(i => i.status !== 'ARCHIVED'), [occasion.ideas]);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [currency, setCurrency] = useState<IdeaCurrency>('RUB');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (adding && formRef.current) {
      formRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [adding]);

  const reset = () => {
    setText(''); setLink(''); setPrice(''); setNote(''); setCurrency('RUB'); setAdding(false);
    setPhotoFile(null);
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(null);
  };

  const onPickPhoto = (file: File | null) => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    if (!file) { setPhotoFile(null); setPhotoPreview(null); return; }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const priceNum = price.trim() ? Number(price.replace(/\s/g, '')) : null;
      const created = await api.createIdea(tgFetch, occasion.id, {
        text: trimmed,
        link: link.trim() ? link.trim() : null,
        price: priceNum != null && Number.isFinite(priceNum) && priceNum >= 0 ? Math.floor(priceNum) : null,
        currency,
        note: note.trim() || undefined,
      });
      // Upload photo as a follow-up — the create endpoint accepts JSON only;
      // photos go through a multipart endpoint scoped to the new idea id.
      if (photoFile) {
        try {
          const fd = new FormData();
          fd.append('photo', photoFile);
          await api.uploadIdeaPhoto(tgFetch, created.idea.id, fd);
        } catch (uploadErr) {
          onShowToast('Идея создана, но фото не загрузилось', 'error');
          // eslint-disable-next-line no-console
          console.error('Idea photo upload failed', uploadErr);
        }
      }
      reset();
      await onChanged();
    } catch (err) {
      onShowToast('Не удалось добавить идею', 'error');
      // eslint-disable-next-line no-console
      console.error('Idea create failed', err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (ideaId: string) => {
    if (!confirm(ct('cal_delete', locale) + '?')) return;
    setBusyId(ideaId);
    try {
      await api.deleteIdea(tgFetch, ideaId);
      await onChanged();
    } catch (err) {
      onShowToast('Не удалось удалить', 'error');
      // eslint-disable-next-line no-console
      console.error('Idea delete failed', err);
    } finally {
      setBusyId(null);
    }
  };

  const toggleComplete = async (ideaId: string, currentlyDone: boolean) => {
    setBusyId(ideaId);
    try {
      if (currentlyDone) {
        // No reopen endpoint — flip back via PATCH (treat as text-only no-op:
        // server accepts partial PATCH; we re-set status via updateOccasion isn't
        // available, so we just mark via complete which idempotently sets DONE).
        // Reopening isn't critical for the bug fix; keep as one-way for now.
        return;
      }
      await api.completeIdea(tgFetch, ideaId);
      await onChanged();
    } catch (err) {
      onShowToast('Не удалось обновить', 'error');
      // eslint-disable-next-line no-console
      console.error('Idea complete failed', err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <SectionH>{ct('cal_ideas_label', locale)}</SectionH>

      {visible.length > 0 && (
        <div>
          {visible.map(idea => {
            const done = idea.status === 'DONE';
            const expanded = expandedId === idea.id;
            const hasDetails = !!(idea.imageUrl || idea.note || idea.link);
            const priceText = idea.price != null
              ? `${idea.price.toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US')} ${idea.currency ?? ''}`.trim()
              : null;
            const linkDomain = idea.link ? safeDomain(idea.link) : null;
            return (
              <div key={idea.id} style={{
                margin: '0 16px 8px', padding: 14, borderRadius: 18,
                background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
                opacity: done ? 0.6 : 1,
                WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
              }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <button
                    type="button"
                    onClick={() => void toggleComplete(idea.id, done)}
                    disabled={busyId === idea.id || done}
                    aria-label={done ? 'Отмечено' : 'Отметить выполненным'}
                    style={{
                      width: 28, height: 28, borderRadius: 9, flexShrink: 0,
                      background: done ? 'var(--wb-accent-soft)' : 'var(--wb-surface)',
                      border: done ? '1px solid var(--wb-accent-soft-strong)' : '1px solid var(--wb-border)',
                      color: done ? 'var(--wb-accent-strong)' : 'var(--wb-text-muted)',
                      fontSize: 14, fontWeight: 700, cursor: done ? 'default' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'inherit', padding: 0,
                    }}
                  >{done ? '✓' : ''}</button>
                  {!expanded && idea.imageUrl && (
                    <button
                      type="button"
                      onClick={() => setExpandedId(idea.id)}
                      aria-label="Открыть фото"
                      style={{
                        width: 56, height: 56, borderRadius: 12, flexShrink: 0,
                        padding: 0, fontFamily: 'inherit', cursor: 'pointer',
                        backgroundImage: `url(${idea.imageUrl})`,
                        backgroundSize: 'cover', backgroundPosition: 'center',
                        border: '1px solid var(--wb-border)',
                      }}
                    />
                  )}
                  <div
                    onClick={() => hasDetails ? setExpandedId(expanded ? null : idea.id) : undefined}
                    style={{ flex: 1, minWidth: 0, cursor: hasDetails ? 'pointer' : 'default' }}
                  >
                    <div style={{
                      fontSize: 14, fontWeight: 600, color: 'var(--wb-text)',
                      letterSpacing: '-0.012em', lineHeight: 1.3,
                      textDecoration: done ? 'line-through' : 'none',
                      overflowWrap: 'anywhere',
                    }}>
                      {idea.text}
                      {hasDetails && !expanded && (
                        <span style={{ color: 'var(--wb-text-muted)', fontSize: 12, marginLeft: 6 }}>›</span>
                      )}
                    </div>
                    {(priceText || (!expanded && linkDomain)) && (
                      <div style={{ fontSize: 11.5, color: 'var(--wb-text-muted)', marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {priceText && <span style={{ fontWeight: 700, color: 'var(--wb-text-secondary)', fontFeatureSettings: '"tnum"' }}>{priceText}</span>}
                        {!expanded && linkDomain && (
                          idea.link
                            ? <a href={idea.link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'var(--wb-accent-strong)', textDecoration: 'none' }}>↗ {linkDomain}</a>
                            : <span>· {linkDomain}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void remove(idea.id)}
                    disabled={busyId === idea.id}
                    aria-label={ct('cal_delete', locale)}
                    style={{
                      width: 28, height: 28, borderRadius: 9, flexShrink: 0,
                      background: 'transparent', border: 'none',
                      color: 'var(--wb-text-muted)', fontSize: 16,
                      cursor: 'pointer', fontFamily: 'inherit', padding: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >×</button>
                </div>

                {expanded && (
                  <div style={{ marginTop: 12, paddingLeft: 40 }}>
                    {idea.imageUrl && (
                      <button
                        type="button"
                        onClick={() => setViewingPhoto(idea.imageUrl)}
                        aria-label="Открыть фото"
                        style={{
                          display: 'block', width: '100%', maxWidth: 280, aspectRatio: '4/3',
                          borderRadius: 14, marginBottom: 10, padding: 0, fontFamily: 'inherit',
                          cursor: 'pointer', backgroundImage: `url(${idea.imageUrl})`,
                          backgroundSize: 'cover', backgroundPosition: 'center',
                          border: '1px solid var(--wb-border)',
                        }}
                      />
                    )}
                    {idea.note && (
                      <div style={{
                        fontSize: 13, color: 'var(--wb-text-secondary)', lineHeight: 1.45,
                        marginBottom: 8, overflowWrap: 'anywhere',
                      }}>{idea.note}</div>
                    )}
                    {idea.link && (
                      <a
                        href={idea.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontSize: 13, color: 'var(--wb-accent-strong)', textDecoration: 'none',
                          overflowWrap: 'anywhere', wordBreak: 'break-all',
                        }}
                      >↗ {idea.link}</a>
                    )}
                    <button
                      type="button"
                      onClick={() => setExpandedId(null)}
                      style={{
                        display: 'block', marginTop: 8, padding: '6px 0',
                        background: 'transparent', border: 'none',
                        color: 'var(--wb-text-muted)', fontSize: 12,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >{locale === 'ru' ? 'Свернуть' : 'Collapse'}</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {adding ? (
        <div ref={formRef} style={{ padding: '0 16px 14px' }}>
          <input
            value={text} onChange={e => setText(e.target.value)}
            placeholder={ct('cal_idea_placeholder', locale)}
            maxLength={500}
            autoFocus
            onFocus={() => { setTimeout(() => formRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); }}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
              borderRadius: 16, padding: '12px 14px',
              fontFamily: 'inherit', fontSize: 14, color: 'var(--wb-text)', outline: 'none', marginBottom: 8,
            }}
          />
          <input
            value={note} onChange={e => setNote(e.target.value)}
            placeholder={ct('cal_idea_note_placeholder', locale)}
            maxLength={500}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
              borderRadius: 16, padding: '12px 14px',
              fontFamily: 'inherit', fontSize: 13, color: 'var(--wb-text)', outline: 'none', marginBottom: 8,
            }}
          />
          <input
            value={link} onChange={e => setLink(e.target.value)}
            placeholder={ct('cal_idea_link_placeholder', locale)}
            inputMode="url" autoCapitalize="none" autoCorrect="off"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
              borderRadius: 16, padding: '12px 14px',
              fontFamily: 'inherit', fontSize: 13, color: 'var(--wb-text)', outline: 'none', marginBottom: 8,
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input
              value={price} onChange={e => setPrice(e.target.value)}
              placeholder={ct('cal_idea_price_placeholder', locale)}
              inputMode="numeric"
              onFocus={() => { setTimeout(() => formRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); }}
              style={{
                flex: 2, boxSizing: 'border-box',
                background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
                borderRadius: 16, padding: '12px 14px',
                fontFamily: 'inherit', fontSize: 14, color: 'var(--wb-text)', outline: 'none',
              }}
            />
            <select
              value={currency} onChange={e => setCurrency(e.target.value as IdeaCurrency)}
              style={{
                flex: 1, boxSizing: 'border-box',
                background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
                borderRadius: 16, padding: '12px 14px',
                fontFamily: 'inherit', fontSize: 14, color: 'var(--wb-text)',
              }}
            >
              {IDEA_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            {photoPreview ? (
              <div style={{
                width: 56, height: 56, borderRadius: 12, flexShrink: 0,
                backgroundImage: `url(${photoPreview})`,
                backgroundSize: 'cover', backgroundPosition: 'center',
                border: '1px solid var(--wb-border)',
              }} />
            ) : null}
            <label style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '12px 14px', borderRadius: 16,
              background: 'var(--wb-card)', border: '1px dashed var(--wb-border-strong)',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
              color: 'var(--wb-text-secondary)', cursor: 'pointer',
            }}>
              {photoFile ? `📎 ${photoFile.name.slice(0, 24)}${photoFile.name.length > 24 ? '…' : ''}` : `📷 ${ct('cal_idea_add_photo', locale)}`}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(e) => onPickPhoto(e.target.files?.[0] ?? null)}
                style={{ display: 'none' }}
              />
            </label>
            {photoFile && (
              <button
                type="button"
                onClick={() => onPickPhoto(null)}
                aria-label={ct('cal_delete', locale)}
                style={{
                  width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                  background: 'transparent', border: '1px solid var(--wb-border)',
                  color: 'var(--wb-text-muted)', fontSize: 16, cursor: 'pointer',
                  fontFamily: 'inherit', padding: 0,
                }}
              >×</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={saving || !text.trim()}
              style={{ ...surfaceBtnStyle, flex: 1, opacity: !text.trim() ? 0.5 : 1 }}
            >{saving ? '…' : ct('cal_save', locale)}</button>
            <button
              type="button"
              onClick={reset}
              style={{ ...surfaceBtnStyle, flex: 1 }}
            >{ct('cal_cancel', locale)}</button>
          </div>
        </div>
      ) : (
        <div style={{ padding: '0 16px 14px' }}>
          <button
            type="button"
            onClick={() => setAdding(true)}
            style={surfaceBtnStyle}
          >＋ {ct('cal_idea_add', locale)}</button>
        </div>
      )}

      {viewingPhoto && (
        <PhotoViewer url={viewingPhoto} onClose={() => setViewingPhoto(null)} />
      )}
    </>
  );
}

// Lightweight full-screen photo viewer. Renders a fixed overlay with the
// image centered + a close affordance. Tap the backdrop or close button to
// dismiss; the image itself is non-interactive (no zoom in this pass —
// adding pinch-zoom would balloon the diff and the bug is just "can't open").
function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.92)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'env(safe-area-inset-top) 16px env(safe-area-inset-bottom)',
        animation: 'fadeIn 0.18s ease',
      }}
    >
      <img
        src={url}
        alt=""
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
          borderRadius: 12, display: 'block',
        }}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть"
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top) + 12px)',
          right: 12,
          width: 40, height: 40, borderRadius: 20,
          background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)',
          color: '#fff', fontSize: 18, cursor: 'pointer', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          WebkitBackdropFilter: 'blur(10px)' as never, backdropFilter: 'blur(10px)' as never,
        }}
      >×</button>
    </div>
  );
}

function safeDomain(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || null;
  }
}

// ─── Past-event section ────────────────────────────────────────────────────

function PastSection({ tgFetch, occasion, locale, onChanged, onShowToast }: {
  tgFetch: TgFetch; occasion: OccasionDetail; locale: Locale; onChanged: () => Promise<void>; onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
}) {
  const [giftText, setGiftText] = useState(occasion.actualGiftText ?? '');
  const [giftAmount, setGiftAmount] = useState(occasion.actualGiftAmount ?? '');
  const [giftCurrency, setGiftCurrency] = useState(occasion.actualGiftCurrency ?? 'RUB');
  const [thankYou, setThankYou] = useState(occasion.thankYouNote ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateOccasion(tgFetch, occasion.id, {
        actualGiftText: giftText || null,
        actualGiftAmount: typeof giftAmount === 'number' ? giftAmount : (giftAmount ? Number(giftAmount) : null),
        actualGiftCurrency: giftCurrency || null,
        thankYouNote: thankYou || null,
      });
      onShowToast('Сохранено', 'success');
      await onChanged();
    } catch (err) {
      onShowToast('Ошибка', 'error');
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {occasion.actualGiftText && (
        <InfoGroup>
          <InfoRow
            icon="✓"
            label="Подарили"
            value={`${occasion.actualGiftText}${occasion.actualGiftAmount ? ` · ${occasion.actualGiftAmount} ${occasion.actualGiftCurrency ?? ''}` : ''}`}
          />
        </InfoGroup>
      )}

      {occasion.thankYouNote && (
        <>
          <SectionH>{ct('cal_thank_you_title', locale)}</SectionH>
          <div style={{
            margin: '0 16px 14px', padding: '16px 18px',
            background: 'linear-gradient(135deg, rgba(240,106,180,0.12), rgba(139,123,255,0.12))',
            border: '1px solid var(--wb-border)', borderRadius: 18, position: 'relative',
          }}>
            <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--wb-text)', fontStyle: 'italic', letterSpacing: '-0.005em' }}>
              "{occasion.thankYouNote}"
            </div>
            {occasion.thankYouAt && (
              <div style={{ fontSize: 11.5, color: 'var(--wb-text-muted)', marginTop: 10 }}>
                — {formatDate(occasion.thankYouAt, locale)}
              </div>
            )}
          </div>
        </>
      )}

      {!occasion.actualGiftText && (
        <>
          <SectionH>Что подарили?</SectionH>
          <div style={{ padding: '0 16px' }}>
            <input
              value={giftText} onChange={e => setGiftText(e.target.value)}
              placeholder="Например: книга «Думай быстро»"
              maxLength={300}
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--wb-card)', border: '1px solid var(--wb-border)', borderRadius: 16, padding: '14px 16px', fontFamily: 'inherit', fontSize: 15, color: 'var(--wb-text)', outline: 'none', marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={giftAmount} onChange={e => setGiftAmount(e.target.value as never)}
                placeholder="0" inputMode="numeric"
                style={{ flex: 2, background: 'var(--wb-card)', border: '1px solid var(--wb-border)', borderRadius: 16, padding: '14px 16px', fontFamily: 'inherit', fontSize: 15, color: 'var(--wb-text)', outline: 'none' }}
              />
              <select value={giftCurrency} onChange={e => setGiftCurrency(e.target.value)}
                style={{ flex: 1, background: 'var(--wb-card)', border: '1px solid var(--wb-border)', borderRadius: 16, padding: '14px 16px', fontFamily: 'inherit', fontSize: 15, color: 'var(--wb-text)' }}>
                {['RUB', 'USD', 'EUR', 'GBP', 'CNY', 'INR', 'AED', 'SAR'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <textarea
              value={thankYou} onChange={e => setThankYou(e.target.value)}
              placeholder={ct('cal_thank_you_title', locale)}
              maxLength={500}
              style={{ width: '100%', boxSizing: 'border-box', minHeight: 80, marginTop: 8, background: 'var(--wb-card)', border: '1px solid var(--wb-border)', borderRadius: 16, padding: '14px 16px', fontFamily: 'inherit', fontSize: 14, color: 'var(--wb-text)', outline: 'none', resize: 'vertical' }}
            />
            <button onClick={save} disabled={saving} style={{ ...surfaceBtnStyle, marginTop: 8, width: '100%' }}>
              {saving ? '…' : ct('cal_save', locale)}
            </button>
          </div>
        </>
      )}
    </>
  );
}

// ─── Edit-occasion sheet ──────────────────────────────────────────────────
//
// Lightweight edit form (title / emoji / date / recurrence / location). Uses
// the existing day/month/year picker sheets so we don't duplicate UI primitives.
// Wires through `api.updateOccasion` which the create-flow already exercises.

const EMOJI_PALETTE: Record<string, string[]> = {
  BIRTHDAY:    ['🎂', '🎉', '🎁', '🍰', '🌹', '⭐'],
  ANNIVERSARY: ['💍', '💐', '💖', '🥂', '🌹', '✨'],
  HOLIDAY:     ['🎄', '🎃', '🌷', '🛡️', '🇷🇺', '🎊'],
  OTHER:       ['📅', '🎯', '🚀', '✨', '⭐', '🔔'],
};

function EditOccasionSheet({ open, onClose, tgFetch, occasion: o, locale, onSaved, onShowToast }: {
  open: boolean;
  onClose: () => void;
  tgFetch: TgFetch;
  occasion: OccasionDetail;
  locale: Locale;
  onSaved: () => Promise<void>;
  onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
}) {
  const initialDate = useMemo(() => {
    const iso = o.eventDate ?? o.nextDate;
    if (!iso) {
      const now = new Date();
      return { day: now.getUTCDate(), month: now.getUTCMonth(), year: now.getUTCFullYear() };
    }
    const d = new Date(iso);
    return { day: d.getUTCDate(), month: d.getUTCMonth(), year: d.getUTCFullYear() };
  }, [o.eventDate, o.nextDate]);

  const [title, setTitle] = useState(o.title);
  const [emoji, setEmoji] = useState<string>(o.emoji ?? defaultEmojiForType(o.type));
  const [day, setDay] = useState(initialDate.day);
  const [month, setMonth] = useState(initialDate.month);
  const [year, setYear] = useState<number>(initialDate.year);
  const [recurrence, setRecurrence] = useState<EventRecurrence>(o.recurrence);
  const [location, setLocation] = useState(o.location ?? '');
  const [saving, setSaving] = useState(false);
  const [pickOpen, setPickOpen] = useState<'day' | 'month' | 'year' | null>(null);

  // Reset form when sheet re-opens for a new occasion.
  useEffect(() => {
    if (!open) return;
    setTitle(o.title);
    setEmoji(o.emoji ?? defaultEmojiForType(o.type));
    setDay(initialDate.day);
    setMonth(initialDate.month);
    setYear(initialDate.year);
    setRecurrence(o.recurrence);
    setLocation(o.location ?? '');
  }, [open, o.id, o.title, o.emoji, o.type, o.recurrence, o.location, initialDate.day, initialDate.month, initialDate.year]);

  const daysInMonth = useMemo(() => new Date(Date.UTC(year, month + 1, 0)).getUTCDate(), [year, month]);
  const safeDay = Math.min(day, daysInMonth);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const eventDateIso = `${year}-${String(month + 1).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
      await api.updateOccasion(tgFetch, o.id, {
        title: title.trim(),
        emoji,
        eventDate: eventDateIso,
        recurrence,
        location: location.trim() || undefined,
      });
      onShowToast(ct('cal_save', locale), 'success');
      await onSaved();
    } catch (err) {
      onShowToast('Не удалось сохранить', 'error');
      // eslint-disable-next-line no-console
      console.error('Edit occasion failed', err);
    } finally {
      setSaving(false);
    }
  };

  const palette = EMOJI_PALETTE[o.type] ?? EMOJI_PALETTE.OTHER!;

  // Picker sheets MUST render as siblings of the parent <Sheet>, NOT as
  // children. The Sheet primitive sets `willChange: transform` on its content
  // wrapper, which creates a containing block for descendants with
  // `position: fixed`. Day/Month/YearPickerSheet are themselves Sheets with
  // fixed positioning — nested inside the edit sheet, their viewport-relative
  // anchoring breaks: they get pinned to the bottom of the edit sheet's
  // scrollable area instead of the visualViewport, where they're invisible
  // unless something forces them into view (which Year did, via scrollIntoView
  // on the active year — that's why only year appeared to "work"). Hoisting
  // the pickers to the fragment level keeps them at viewport scope.
  return (
    <>
      <Sheet open={open} onClose={onClose} title={ct('cal_edit', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={editLabelStyle}>{ct('cal_field_name', locale)}</div>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={120}
              style={editInputStyle}
            />
          </div>

          <div>
            <div style={editLabelStyle}>{ct('cal_field_emoji', locale)}</div>
            <EmojiPicker value={emoji} options={palette} onChange={setEmoji} locale={locale} />
          </div>

          <div>
            <div style={editLabelStyle}>{ct('cal_field_date', locale)}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1fr', gap: 8 }}>
              <button type="button" onClick={() => setPickOpen('day')} style={editChipStyle}>{safeDay}</button>
              <button type="button" onClick={() => setPickOpen('month')} style={editChipStyle}>{monthLabelLong(month, locale)}</button>
              <button type="button" onClick={() => setPickOpen('year')} style={editChipStyle}>{year}</button>
            </div>
          </div>

          <div>
            <div style={editLabelStyle}>{ct('cal_field_repeat', locale)}</div>
            <RepeatChips<EventRecurrence>
              value={recurrence}
              onChange={setRecurrence}
              options={[
                { key: 'NONE',    label: ct('cal_recur_none', locale) },
                { key: 'YEARLY',  label: ct('cal_recur_yearly', locale) },
                { key: 'MONTHLY', label: ct('cal_recur_monthly', locale) },
              ]}
            />
          </div>

          <div>
            <div style={editLabelStyle}>{ct('cal_field_location', locale)}</div>
            <input
              value={location}
              onChange={e => setLocation(e.target.value)}
              maxLength={200}
              style={editInputStyle}
            />
          </div>

          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !title.trim()}
            style={{ ...primaryBtnStyle, opacity: !title.trim() ? 0.5 : 1 }}
          >{saving ? '…' : ct('cal_save', locale)}</button>
        </div>
      </Sheet>

      <DayPickerSheet
        open={open && pickOpen === 'day'}
        onClose={() => setPickOpen(null)}
        value={safeDay}
        max={daysInMonth}
        onPick={(d) => { setDay(d); setPickOpen(null); }}
        locale={locale}
      />
      <MonthPickerSheet
        open={open && pickOpen === 'month'}
        onClose={() => setPickOpen(null)}
        value={month}
        onPick={(m) => { setMonth(m); setPickOpen(null); }}
        locale={locale}
      />
      <YearPickerSheet
        open={open && pickOpen === 'year'}
        onClose={() => setPickOpen(null)}
        value={year}
        onPick={(y) => { setYear(y); setPickOpen(null); }}
        locale={locale}
      />
    </>
  );
}

const editLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--wb-text-muted)',
  textTransform: 'uppercase' as const, letterSpacing: 0.7, marginBottom: 8,
};
const editInputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
  borderRadius: 14, padding: '12px 14px',
  fontFamily: 'inherit', fontSize: 15, color: 'var(--wb-text)', outline: 'none',
};
const editChipStyle: React.CSSProperties = {
  padding: '12px 6px', borderRadius: 12,
  background: 'var(--wb-card)', border: '1px solid var(--wb-border)',
  color: 'var(--wb-text)', fontSize: 14, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit', fontFeatureSettings: '"tnum"',
};

// ─── Date helpers ─────────────────────────────────────────────────────────

function formatDate(iso: string | null, locale: Locale): string {
  if (!iso) return '';
  const d = new Date(iso);
  const wd = weekdayLabels(locale);
  const wdIdx = (d.getUTCDay() + 6) % 7;
  return `${d.getUTCDate()} ${monthLabelLong(d.getUTCMonth(), locale)} · ${wd[wdIdx]}`;
}

function formatOffset(offsetDays: number, locale: Locale): string {
  if (offsetDays === 0) return '0 д';
  return offsetDays > 0 ? `+${offsetDays} д` : `${offsetDays} д`;
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '15px 22px', borderRadius: 18, border: 'none',
  background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
  color: '#fff', fontSize: 15, fontWeight: 650, letterSpacing: '-0.015em',
  cursor: 'pointer', minHeight: 52, fontFamily: 'inherit',
  boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
  width: '100%',
};
const surfaceBtnStyle: React.CSSProperties = {
  padding: '15px 22px', borderRadius: 18,
  background: 'var(--wb-card-strong)', border: '1px solid var(--wb-border-strong)',
  color: 'var(--wb-text)', fontSize: 15, fontWeight: 650,
  cursor: 'pointer', minHeight: 52, fontFamily: 'inherit', width: '100%',
  WebkitBackdropFilter: 'blur(14px)' as never, backdropFilter: 'blur(14px)' as never,
};
const ghostDangerBtnStyle: React.CSSProperties = {
  padding: '12px 22px', borderRadius: 18,
  background: 'transparent', border: 'none',
  color: '#FB7185', fontSize: 14, fontWeight: 650,
  cursor: 'pointer', fontFamily: 'inherit',
};
