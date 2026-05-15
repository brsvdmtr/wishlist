// Handler-level tests for routes/analytics.routes.ts via supertest.
// Pattern proof for the remaining 23 route files — each handler can be
// exercised by:
//   1. mocking Prisma at the module boundary,
//   2. mocking req.tgUser via a tiny middleware,
//   3. mounting the router on a fresh Express app,
//   4. firing requests with supertest.
//
// Body validation, the first-touch atomic UPDATE … WHERE source IS NULL
// contract, and the sanitizer ASCII / 64-char truncation are pinned here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  updateMany: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: { userProfile: { updateMany: shared.updateMany } },
}));

import { registerAnalyticsRouter } from './analytics.routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  // Mock auth middleware — every test acts as user id=42.
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerAnalyticsRouter({
    getOrCreateTgUser: async () => ({ id: 'u-test' }),
  }));
  return app;
}

beforeEach(() => {
  shared.updateMany.mockReset();
  shared.updateMany.mockResolvedValue({ count: 1 });
});

describe('POST /analytics/attribution', () => {
  it('returns 400 when source is missing', async () => {
    const res = await request(makeApp()).post('/analytics/attribution').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source/);
    expect(shared.updateMany).not.toHaveBeenCalled();
  });

  it('returns 400 when source is an empty string', async () => {
    const res = await request(makeApp()).post('/analytics/attribution').send({ source: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when source is a non-string type', async () => {
    const res = await request(makeApp()).post('/analytics/attribution').send({ source: 12345 });
    expect(res.status).toBe(400);
  });

  it('first-touch attribution succeeds → returns attributed=true', async () => {
    shared.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await request(makeApp())
      .post('/analytics/attribution')
      .send({ source: 'telegram', medium: 'organic', campaign: 'launch', ref: 'friend' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attributed: true });
  });

  it('subsequent attribution returns attributed=false (atomic NULL guard)', async () => {
    shared.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await request(makeApp()).post('/analytics/attribution').send({ source: 'telegram' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attributed: false });
  });

  it('sends a where clause that guards firstAcquisitionSource IS NULL (atomic first-touch)', async () => {
    await request(makeApp()).post('/analytics/attribution').send({ source: 'x' });
    expect(shared.updateMany).toHaveBeenCalledOnce();
    const arg = shared.updateMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ userId: 'u-test', firstAcquisitionSource: null });
  });

  it('sanitises source: strips non-alphanumeric, replaces with underscore', async () => {
    await request(makeApp())
      .post('/analytics/attribution')
      .send({ source: 'hello world!@#$%' });
    const data = shared.updateMany.mock.calls[0]![0].data;
    expect(data.firstAcquisitionSource).toMatch(/^[a-z0-9_-]+$/i);
  });

  it('truncates source to 64 chars', async () => {
    await request(makeApp())
      .post('/analytics/attribution')
      .send({ source: 'x'.repeat(200) });
    const data = shared.updateMany.mock.calls[0]![0].data;
    expect(data.firstAcquisitionSource.length).toBe(64);
  });

  it('passes through medium / campaign / ref with same sanitisation', async () => {
    await request(makeApp())
      .post('/analytics/attribution')
      .send({ source: 'x', medium: 'm-ed_ium', campaign: 'cmp1', ref: 'r/e/f' });
    const data = shared.updateMany.mock.calls[0]![0].data;
    expect(data.firstAcquisitionMedium).toBe('m-ed_ium');
    expect(data.firstAcquisitionCampaign).toBe('cmp1');
    expect(data.firstAcquisitionRef).toBe('r_e_f');
  });

  it('records firstAcquisitionAt as a Date', async () => {
    await request(makeApp()).post('/analytics/attribution').send({ source: 'x' });
    const data = shared.updateMany.mock.calls[0]![0].data;
    expect(data.firstAcquisitionAt).toBeInstanceOf(Date);
  });
});
