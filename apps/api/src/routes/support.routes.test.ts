// Deep handler tests for routes/support.routes.ts — god-mode lookup gate.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  supportTicket: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    supportTicket: shared.supportTicket,
    user: shared.user,
  },
}));

import { registerSupportRouter } from './support.routes';

function buildDeps(over: Partial<Parameters<typeof registerSupportRouter>[0]> = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u', telegramId: '42', godMode: false })),
    ...over,
  } as Parameters<typeof registerSupportRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerSupportRouter(deps));
  return app;
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
  delete process.env.GOD_MODE_TELEGRAM_IDS;
});

describe('GET /support/lookup/:ticketCode — god-mode gate', () => {
  it('403 when GOD_MODE_TELEGRAM_IDS env is empty', async () => {
    const res = await request(makeApp()).get('/support/lookup/ABC123');
    expect(res.status).toBe(403);
  });

  it('403 when user telegramId not in GOD_MODE_TELEGRAM_IDS allowlist', async () => {
    process.env.GOD_MODE_TELEGRAM_IDS = '999,1000';
    const res = await request(makeApp()).get('/support/lookup/ABC123');
    expect(res.status).toBe(403);
  });

  it('403 when user is in allowlist but godMode flag is false', async () => {
    process.env.GOD_MODE_TELEGRAM_IDS = '42';
    const deps = buildDeps({
      getOrCreateTgUser: vi.fn(async () => ({ id: 'u', telegramId: '42', godMode: false })),
    });
    const res = await request(makeApp(deps)).get('/support/lookup/ABC123');
    expect(res.status).toBe(403);
  });

  it('queries supportTicket with uppercased ticketCode when authorised', async () => {
    process.env.GOD_MODE_TELEGRAM_IDS = '42';
    const deps = buildDeps({
      getOrCreateTgUser: vi.fn(async () => ({ id: 'u', telegramId: '42', godMode: true })),
    });
    shared.supportTicket.findUnique.mockResolvedValueOnce(null);

    await request(makeApp(deps)).get('/support/lookup/abc123');
    expect(shared.supportTicket.findUnique).toHaveBeenCalled();
    const arg = shared.supportTicket.findUnique.mock.calls[0]![0];
    expect(arg.where.ticketCode).toBe('ABC123');
  });

  it('404 when authorised but ticket not found', async () => {
    process.env.GOD_MODE_TELEGRAM_IDS = '42';
    const deps = buildDeps({
      getOrCreateTgUser: vi.fn(async () => ({ id: 'u', telegramId: '42', godMode: true })),
    });
    shared.supportTicket.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp(deps)).get('/support/lookup/ABC123');
    expect(res.status).toBe(404);
  });
});
