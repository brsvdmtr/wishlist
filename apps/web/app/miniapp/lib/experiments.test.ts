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
});
