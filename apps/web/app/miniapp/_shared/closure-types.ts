// Shared closure-helper types used across the lazy-loaded cluster Root
// files (SantaRoot, GiftNotesRoot, SettingsRoot, ShowcaseRoot,
// GroupGiftRoot, ProfileRoot). The Roots receive these helpers via a
// loose `ctx` bag forwarded from `MiniAppInner` — pinning the types
// here gives editors / type-checks real signatures without dragging
// the entire MiniApp.tsx surface into each Root's type imports.
//
// Discipline:
// - This is a type-only module. NO runtime exports. Every consumer
//   should `import type { ... } from '../../_shared/closure-types'`
//   so the import erases at compile time and contributes 0 bytes to
//   the bundle.
// - Signatures mirror the actual definitions in
//   `apps/web/app/miniapp/MiniApp.tsx` — if the source signature
//   changes there, update the type here in the same PR.
// - When a helper genuinely lacks a usable type in the source
//   (e.g. an inline anonymous `useState` with no name), leave it as
//   `any` in the consuming Root's ctx rather than inventing a fake
//   type here. The goal is "tighter, not over-tightened".

import type { Dispatch, SetStateAction } from 'react';
import type {
  Screen, Toast, UpsellContext, UpsellSheetState,
} from '../MiniApp';

/**
 * tgFetch — centralised fetch wrapper for the Mini App.
 *
 * - Returns a `Response`; callers are expected to `await r.json()`
 *   themselves (so unions like `Item | { error: string }` stay in
 *   the call-site).
 * - Adds Telegram initData header, idempotency-key plumbing, retries
 *   for safe GET methods, and maintenance / rate-limit interception.
 *
 * Source: `MiniApp.tsx` (`const tgFetch = useCallback(async (path, init?) => ...)`).
 */
export type TgFetch = (
  path: string,
  init?: RequestInit & {
    timeoutMs?: number;
    _retried?: boolean;
    /**
     * Activates idempotency for state-changing methods.
     *   string                → caller-controlled literal key (advanced)
     *   { action }            → managed lifecycle: getOrCreateActionKey + auto-clear
     *                           on success / on KEY_CLEAR_CODES error responses
     * GET/HEAD/OPTIONS ignore this option entirely (no header sent).
     */
    idempotency?: string | { action: string };
  },
) => Promise<Response>;

/**
 * pushToast — append a transient toast notification.
 *
 * Source: `MiniApp.tsx` — `(message: string, kind: Toast['kind']) => void`.
 * `kind` is REQUIRED at the canonical call-site; callers passing
 * `undefined` would surface a TS error (intentional — every toast
 * carries success/error/info/warning semantics for screen-reader
 * priority + colour).
 */
export type PushToast = (message: string, kind: Toast['kind']) => void;

/**
 * trackEvent — fire-and-forget analytics emit.
 *
 * Source: `MiniApp.tsx` — `(event: string, props?: Record<string, unknown>) => void`.
 * Props is intentionally untyped here (every event has its own
 * schema; central typing would couple every Root to PRODUCT_EVENTS).
 */
export type TrackEvent = (event: string, props?: Record<string, unknown>) => void;

/**
 * setScreen — top-level screen-state setter.
 *
 * Source: `MiniApp.tsx` — `useState<Screen>('loading')`. The
 * `Dispatch<SetStateAction<Screen>>` form preserves the `prev =>`
 * functional-update overload that the canonical React `setState`
 * supports.
 */
export type SetScreen = Dispatch<SetStateAction<Screen>>;

/**
 * navBack — async pop the screen stack.
 *
 * Source: `MiniApp.tsx` — `const navBack = useCallback(async () => {...})`.
 * Used by Roots that render their own back chip / leading icon.
 */
export type NavBack = () => Promise<void>;

/**
 * showUpsell — open the PRO upsell sheet with throttling.
 *
 * Source: `MiniApp.tsx` —
 *   `(context: UpsellContext, opts?: { auto?: boolean; wishlistId?: string }) => void`.
 *
 * The `opts.auto` flag participates in 30 s throttle + once-per-session
 * gates so auto-popped sheets don't carpet-bomb the user. Manual
 * (button-tap) callers should omit `opts.auto`.
 */
export type ShowUpsell = (
  context: UpsellContext,
  opts?: { auto?: boolean; wishlistId?: string },
) => void;

/**
 * setUpsellSheet — direct setter for the upsell-sheet state cell.
 *
 * Source: `MiniApp.tsx` — `useState<UpsellSheetState>(null)`. Some
 * Root JSX paths open the sheet directly (e.g. Settings → "Connect
 * PRO" tile) bypassing the `showUpsell` throttle.
 */
export type SetUpsellSheet = Dispatch<SetStateAction<UpsellSheetState>>;

/**
 * LegacyColorBag — the `C` constant forwarded from MiniApp.tsx.
 *
 * Locked-down (vs `Record<string, string>`) so `noUncheckedIndexedAccess`
 * doesn't infer `string | undefined` for every `C.accent` / `C.bg`
 * read — local primitives (`Card`, `Button` wrappers, inline JSX)
 * take strict `string` props.
 *
 * Source: legacy v2.1 token bag in `MiniApp.tsx`; mirrored across
 * every Root file that ingests `C` via ctx.
 */
export type LegacyColorBag = {
  bg: string; surface: string; surfaceHover: string; card: string;
  accent: string; accentSoft: string; accentGlow: string;
  green: string; greenSoft: string; orange: string; orangeSoft: string;
  red: string; redSoft: string;
  text: string; textSec: string; textMuted: string;
  border: string; borderLight: string;
};
