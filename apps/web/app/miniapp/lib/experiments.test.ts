// Tests for useExperiment — the Mini App side of the experiment infra.
//
// Self-check #5: the hook must not break SSR / `next build`. The first
// synchronous render returns the safe `control` default (what the server
// renders); the variant only updates after the client-only effect resolves.
//
// Each test uses a distinct key — the hook keeps a module-level per-session
// variant cache, so reusing a key would leak state between tests.

import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useExperiment } from './experiments';

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

describe('useExperiment', () => {
  it('returns the SSR-safe control default before the request resolves (self-check #5)', () => {
    // tgFetch never settles — mimics the pre-hydration / in-flight state.
    const tgFetch = vi.fn(() => new Promise<Response>(() => {}));
    const { result } = renderHook(() => useExperiment(tgFetch, 'exp-pending'));

    expect(result.current.variant).toBe('control');
    expect(result.current.isReady).toBe(false);
  });

  it('resolves to the server-assigned treatment variant', async () => {
    const tgFetch = vi.fn(async () =>
      okResponse({ key: 'exp-treat', variant: 'treatment', holdout: false, active: true }),
    );
    const { result } = renderHook(() => useExperiment(tgFetch, 'exp-treat'));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.variant).toBe('treatment');
    expect(tgFetch).toHaveBeenCalledWith(
      '/tg/experiments/exp-treat',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('resolves to control for a control assignment', async () => {
    const tgFetch = vi.fn(async () =>
      okResponse({ key: 'exp-ctrl', variant: 'control', holdout: false, active: true }),
    );
    const { result } = renderHook(() => useExperiment(tgFetch, 'exp-ctrl'));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.variant).toBe('control');
  });

  it('falls back to control when the request throws', async () => {
    const tgFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const { result } = renderHook(() => useExperiment(tgFetch, 'exp-error'));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.variant).toBe('control');
  });

  it('falls back to control on a non-OK response', async () => {
    const tgFetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);
    const { result } = renderHook(() => useExperiment(tgFetch, 'exp-500'));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.variant).toBe('control');
  });

  it('treats an unrecognised variant value as control', async () => {
    const tgFetch = vi.fn(async () => okResponse({ variant: 'banana' }));
    const { result } = renderHook(() => useExperiment(tgFetch, 'exp-weird'));

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.variant).toBe('control');
  });

  // ── ready gate (regression test for the 2026-05-27 401-race fix) ─────────
  it('skips the fetch entirely when ready=false', async () => {
    const tgFetch = vi.fn(async () => okResponse({ variant: 'treatment' }));
    const { result } = renderHook(() =>
      useExperiment(tgFetch, 'exp-gated', { ready: false }),
    );

    // Give any racing effect a chance to fire.
    await new Promise((r) => setTimeout(r, 30));

    expect(tgFetch).not.toHaveBeenCalled();
    expect(result.current.isReady).toBe(false);
    expect(result.current.variant).toBe('control');
  });

  it('fires the fetch once ready flips true', async () => {
    const tgFetch = vi.fn(async () => okResponse({ variant: 'treatment' }));
    const { result, rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useExperiment(tgFetch, 'exp-flip', { ready }),
      { initialProps: { ready: false } },
    );

    expect(tgFetch).not.toHaveBeenCalled();

    rerender({ ready: true });

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(tgFetch).toHaveBeenCalledTimes(1);
    expect(result.current.variant).toBe('treatment');
  });

  // ── cache hygiene: a transient failure must NOT pin the user to control
  it('does not cache a non-OK response — a re-mount retries', async () => {
    const tgFetch = vi.fn()
      // First call: 401 (e.g. initData race)
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response)
      // Second call: succeeds with treatment
      .mockResolvedValueOnce(okResponse({ variant: 'treatment' }));

    const first = renderHook(() => useExperiment(tgFetch, 'exp-no-cache-on-fail'));
    await waitFor(() => expect(first.result.current.isReady).toBe(true));
    expect(first.result.current.variant).toBe('control');
    first.unmount();

    const second = renderHook(() => useExperiment(tgFetch, 'exp-no-cache-on-fail'));
    await waitFor(() => expect(second.result.current.variant).toBe('treatment'));
    expect(tgFetch).toHaveBeenCalledTimes(2);
  });
});
