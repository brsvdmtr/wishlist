// Unit tests for chargeDeliveredHint — the bounded-retry hint-quota charge the
// bot fires after a hint is DELIVERED. backoffBaseMs:0 keeps the tests instant.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { chargeDeliveredHint } from './hint-charge';
import logger from './logger';

const realFetch = global.fetch;

describe('chargeDeliveredHint', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { global.fetch = realFetch; });

  it('charges in a single attempt when the API responds ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ outcome: 'free_monthly', charged: true }),
    }) as unknown as typeof fetch;

    await chargeDeliveredHint('h1', 'http://api', 'key', 0);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://api/internal/hints/credit',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-INTERNAL-KEY': 'key' }) }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ hintId: 'h1', attempt: 1 }),
      'hint_quota_charge_done',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('retries a non-ok response and succeeds on the second attempt', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ outcome: 'free_monthly', charged: true }) }) as unknown as typeof fetch;

    await chargeDeliveredHint('h2', 'http://api', 'key', 0);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2 }),
      'hint_quota_charge_done',
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('gives up after 3 failed attempts and logs the lost charge (fails open)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    await chargeDeliveredHint('h3', 'http://api', 'key', 0);

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith({ hintId: 'h3' }, 'hint_quota_charge_failed');
  });
});
