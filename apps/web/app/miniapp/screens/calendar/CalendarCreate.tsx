/**
 * Create-event wizard — 4 steps:
 *   E-1 Type picker (BIRTHDAY / ANNIVERSARY / HOLIDAY / OTHER) + import shortcuts
 *   E-2 Details (title, emoji, date, repeat, optional friend link)
 *   E-3 Reminders (toggle each preset on/off)
 *   E-4 Success screen
 *
 * Uses existing /tg/gift-occasions POST + /tg/gift-occasions/:id/reminders POST.
 */

'use client';

import React, { useEffect, useState } from 'react';
import type { Locale } from '@wishlist/shared';
import type { TgFetch, CreateOccasionPayload } from './api';
import * as api from './api';
import type { EventType, EventRecurrence } from './types';
import { defaultEmojiForType } from './types';
import {
  CalHeader, FormLabel, CalInput, EmojiPicker, RepeatChips, InfoGroup, InfoRow,
  SectionH, ReminderRow, CtaBar, monthLabelLong,
} from './components';
import { ct } from './i18n';

interface Props {
  tgFetch: TgFetch;
  locale: Locale;
  prefill?: { type?: EventType; linkedUserId?: string };
  onCancel: () => void;
  onCreated: (occasionId: string) => Promise<void>;
  onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
}

interface DraftState {
  type: EventType;
  title: string;
  emoji: string;
  day: number;
  month: number;
  year: number | null;
  recurrence: EventRecurrence;
  linkedUserId: string | null;
  defaultReminders: boolean;
  enabled: Record<number, boolean>; // offset → enabled
}

const EMOJI_BY_TYPE: Record<EventType, string[]> = {
  BIRTHDAY:    ['🎂', '🎉', '🎁', '🍰', '🌹', '⭐'],
  ANNIVERSARY: ['💍', '💐', '💖', '🥂', '🌹', '✨'],
  HOLIDAY:     ['🎄', '🎃', '🌷', '🛡️', '🇷🇺', '🎊'],
  OTHER:       ['📅', '🎯', '🚀', '✨', '⭐', '🔔'],
};

export function CalendarCreate({ tgFetch, locale, prefill, onCancel, onCreated, onShowToast }: Props) {
  const today = new Date();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [draft, setDraft] = useState<DraftState>({
    type: prefill?.type ?? 'BIRTHDAY',
    title: '',
    emoji: defaultEmojiForType(prefill?.type ?? 'BIRTHDAY'),
    day: today.getUTCDate(),
    month: today.getUTCMonth(),
    year: today.getUTCFullYear(),
    recurrence: 'YEARLY',
    linkedUserId: prefill?.linkedUserId ?? null,
    defaultReminders: true,
    enabled: { [-7]: true, [-1]: true, 0: true },
  });
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const update = (patch: Partial<DraftState>) => setDraft(d => ({ ...d, ...patch }));

  return (
    <div style={{ minHeight: '100%', color: 'var(--wb-text)', paddingBottom: 'calc(120px + env(safe-area-inset-bottom))' }}>
      <CalHeader
        title={step === 1 ? ct('cal_create_title', locale) : (draft.title || ct('cal_create_title', locale))}
        subtitle={step < 4 ? ct('cal_create_step_label', locale, { n: step }) : undefined}
        onBack={step > 1 ? () => setStep((step - 1) as 1 | 2 | 3) : onCancel}
      />

      {step === 1 && <Step1Type draft={draft} onChange={update} locale={locale} />}
      {step === 2 && <Step2Details draft={draft} onChange={update} locale={locale} />}
      {step === 3 && <Step3Reminders draft={draft} onChange={update} locale={locale} />}
      {step === 4 && <Step4Success locale={locale} title={draft.title} emoji={draft.emoji} />}

      <CtaBar>
        {step < 4 && (
          <button
            disabled={creating || (step === 2 && !draft.title.trim())}
            onClick={async () => {
              if (step === 1) setStep(2);
              else if (step === 2) setStep(3);
              else if (step === 3) {
                setCreating(true);
                try {
                  const enabledOffsets = Object.entries(draft.enabled).filter(([, v]) => v).map(([k]) => Number(k));
                  const eventDateIso = `${draft.year ?? today.getUTCFullYear()}-${String(draft.month + 1).padStart(2, '0')}-${String(draft.day).padStart(2, '0')}`;
                  const payload: CreateOccasionPayload = {
                    title: draft.title.trim(),
                    type: draft.type,
                    emoji: draft.emoji,
                    eventDate: eventDateIso,
                    recurrence: draft.recurrence,
                    linkedUserId: draft.linkedUserId ?? undefined,
                    defaultReminders: false, // we'll set explicit ones below
                  };
                  const r = await api.createOccasion(tgFetch, payload);
                  setCreatedId(r.occasion.id);
                  // Attach reminders
                  for (const off of enabledOffsets) {
                    await api.createReminder(tgFetch, r.occasion.id, { offsetDays: off });
                  }
                  setStep(4);
                } catch (err) {
                  onShowToast('Не удалось создать событие', 'error');
                  // eslint-disable-next-line no-console
                  console.error('Create event failed', err);
                } finally {
                  setCreating(false);
                }
              }
            }}
            style={{ ...primaryBtnStyle, opacity: (creating || (step === 2 && !draft.title.trim())) ? 0.5 : 1 }}
          >{step === 3 ? ct('cal_done', locale) : ct('cal_next', locale)}</button>
        )}
        {step === 4 && createdId && (
          <button onClick={() => void onCreated(createdId)} style={primaryBtnStyle}>
            {ct('cal_open_calendar', locale)}
          </button>
        )}
      </CtaBar>
    </div>
  );
}

// ─── Step 1 — Type picker ─────────────────────────────────────────────────

function Step1Type({ draft, onChange, locale }: { draft: DraftState; onChange: (p: Partial<DraftState>) => void; locale: Locale }) {
  const types: Array<{ key: EventType; emoji: string; label: string; sub: string; bgGradient: string }> = [
    { key: 'BIRTHDAY',    emoji: '🎂', label: ct('cal_type_birthday', locale),    sub: ct('cal_type_birthday_sub', locale),    bgGradient: 'radial-gradient(circle at 100% 0%, rgba(240,106,180,0.45), transparent 65%)' },
    { key: 'ANNIVERSARY', emoji: '💍', label: ct('cal_type_anniversary', locale), sub: ct('cal_type_anniversary_sub', locale), bgGradient: 'radial-gradient(circle at 100% 0%, rgba(251,191,36,0.45), transparent 65%)' },
    { key: 'HOLIDAY',     emoji: '🎄', label: ct('cal_type_holiday', locale),     sub: ct('cal_type_holiday_sub', locale),     bgGradient: 'radial-gradient(circle at 100% 0%, rgba(52,201,138,0.45), transparent 65%)' },
    { key: 'OTHER',       emoji: '✦',  label: ct('cal_type_custom', locale),      sub: ct('cal_type_custom_sub', locale),      bgGradient: 'radial-gradient(circle at 100% 0%, var(--wb-accent-shadow), transparent 65%)' },
  ];
  return (
    <>
      <div style={{ padding: '8px 24px 18px', textAlign: 'center' }}>
        <div style={{ fontSize: 14, color: 'var(--wb-text-secondary)', lineHeight: 1.5 }}>{ct('cal_create_what', locale)}</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '0 16px 14px' }}>
        {types.map(t => {
          const active = draft.type === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onChange({ type: t.key, emoji: defaultEmojiForType(t.key) })}
              style={{
                padding: '14px 14px 16px', borderRadius: 20,
                background: active ? 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))' : 'var(--wb-card)',
                border: active ? '1px solid var(--wb-accent-soft-strong)' : '1px solid var(--wb-border)',
                boxShadow: active ? '0 0 0 3px var(--wb-accent-soft)' : 'none',
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                position: 'relative', overflow: 'hidden',
                WebkitBackdropFilter: 'blur(12px)' as never, backdropFilter: 'blur(12px)' as never,
              }}
            >
              <div style={{ position: 'absolute', top: '-30%', right: '-30%', width: 120, height: 120, borderRadius: '50%', background: t.bgGradient, opacity: 0.55 }} />
              <div style={{ fontSize: 28, lineHeight: 1, marginBottom: 8, position: 'relative' }}>{t.emoji}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--wb-text)', letterSpacing: '-0.012em', position: 'relative' }}>{t.label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--wb-text-muted)', marginTop: 3, position: 'relative', lineHeight: 1.35 }}>{t.sub}</div>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ─── Step 2 — Details ─────────────────────────────────────────────────────

function Step2Details({ draft, onChange, locale }: { draft: DraftState; onChange: (p: Partial<DraftState>) => void; locale: Locale }) {
  const today = new Date();
  return (
    <>
      <FormLabel>{ct('cal_field_name', locale)}</FormLabel>
      <CalInput value={draft.title} onChange={v => onChange({ title: v })} placeholder={ct('cal_create_what', locale)} maxLength={150} />

      <FormLabel>{ct('cal_field_emoji', locale)}</FormLabel>
      <EmojiPicker value={draft.emoji} options={EMOJI_BY_TYPE[draft.type]} onChange={(e) => onChange({ emoji: e })} />

      <FormLabel>{ct('cal_field_date', locale)}</FormLabel>
      <div style={{ margin: '0 16px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <DateCell label="день" value={String(draft.day)}
          onClick={() => onChange({ day: ((draft.day) % 31) + 1 })} />
        <DateCell label="месяц" value={monthLabelLong(draft.month, locale)} highlighted
          onClick={() => onChange({ month: (draft.month + 1) % 12 })} />
        <DateCell label="год" value={String(draft.year ?? today.getUTCFullYear())}
          onClick={() => onChange({ year: (draft.year ?? today.getUTCFullYear()) === 1900 ? today.getUTCFullYear() : ((draft.year ?? today.getUTCFullYear()) - 1) })} />
      </div>

      <FormLabel>{ct('cal_field_repeat', locale)}</FormLabel>
      <RepeatChips<EventRecurrence>
        value={draft.recurrence}
        options={[
          { key: 'NONE', label: ct('cal_recur_none', locale) },
          { key: 'YEARLY', label: ct('cal_recur_yearly', locale) },
          { key: 'MONTHLY', label: ct('cal_recur_monthly', locale) },
        ]}
        onChange={r => onChange({ recurrence: r })}
      />
    </>
  );
}

function DateCell({ label, value, onClick, highlighted }: { label: string; value: string; onClick: () => void; highlighted?: boolean }) {
  return (
    <button onClick={onClick} style={{
      padding: '12px 8px', borderRadius: 14,
      background: highlighted ? 'linear-gradient(180deg, var(--wb-accent-soft), var(--wb-card))' : 'var(--wb-card)',
      border: highlighted ? '1px solid var(--wb-accent-soft-strong)' : '1px solid var(--wb-border)',
      textAlign: 'center', cursor: 'pointer', fontFamily: 'inherit',
      WebkitBackdropFilter: 'blur(10px)' as never, backdropFilter: 'blur(10px)' as never,
    }}>
      <div style={{ fontSize: 10.5, color: 'var(--wb-text-muted)', fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--wb-text)', letterSpacing: '-0.02em', marginTop: 4, fontFeatureSettings: '"tnum"' }}>{value}</div>
    </button>
  );
}

// ─── Step 3 — Reminders ──────────────────────────────────────────────────

function Step3Reminders({ draft, onChange, locale }: { draft: DraftState; onChange: (p: Partial<DraftState>) => void; locale: Locale }) {
  const presets = [
    { off: -14, k: 'cal_reminder_2w' as const },
    { off: -7,  k: 'cal_reminder_1w' as const },
    { off: -3,  k: 'cal_reminder_3d' as const },
    { off: -1,  k: 'cal_reminder_1d' as const },
    { off: 0,   k: 'cal_reminder_0d' as const },
  ];
  return (
    <>
      <div style={{ padding: '8px 24px 18px', textAlign: 'center' }}>
        <div style={{ fontSize: 15, color: 'var(--wb-text-secondary)', lineHeight: 1.5 }}>{ct('cal_reminders_when', locale)}</div>
      </div>

      <InfoGroup>
        {presets.map(p => (
          <ReminderRow
            key={p.off}
            offsetLabel={p.off === 0 ? '0 д' : `${p.off} д`}
            title={ct(p.k, locale)}
            on={!!draft.enabled[p.off]}
            onChange={v => onChange({ enabled: { ...draft.enabled, [p.off]: v } })}
          />
        ))}
      </InfoGroup>
    </>
  );
}

// ─── Step 4 — Success ────────────────────────────────────────────────────

function Step4Success({ locale, title, emoji }: { locale: Locale; title: string; emoji: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 24px 24px' }}>
      <div style={{
        width: 120, height: 120, borderRadius: 36,
        background: 'radial-gradient(circle at 30% 30%, var(--wb-accent-strong), var(--wb-accent-deep))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 64, marginBottom: 24,
        boxShadow: '0 20px 50px var(--wb-accent-shadow), inset 0 2px 0 rgba(255,255,255,0.25)',
      }}>{emoji}</div>
      <h2 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--wb-text)', margin: '0 0 8px', textAlign: 'center', lineHeight: 1.1 }}>
        {ct('cal_create_success_title', locale)}
      </h2>
      <p style={{ fontSize: 14, color: 'var(--wb-text-secondary)', textAlign: 'center', margin: '0 0 22px', lineHeight: 1.5, maxWidth: 280 }}>
        {title}
      </p>
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '15px 22px', borderRadius: 18, border: 'none',
  background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
  color: '#fff', fontSize: 15, fontWeight: 650, letterSpacing: '-0.015em',
  cursor: 'pointer', minHeight: 52, fontFamily: 'inherit', width: '100%',
  boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
};
