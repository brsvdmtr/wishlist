// Unit tests for services/locale.ts — resolveUserFirstName.
//
// Function chain: cached firstName → live Telegram getChat → localised
// api_user_fallback. The locale parameter is mandatory (was '`ru`'-default
// before 2026-05-10 fix); failing to pass a recipient-resolved locale means
// every fallback name comes out in Russian.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  prismaUserUpdate: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: { user: { update: shared.prismaUserUpdate } },
}));

import { resolveUserFirstName } from './locale';

const originalFetch = globalThis.fetch;
const originalToken = process.env.BOT_TOKEN;

beforeEach(() => {
  shared.prismaUserUpdate.mockReset();
  shared.prismaUserUpdate.mockResolvedValue({});
  process.env.BOT_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = originalToken;
});

describe('resolveUserFirstName', () => {
  it('returns the cached firstName without touching Telegram or DB', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const name = await resolveUserFirstName(
      { id: 'u1', firstName: 'Алексей', telegramChatId: '999' },
      'ru',
    );

    expect(name).toBe('Алексей');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(shared.prismaUserUpdate).not.toHaveBeenCalled();
  });

  it('returns localised fallback when no cache, no token, no chat id', async () => {
    delete process.env.BOT_TOKEN;
    const name = await resolveUserFirstName(
      { id: 'u2', firstName: null, telegramChatId: null },
      'en',
    );
    // The api_user_fallback strings should differ per locale; we just assert
    // non-empty + locale-appropriate (not the key itself).
    expect(name).toBeTruthy();
    expect(name).not.toBe('api_user_fallback');
  });

  it('returns locale fallback (NOT Russian) when called with locale=en — regression for 2026-05-10', async () => {
    delete process.env.BOT_TOKEN;
    const ruName = await resolveUserFirstName(
      { id: 'u3', firstName: null, telegramChatId: null },
      'ru',
    );
    const enName = await resolveUserFirstName(
      { id: 'u3', firstName: null, telegramChatId: null },
      'en',
    );
    // Two locales must produce two different fallback strings — otherwise
    // someone re-hardcoded 'ru' inside the helper again.
    expect(ruName).not.toBe(enName);
  });

  it('hits Telegram getChat when firstName missing and caches the result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { first_name: 'Liu Wei' } }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const name = await resolveUserFirstName(
      { id: 'u4', firstName: null, telegramChatId: '12345' },
      'zh-CN',
    );

    expect(name).toBe('Liu Wei');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/bottest-token/getChat');
    expect(options.method).toBe('POST');
    expect(shared.prismaUserUpdate).toHaveBeenCalledWith({
      where: { id: 'u4' },
      data: { firstName: 'Liu Wei' },
    });
  });

  it('falls back to localised string when Telegram getChat returns non-OK', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const name = await resolveUserFirstName(
      { id: 'u5', firstName: null, telegramChatId: '12345' },
      'es',
    );

    expect(name).toBeTruthy();
    expect(name).not.toBe('api_user_fallback');
    expect(shared.prismaUserUpdate).not.toHaveBeenCalled();
  });

  it('falls back when Telegram response has no first_name', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const name = await resolveUserFirstName(
      { id: 'u6', firstName: null, telegramChatId: '12345' },
      'hi',
    );

    expect(name).toBeTruthy();
    expect(shared.prismaUserUpdate).not.toHaveBeenCalled();
  });

  it('swallows fetch network errors and returns fallback (best-effort)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const name = await resolveUserFirstName(
      { id: 'u7', firstName: null, telegramChatId: '12345' },
      'ar',
    );

    expect(name).toBeTruthy();
    expect(name).not.toBe('api_user_fallback');
    expect(shared.prismaUserUpdate).not.toHaveBeenCalled();
  });

  it('swallows DB cache-write errors and still returns the resolved name', async () => {
    // Prisma update is fire-and-forget (.catch(() => {})). A flaky DB must
    // not bubble up — caller gets the name from Telegram regardless.
    shared.prismaUserUpdate.mockRejectedValueOnce(new Error('DB locked'));
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { first_name: 'Maria' } }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const name = await resolveUserFirstName(
      { id: 'u8', firstName: null, telegramChatId: '12345' },
      'es',
    );

    expect(name).toBe('Maria');
  });
});
