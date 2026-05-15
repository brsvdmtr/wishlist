// Deep handler tests for routes/profiles.routes.ts — subscribe/unsubscribe.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  userProfile: { findFirst: vi.fn() },
  profileSubscription: { upsert: vi.fn(), delete: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    userProfile: shared.userProfile,
    profileSubscription: shared.profileSubscription,
  },
}));

import { registerProfilesRouter } from './profiles.routes';

function buildDeps() {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-subscriber' })),
  } as Parameters<typeof registerProfilesRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerProfilesRouter(deps));
  return app;
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
});

describe('POST /profiles/:username/subscribe', () => {
  it('400 when username param is empty/whitespace', async () => {
    const res = await request(makeApp()).post('/profiles/%20/subscribe').send({});
    expect([400, 404]).toContain(res.status);
  });

  it('404 when profile not found', async () => {
    shared.userProfile.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp()).post('/profiles/missing/subscribe').send({});
    expect(res.status).toBe(404);
  });

  it('400 when trying to subscribe to own profile', async () => {
    shared.userProfile.findFirst.mockResolvedValueOnce({
      userId: 'u-subscriber', profileVisibility: 'EVERYONE', subscribePolicy: 'EVERYONE',
    });
    const res = await request(makeApp()).post('/profiles/me/subscribe').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own profile/i);
  });

  it('404 when profile visibility is NOBODY (privacy-respecting)', async () => {
    shared.userProfile.findFirst.mockResolvedValueOnce({
      userId: 'u-other', profileVisibility: 'NOBODY', subscribePolicy: 'EVERYONE',
    });
    const res = await request(makeApp()).post('/profiles/private/subscribe').send({});
    expect(res.status).toBe(404);
  });

  it('403 with subscriptions_closed when subscribePolicy is NOBODY', async () => {
    shared.userProfile.findFirst.mockResolvedValueOnce({
      userId: 'u-other', profileVisibility: 'EVERYONE', subscribePolicy: 'NOBODY',
    });
    const res = await request(makeApp()).post('/profiles/closed/subscribe').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('subscriptions_closed');
  });

  it('200 with subscription object on success', async () => {
    shared.userProfile.findFirst.mockResolvedValueOnce({
      userId: 'u-other', profileVisibility: 'EVERYONE', subscribePolicy: 'EVERYONE',
    });
    shared.profileSubscription.upsert.mockResolvedValueOnce({
      id: 'sub1', targetUserId: 'u-other', createdAt: new Date('2026-01-01'),
    });

    const res = await request(makeApp()).post('/profiles/anna/subscribe').send({});
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ id: 'sub1', targetUserId: 'u-other' });
  });

  it('username lookup is case-insensitive', async () => {
    shared.userProfile.findFirst.mockResolvedValueOnce(null);
    await request(makeApp()).post('/profiles/Anna/subscribe').send({});
    const arg = shared.userProfile.findFirst.mock.calls[0]![0];
    expect(arg.where.username.mode).toBe('insensitive');
  });
});
