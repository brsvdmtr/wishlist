'use client';

import React from 'react';
import { useTheme, AccentSwatch, type ThemeContextValue } from '@wishlist/ui';
import { accentLabels, type Accent, type Theme } from '@wishlist/ui-tokens';

/**
 * v2.1 Settings > Appearance block.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * (SettingsScreen → "Акцентный цвет" + "Фон приложения").
 *
 * Reads/writes theme + accent via `useTheme()`. Accent "blue/pink/green" and
 * theme "black" are PRO-gated — FREE users trying to select them trigger
 * `onUpsell` (passed to `ThemeProvider`). If no backend persistence yet,
 * the `ThemeContextValue.onChange` handler is a no-op; state still updates
 * locally and persists to localStorage.
 */

export interface AppearanceSettingsProps {
  /** Called when a FREE user taps a PRO option — typically opens paywall. */
  onOpenPaywall: () => void;
  /** Whether the current user has PRO. Default `false`. */
  isPro?: boolean;
  /** Optional copy overrides (i18n). */
  labels?: Partial<{
    accentTitle: string;
    themeTitle: string;
    proHint: string;
    themeDarkName: string;
    themeDarkSub: string;
    themeBlackName: string;
    themeBlackSub: string;
  }>;
}

const defaultLabels = {
  accentTitle: 'Акцентный цвет',
  themeTitle: 'Фон приложения',
  proHint: 'PRO',
  themeDarkName: 'Тёмная тема',
  themeDarkSub: 'По умолчанию',
  themeBlackName: 'Чёрная тема',
  themeBlackSub: 'OLED-экономия',
};

export function AppearanceSettings({
  onOpenPaywall,
  isPro = false,
  labels,
}: AppearanceSettingsProps) {
  const ctx = useTheme();
  const L = { ...defaultLabels, ...labels };

  const handleAccent = (a: Accent) => {
    if (!ctx.wouldBeFree({ accent: a }) && !isPro) {
      onOpenPaywall();
      return;
    }
    ctx.setAccent(a);
  };

  const handleTheme = (t: Theme) => {
    if (!ctx.wouldBeFree({ theme: t }) && !isPro) {
      onOpenPaywall();
      return;
    }
    ctx.setTheme(t);
  };

  return (
    <>
      {/* Accent picker */}
      <SectionHdr title={L.accentTitle} lockHint={!isPro ? `🔒 ${L.proHint}` : undefined} />
      <div
        style={{
          margin: '0 16px 18px',
          background: 'var(--wb-card)',
          border: '1px solid var(--wb-border)',
          borderRadius: 20,
          padding: 0,
          overflow: 'hidden',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)' as never,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 10,
            padding: 14,
          }}
        >
          {ctx.available.accents.map((a) => {
            const isActive = ctx.accent === a;
            const locked = !ctx.wouldBeFree({ accent: a }) && !isPro;
            return (
              <div key={a} style={{ position: 'relative' }}>
                <AccentSwatch
                  swatch={{ kind: 'accent', value: a }}
                  active={isActive}
                  locked={locked}
                  label={accentLabels[a]}
                  onClick={() => handleAccent(a)}
                />
                {isActive && (
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      color: '#fff',
                      fontSize: 14,
                      fontWeight: 800,
                      textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                    }}
                  >
                    ✓
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Theme picker */}
      <SectionHdr
        title={L.themeTitle}
        lockHint={!isPro ? `🔒 ${L.proHint} для «${L.themeBlackName}»` : undefined}
      />
      <div
        style={{
          margin: '0 16px 18px',
          background: 'var(--wb-card)',
          border: '1px solid var(--wb-border)',
          borderRadius: 20,
          overflow: 'hidden',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)' as never,
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 14 }}>
          <ThemeCard
            theme="dark"
            name={L.themeDarkName}
            sub={L.themeDarkSub}
            active={ctx.theme === 'dark'}
            locked={false}
            onClick={() => handleTheme('dark')}
          />
          <ThemeCard
            theme="black"
            name={L.themeBlackName}
            sub={L.themeBlackSub}
            active={ctx.theme === 'black'}
            locked={!isPro && ctx.theme !== 'black'}
            onClick={() => handleTheme('black')}
          />
        </div>
      </div>
    </>
  );
}

function SectionHdr({ title, lockHint }: { title: string; lockHint?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        padding: '0 20px',
        marginBottom: 10,
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--wb-text-muted)',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.7px',
        }}
      >
        {title}
      </h2>
      {lockHint && (
        <span style={{ fontSize: 11, color: 'var(--wb-text-muted)', fontWeight: 600 }}>
          {lockHint}
        </span>
      )}
    </div>
  );
}

function ThemeCard({
  theme,
  name,
  sub,
  active,
  locked,
  onClick,
}: {
  theme: Theme;
  name: string;
  sub: string;
  active: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  const bg = theme === 'dark' ? '#0F0F12' : '#000000';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        background: 'var(--wb-surface)',
        border: active ? '2px solid var(--wb-accent)' : '2px solid var(--wb-border)',
        borderRadius: 18,
        padding: 0,
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'all 0.2s ease',
        position: 'relative',
        boxShadow: active ? '0 0 0 3px var(--wb-accent-soft)' : undefined,
        textAlign: 'left' as const,
        fontFamily: 'inherit',
      }}
    >
      {/* Preview */}
      <div
        style={{
          height: 84,
          display: 'flex',
          alignItems: 'flex-end',
          padding: 10,
          gap: 4,
          position: 'relative',
          background: bg,
        }}
      >
        {/* Mesh overlay for dark theme preview */}
        {theme === 'dark' && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'radial-gradient(ellipse 80% 60% at 12% 0%, rgba(139,123,255,0.22), transparent 55%), radial-gradient(ellipse 60% 50% at 100% 20%, rgba(255,120,180,0.10), transparent 55%)',
              opacity: 0.7,
            }}
          />
        )}
        {/* Two preview card slots */}
        <div
          style={{
            height: 36,
            flex: 1,
            borderRadius: 10,
            background: theme === 'black' ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.08)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)' as never,
            border: '1px solid rgba(255,255,255,0.06)',
            position: 'relative',
          }}
        />
        <div
          style={{
            height: 36,
            flex: 1,
            borderRadius: 10,
            background: theme === 'black' ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.08)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)' as never,
            border: '1px solid rgba(255,255,255,0.06)',
            position: 'relative',
          }}
        />
      </div>
      {/* Info */}
      <div
        style={{
          padding: '11px 13px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 650,
              color: 'var(--wb-text)',
              letterSpacing: '-0.012em',
            }}
          >
            {name}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--wb-text-muted)', marginTop: 1 }}>{sub}</div>
        </div>
        {active ? (
          <div style={{ color: 'var(--wb-accent-strong)', fontWeight: 800, fontSize: 14 }}>✓</div>
        ) : locked ? (
          <div style={{ fontSize: 14 }}>🔒</div>
        ) : null}
      </div>
    </button>
  );
}

// Re-export for type-only imports from call-sites.
export type { ThemeContextValue };
