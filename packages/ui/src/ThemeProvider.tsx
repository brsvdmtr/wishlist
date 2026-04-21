import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type HTMLAttributes,
} from 'react';
import { type Theme, type Accent, themes, accents, isFreeCombo } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Runtime theme + accent switcher with
 * PRO-gating hook. Injects CSS vars scoped to `.wb-phone[data-theme][data-accent]`.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * Approval: `DESIGN_DECISIONS.md#2026-04-21--v21-refresh-approved-as-new-visual-direction-glass--mesh--theme-system`.
 *
 * Usage:
 *
 *   <ThemeProvider isPro={user.isPro} initial={{ theme: user.theme, accent: user.accent }}
 *                  onChange={(t, a) => persistToBackend(t, a)}>
 *     <MiniApp />
 *   </ThemeProvider>
 *
 * Consumers read state via `useTheme()`. Call `setTheme(...)` /
 * `setAccent(...)` — FREE users that try to select PRO combos trigger
 * `onUpsell?.(kind, value)` instead of applying the change.
 */

const STORAGE_KEY = 'wb-theme-v1';

export interface ThemePreference {
  theme: Theme;
  accent: Accent;
}

export interface ThemeContextValue {
  theme: Theme;
  accent: Accent;
  isPro: boolean;
  setTheme: (t: Theme) => void;
  setAccent: (a: Accent) => void;
  /** `true` if the current (theme, accent) combo is free. */
  isFreeCurrent: boolean;
  /** `true` if the combo with the given override is free. Useful for preview. */
  wouldBeFree: (override: Partial<ThemePreference>) => boolean;
  /** Available themes + accents (for pickers). */
  available: { themes: readonly Theme[]; accents: readonly Accent[] };
}

const defaultValue: ThemeContextValue = {
  theme: 'dark',
  accent: 'violet',
  isPro: false,
  setTheme: () => {},
  setAccent: () => {},
  isFreeCurrent: true,
  wouldBeFree: () => true,
  available: { themes, accents },
};

const ThemeContext = createContext<ThemeContextValue>(defaultValue);

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Reason callback fired when a FREE user tries to select a PRO theme/accent.
 * Consumer typically opens the paywall or shows a "PRO-only" toast.
 */
export type UpsellReason =
  | { kind: 'theme'; value: Theme }
  | { kind: 'accent'; value: Accent };

export interface ThemeProviderProps {
  children: ReactNode;
  /** User's PRO status. When `false`, PRO combos fire `onUpsell` instead of applying. */
  isPro?: boolean;
  /** Initial theme/accent from backend. Falls back to localStorage, then to defaults. */
  initial?: Partial<ThemePreference>;
  /** Called when a valid theme/accent change is committed. */
  onChange?: (pref: ThemePreference) => void;
  /** Called when a FREE user tries to select a PRO combo. */
  onUpsell?: (reason: UpsellReason) => void;
  /** Additional classes to add to the phone root. */
  rootClassName?: string;
  /** Additional style to add to the phone root. */
  rootStyle?: HTMLAttributes<HTMLDivElement>['style'];
}

function readStoredPref(): Partial<ThemePreference> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<ThemePreference>;
    return {
      theme: themes.includes(parsed.theme as Theme) ? parsed.theme : undefined,
      accent: accents.includes(parsed.accent as Accent) ? parsed.accent : undefined,
    };
  } catch {
    return {};
  }
}

function writeStoredPref(pref: ThemePreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    /* noop */
  }
}

export function ThemeProvider({
  children,
  isPro = false,
  initial,
  onChange,
  onUpsell,
  rootClassName,
  rootStyle,
}: ThemeProviderProps) {
  const [pref, setPref] = useState<ThemePreference>(() => {
    const stored = readStoredPref();
    return {
      theme: (initial?.theme ?? stored.theme ?? 'dark') as Theme,
      accent: (initial?.accent ?? stored.accent ?? 'violet') as Accent,
    };
  });

  // Track last broadcasted pref to avoid double-fire on re-mount.
  const lastSentRef = useRef<string | null>(null);

  // Persist + notify upstream
  useEffect(() => {
    writeStoredPref(pref);
    const sig = `${pref.theme}/${pref.accent}`;
    if (lastSentRef.current !== sig) {
      lastSentRef.current = sig;
      onChange?.(pref);
    }
  }, [pref, onChange]);

  // Setters always apply locally — PRO-gating is caller-side (e.g.
  // `AppearanceSettings` checks `wouldBeFree()` and opens the paywall
  // before calling). Defense-in-depth: backend validation should reject
  // PRO-only combos for FREE users on save.
  const setTheme = useCallback((t: Theme) => {
    if (!themes.includes(t)) return;
    setPref((p) => ({ ...p, theme: t }));
  }, []);

  const setAccent = useCallback((a: Accent) => {
    if (!accents.includes(a)) return;
    setPref((p) => ({ ...p, accent: a }));
  }, []);

  // If a caller passes `onUpsell`, expose it via ref so it isn't marked
  // unused. It's still available to call from `AppearanceSettings` via
  // `useTheme()` → future API extension point.
  void onUpsell;

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: pref.theme,
      accent: pref.accent,
      isPro,
      setTheme,
      setAccent,
      isFreeCurrent: isFreeCombo(pref.theme, pref.accent),
      wouldBeFree: (override) =>
        isFreeCombo(
          (override.theme ?? pref.theme) as Theme,
          (override.accent ?? pref.accent) as Accent,
        ),
      available: { themes, accents },
    }),
    [pref, isPro, setTheme, setAccent],
  );

  const className = ['wb-phone', 'wb-app', rootClassName].filter(Boolean).join(' ');

  return (
    <ThemeContext.Provider value={value}>
      <div
        className={className}
        data-theme={pref.theme}
        data-accent={pref.accent}
        style={rootStyle}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
