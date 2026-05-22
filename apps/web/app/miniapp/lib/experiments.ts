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

export function useExperiment(tgFetch: TgFetch, key: string): ExperimentState {
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

    let cancelled = false;
    setState({ variant: 'control', isReady: false });

    (async () => {
      try {
        const res = await tgFetch(`/tg/experiments/${encodeURIComponent(key)}`, {
          method: 'GET',
          timeoutMs: 5000,
        });
        const variant: ExperimentVariant = res.ok
          ? toVariant(((await res.json()) as { variant?: unknown }).variant)
          : 'control';
        if (!cancelled) {
          variantCache.set(key, variant);
          setState({ variant, isReady: true });
        }
      } catch {
        // Network / timeout / parse failure -> fall back to control, the safe
        // current-behaviour default. Not cached: a later mount may succeed.
        if (!cancelled) setState({ variant: 'control', isReady: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tgFetch, key]);

  return state;
}
