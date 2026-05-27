'use client';

// useExperiment — Mini App side of the A/B experiment infrastructure.
//
// The variant is decided server-side (sticky bucket by User.id — see
// apps/api/src/services/experiments.service.ts); this hook just fetches it
// for one experiment key and exposes it to a component.
//
// SSR / build safe: the first render always returns the `control` default
// with `isReady: false`. No window / fetch / storage is touched during render
// or at module load — the request runs in a client-only useEffect — so
// `next build` and server rendering produce the safe control baseline.
//
// Usage:
//   const { variant, isReady } = useExperiment(tgFetch, 'new-onboarding');
//   if (variant === 'treatment') { ... }
// `tgFetch` is the Mini App API client, passed down as a prop exactly like
// for every other endpoint.

import { useEffect, useState } from 'react';

export type ExperimentVariant = 'control' | 'treatment';

export interface ExperimentState {
  variant: ExperimentVariant;
  /** False until the server assignment has been fetched (or has failed). */
  isReady: boolean;
}

type TgFetch = (
  path: string,
  init?: RequestInit & { timeoutMs?: number; idempotency?: string | { action: string } },
) => Promise<Response>;

// Per-session memo. A user's variant for a key never changes within a session,
// so remounting an experiment component must not re-hit the network or risk a
// control -> treatment flicker. Module scope is empty on every fresh SSR
// render, so this never leaks state across requests.
const variantCache = new Map<string, ExperimentVariant>();

function toVariant(value: unknown): ExperimentVariant {
  return value === 'treatment' ? 'treatment' : 'control';
}

export interface UseExperimentOptions {
  /**
   * Gate the fetch until upstream auth context (Telegram initData) is in
   * place. When `false`, the hook returns the SSR-safe control default and
   * skips the network call. Flipping `true` re-runs the effect and fires
   * the request — at which point the X-TG-INIT-DATA header is populated.
   *
   * The race this closes: `useExperiment` is declared at the top of the
   * component, but `initDataRef.current` is assigned inside an effect that
   * runs later in source order. Without this gate the first fetch goes
   * out unauthenticated, the server returns 401, and the user is silently
   * pinned to control for the entire session. Default `true` keeps every
   * existing caller working.
   */
  ready?: boolean;
}

export function useExperiment(
  tgFetch: TgFetch,
  key: string,
  opts?: UseExperimentOptions,
): ExperimentState {
  const ready = opts?.ready ?? true;
  const [state, setState] = useState<ExperimentState>(() => {
    const cached = variantCache.get(key);
    return cached ? { variant: cached, isReady: true } : { variant: 'control', isReady: false };
  });

  useEffect(() => {
    const cached = variantCache.get(key);
    if (cached) {
      setState({ variant: cached, isReady: true });
      return;
    }

    // Gate: caller hasn't signalled readiness yet (typically initData
    // not loaded). Stay at the SSR-safe default; the effect re-fires
    // when `ready` flips true.
    if (!ready) {
      setState({ variant: 'control', isReady: false });
      return;
    }

    let cancelled = false;
    setState({ variant: 'control', isReady: false });

    (async () => {
      try {
        const res = await tgFetch(`/tg/experiments/${encodeURIComponent(key)}`, {
          method: 'GET',
          timeoutMs: 5000,
        });
        if (res.ok) {
          const variant = toVariant(((await res.json()) as { variant?: unknown }).variant);
          if (!cancelled) {
            // Only the successful resolution is cached. A transient !ok
            // (401 from an auth race, 5xx from a flaky upstream) must NOT
            // pin the user to control for the rest of the session — a
            // later mount or remount has to be free to retry.
            variantCache.set(key, variant);
            setState({ variant, isReady: true });
          }
        } else if (!cancelled) {
          setState({ variant: 'control', isReady: true });
        }
      } catch {
        // Network / timeout / parse failure -> fall back to control, the
        // safe current-behaviour default. Not cached: later mounts retry.
        if (!cancelled) setState({ variant: 'control', isReady: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tgFetch, key, ready]);

  return state;
}
