// Unit tests for services/lifecycle.ts createSendLifecycleDM factory.
//
// The function is a thin HTTP wrapper over Telegram bot sendMessage with
// outcome classification (delivered / bot_blocked / chat_not_found /
// permanent_failure / transient_failure). Tests cover every branch of
// that classifier — these outcomes drive scheduler retry behaviour, so a
// regression here cascades into wave/touch delivery correctness.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { createSendLifecycleDM } from './lifecycle';

const originalFetch = globalThis.fetch;

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function mockFetchResponse(payload: { ok: boolean; error_code?: number; description?: string }, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => payload,
  });
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createSendLifecycleDM — guard rails', () => {
  it('returns permanent_failure when botToken is empty', async () => {
    const send = createSendLifecycleDM({ botToken: '', logger: fakeLogger() });
    expect(await send('123', 'hi', 'en')).toBe('permanent_failure');
  });

  it('returns permanent_failure when chatId is empty', async () => {
    const send = createSendLifecycleDM({ botToken: 'token', logger: fakeLogger() });
    expect(await send('', 'hi', 'en')).toBe('permanent_failure');
  });
});

describe('createSendLifecycleDM — success path', () => {
  it('returns delivered when Telegram responds ok:true', async () => {
    globalThis.fetch = mockFetchResponse({ ok: true }) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 'token', logger: fakeLogger() });
    expect(await send('chat1', 'hi', 'en')).toBe('delivered');
  });

  it('hits the correct Telegram endpoint with chat_id and HTML parse_mode', async () => {
    const fetchSpy = mockFetchResponse({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 'TOKEN', logger: fakeLogger() });

    await send('chat42', 'Привет', 'ru');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe('chat42');
    expect(body.text).toBe('Привет');
    expect(body.parse_mode).toBe('HTML');
    expect(body.reply_markup).toBeUndefined(); // no webAppUrl => no inline keyboard
  });

  it('attaches localised inline-keyboard CTA when webAppUrl is provided', async () => {
    const fetchSpy = mockFetchResponse({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 'T', logger: fakeLogger() });

    await send('c', 'msg', 'ru', 'https://example.com/miniapp');

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.reply_markup.inline_keyboard).toHaveLength(1);
    expect(body.reply_markup.inline_keyboard[0]).toHaveLength(1);
    expect(body.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://example.com/miniapp');
    expect(body.reply_markup.inline_keyboard[0][0].text).toBeTruthy();
  });

  it('localises the button text by locale (regression for 2026-05-10 hardcoded-ru bug)', async () => {
    const fetchSpy = mockFetchResponse({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 'T', logger: fakeLogger() });

    await send('c', 'm', 'ru', 'https://app');
    await send('c', 'm', 'en', 'https://app');
    await send('c', 'm', 'ar', 'https://app');

    const ruText = JSON.parse(fetchSpy.mock.calls[0]![1].body).reply_markup.inline_keyboard[0][0].text;
    const enText = JSON.parse(fetchSpy.mock.calls[1]![1].body).reply_markup.inline_keyboard[0][0].text;
    const arText = JSON.parse(fetchSpy.mock.calls[2]![1].body).reply_markup.inline_keyboard[0][0].text;

    // Three locales must produce three different button strings — if any
    // pair matches, someone hardcoded the button text again.
    expect(new Set([ruText, enText, arText]).size).toBe(3);
  });
});

describe('createSendLifecycleDM — Telegram error classification', () => {
  it('403 → bot_blocked (permanent)', async () => {
    globalThis.fetch = mockFetchResponse({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger: fakeLogger() });
    expect(await send('c', 'h', 'en')).toBe('bot_blocked');
  });

  it('400 + "chat not found" → chat_not_found', async () => {
    globalThis.fetch = mockFetchResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger: fakeLogger() });
    expect(await send('c', 'h', 'en')).toBe('chat_not_found');
  });

  it('400 + "user is deactivated" → chat_not_found', async () => {
    globalThis.fetch = mockFetchResponse({ ok: false, error_code: 400, description: 'Bad Request: user is deactivated' }, 400) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger: fakeLogger() });
    expect(await send('c', 'h', 'en')).toBe('chat_not_found');
  });

  it('400 with other description → permanent_failure', async () => {
    globalThis.fetch = mockFetchResponse({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }, 400) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger: fakeLogger() });
    expect(await send('c', 'h', 'en')).toBe('permanent_failure');
  });

  it('429 → transient_failure (retry next cycle)', async () => {
    globalThis.fetch = mockFetchResponse({ ok: false, error_code: 429, description: 'Too Many Requests' }, 429) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger: fakeLogger() });
    expect(await send('c', 'h', 'en')).toBe('transient_failure');
  });

  it('500 → transient_failure', async () => {
    globalThis.fetch = mockFetchResponse({ ok: false, error_code: 500, description: 'Telegram internal' }, 500) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger: fakeLogger() });
    expect(await send('c', 'h', 'en')).toBe('transient_failure');
  });

  it('502 → transient_failure', async () => {
    globalThis.fetch = mockFetchResponse({ ok: false, error_code: 502, description: 'gateway' }, 502) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger: fakeLogger() });
    expect(await send('c', 'h', 'en')).toBe('transient_failure');
  });

  it('logs the outcome at warn level with chatIdTail (PII-minimal)', async () => {
    const logger = fakeLogger();
    globalThis.fetch = mockFetchResponse({ ok: false, error_code: 403 }, 403) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger });

    await send('long-chat-id-7890', 'h', 'en');

    expect(logger.warn).toHaveBeenCalled();
    const args = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[0]).toMatchObject({ chatIdTail: '7890', outcome: 'bot_blocked' });
  });
});

describe('createSendLifecycleDM — network failure', () => {
  it('fetch rejection → transient_failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger: fakeLogger() });
    expect(await send('c', 'h', 'en')).toBe('transient_failure');
  });

  it('logs network failure at warn level with err message', async () => {
    const logger = fakeLogger();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('socket hang up')) as unknown as typeof fetch;
    const send = createSendLifecycleDM({ botToken: 't', logger });

    await send('chat99', 'h', 'en');

    const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => c[0]?.err === 'socket hang up')).toBe(true);
  });
});
