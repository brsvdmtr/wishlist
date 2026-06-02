// Circle event-push notifications — P0.3 «Событийные пуши» settings screen.
//
// FREE feature (a retention driver, not Pro-gated). Self-contained lazy chunk
// like CirclesRoot: receives `tgFetch`, `locale`, `onBack`, `pushToast`. Reads
// GET /tg/notification-preferences + GET /tg/circles (for the per-circle mute
// list), writes via PATCH /tg/notification-preferences and PUT /tg/circles/:id/
// mute. All UI is built from @wishlist/ui primitives + @wishlist/ui-tokens.

import React, { useCallback, useEffect, useState } from 'react';

import { t, type Locale } from '@wishlist/shared';
import { SettingsSection, SettingsToggle, SettingsRow, SettingsDivider, Chip } from '@wishlist/ui';
import { colors as c, radius as r, spacing as sp, fontSize as fs, fontWeight as fw } from '@wishlist/ui-tokens';

type TgFetchInit = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  idempotency?: string | { action: string };
};
export type TgFetchFn = (url: string, init?: TgFetchInit) => Promise<Response>;

interface Prefs {
  notifyCircleEvents: boolean;
  notifyCircleNewWishes: boolean;
  notifyCircleReservationChanges: boolean;
  notifyCircleJoins: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  notifyTimezone: string | null;
}

interface CircleMini {
  id: string;
  name: string;
  emoji: string | null;
  muted: boolean;
}

export interface CircleNotificationsScreenProps {
  tgFetch: TgFetchFn;
  locale: Locale;
  onBack: () => void;
  pushToast: (message: string, kind: 'success' | 'error' | 'info') => void;
}

function detectTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function CircleNotificationsScreen({ tgFetch, locale, onBack, pushToast }: CircleNotificationsScreenProps) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [circles, setCircles] = useState<CircleMini[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [pRes, cRes] = await Promise.all([
          tgFetch('/tg/notification-preferences'),
          tgFetch('/tg/circles'),
        ]);
        const pJson = (await pRes.json()) as { preferences: Prefs };
        const cJson = (await cRes.json()) as { circles: Array<{ id: string; name: string; emoji: string | null; muted?: boolean }> };
        if (!alive) return;
        setPrefs(pJson.preferences);
        setCircles((cJson.circles ?? []).map((x) => ({ id: x.id, name: x.name, emoji: x.emoji, muted: !!x.muted })));

        // Auto-detect & persist the timezone once so quiet hours use the user's
        // real local time (the column defaults to null = "never set").
        if (pJson.preferences && pJson.preferences.notifyTimezone == null) {
          const tz = detectTimezone();
          if (tz) {
            void tgFetch('/tg/notification-preferences', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ notifyTimezone: tz }),
              idempotency: { action: 'notification.prefs:notifyTimezone' },
            }).then((res) => {
              if (res.ok && alive) setPrefs((prev) => (prev ? { ...prev, notifyTimezone: tz } : prev));
            }).catch(() => { /* non-critical */ });
          }
        }
      } catch {
        if (alive) pushToast(t('error_generic', locale), 'error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [tgFetch, locale, pushToast]);

  const patchPref = useCallback(async (patch: Partial<Prefs>) => {
    setPrefs((prev) => (prev ? { ...prev, ...patch } : prev)); // optimistic
    try {
      const res = await tgFetch('/tg/notification-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        // Scope the idempotency key to the fields being patched — distinct
        // operations on the same row need distinct action names, else a second
        // toggle reuses the key with a different body → KEY_REUSED error.
        idempotency: { action: `notification.prefs:${Object.keys(patch).sort().join(',')}` },
      });
      if (!res.ok) throw new Error('patch_failed');
      const j = (await res.json()) as { preferences: Prefs };
      setPrefs(j.preferences);
    } catch {
      pushToast(t('error_generic', locale), 'error');
      // Re-pull authoritative state on failure.
      try {
        const res = await tgFetch('/tg/notification-preferences');
        const j = (await res.json()) as { preferences: Prefs };
        setPrefs(j.preferences);
      } catch { /* leave optimistic value */ }
    }
  }, [tgFetch, locale, pushToast]);

  const toggleMute = useCallback(async (circleId: string, nextMuted: boolean) => {
    const prev = circles;
    setCircles((cs) => cs.map((cc) => (cc.id === circleId ? { ...cc, muted: nextMuted } : cc)));
    try {
      const res = await tgFetch(`/tg/circles/${circleId}/mute`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted: nextMuted }),
        idempotency: { action: `circle.mute:${circleId}` },
      });
      if (!res.ok) throw new Error('mute_failed');
    } catch {
      setCircles(prev); // rollback
      pushToast(t('error_generic', locale), 'error');
    }
  }, [circles, tgFetch, locale, pushToast]);

  const timeInputStyle: React.CSSProperties = {
    background: c.cardStrong,
    border: `1px solid ${c.borderStrong}`,
    borderRadius: r.md,
    padding: `${sp[2]}px ${sp[3]}px`,
    color: c.text,
    fontSize: fs.lg,
    fontWeight: fw.strong,
    fontFamily: 'inherit',
    colorScheme: 'dark', // legit CSS property (no token); makes the native picker dark
  };

  return (
    <div style={{ padding: `${sp[4]}px ${sp[4]}px 120px`, minHeight: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: sp[2], marginBottom: sp[4] }}>
        <button
          type="button" onClick={onBack} aria-label={t('back', locale)}
          style={{
            width: 44, height: 44, minWidth: 44, borderRadius: r.lg, border: `1px solid ${c.border}`,
            background: c.surface, color: c.text, fontSize: fs.lg, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >←</button>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: sp[2] }}>
          <div style={{ fontSize: fs.xxl, fontWeight: fw.strong, color: c.text, letterSpacing: '-0.018em' }}>
            {t('cnset_title', locale)}
          </div>
          <Chip tone="success">{t('cnset_free_badge', locale)}</Chip>
        </div>
      </div>

      {loading || !prefs ? (
        <div style={{ textAlign: 'center', color: c.textMuted, padding: `${sp[8]}px 0`, fontSize: fs.sm }}>…</div>
      ) : (
        <>
          {/* Event types */}
          <SettingsSection title={t('cnset_types_title', locale)}>
            <SettingsToggle
              icon={'\u{1F382}'}
              label={t('cnset_events', locale)}
              hint={t('cnset_events_hint', locale)}
              value={prefs.notifyCircleEvents}
              onChange={(v) => patchPref({ notifyCircleEvents: v })}
            />
            <SettingsDivider />
            <SettingsToggle
              icon={'\u{1F381}'}
              label={t('cnset_new_wishes', locale)}
              hint={t('cnset_new_wishes_hint', locale)}
              value={prefs.notifyCircleNewWishes}
              onChange={(v) => patchPref({ notifyCircleNewWishes: v })}
            />
            <SettingsDivider />
            <SettingsToggle
              icon={'\u{1F4E6}'}
              label={t('cnset_reservations', locale)}
              hint={t('cnset_reservations_hint', locale)}
              value={prefs.notifyCircleReservationChanges}
              onChange={(v) => patchPref({ notifyCircleReservationChanges: v })}
            />
            <SettingsDivider />
            <SettingsToggle
              icon={'\u{1F465}'}
              label={t('cnset_joins', locale)}
              hint={t('cnset_joins_hint', locale)}
              value={prefs.notifyCircleJoins}
              onChange={(v) => patchPref({ notifyCircleJoins: v })}
            />
          </SettingsSection>

          {/* Quiet hours */}
          <SettingsSection title={t('cnset_quiet_title', locale)} style={{ marginTop: sp[5] }}>
            <SettingsToggle
              icon={'\u{1F319}'}
              label={t('cnset_quiet_toggle', locale)}
              hint={t('cnset_quiet_hint', locale)}
              value={prefs.quietHoursEnabled}
              onChange={(v) => patchPref({ quietHoursEnabled: v })}
            />
            {prefs.quietHoursEnabled && (
              <>
                <SettingsDivider />
                <div style={{ display: 'flex', alignItems: 'center', gap: sp[2], padding: '12px 0' }}>
                  <input
                    type="time"
                    aria-label={t('cnset_quiet_title', locale)}
                    value={prefs.quietHoursStart}
                    onChange={(e) => { if (e.target.value) patchPref({ quietHoursStart: e.target.value }); }}
                    style={timeInputStyle}
                  />
                  <span style={{ color: c.textMuted, fontSize: fs.sm }}>{t('cnset_quiet_to', locale)}</span>
                  <input
                    type="time"
                    aria-label={t('cnset_quiet_title', locale)}
                    value={prefs.quietHoursEnd}
                    onChange={(e) => { if (e.target.value) patchPref({ quietHoursEnd: e.target.value }); }}
                    style={timeInputStyle}
                  />
                </div>
              </>
            )}
            <SettingsDivider />
            <SettingsRow
              icon={'\u{1F30D}'}
              label={t('cnset_timezone', locale)}
              value={prefs.notifyTimezone || t('cnset_timezone_auto', locale)}
              valueSmall
            />
          </SettingsSection>

          {/* Per-circle mute */}
          <SettingsSection title={t('cnset_circles_title', locale)} style={{ marginTop: sp[5] }}>
            {circles.length === 0 ? (
              <div style={{ fontSize: fs.sm, color: c.textMuted, padding: '14px 0' }}>
                {t('cnset_empty_circles', locale)}
              </div>
            ) : (
              circles.map((circle, i) => (
                <React.Fragment key={circle.id}>
                  {i > 0 && <SettingsDivider />}
                  <SettingsToggle
                    icon={circle.emoji || '\u{1F465}'}
                    label={circle.name}
                    hint={circle.muted ? t('cnset_muted', locale) : undefined}
                    value={!circle.muted}
                    onChange={(v) => toggleMute(circle.id, !v)}
                  />
                </React.Fragment>
              ))
            )}
          </SettingsSection>

          <div style={{ fontSize: fs.xs, color: c.textMuted, lineHeight: 1.5, padding: `${sp[3]}px ${sp[1]}px 0` }}>
            {t('cnset_footer', locale)}
          </div>
        </>
      )}
    </div>
  );
}
