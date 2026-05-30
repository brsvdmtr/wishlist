// Route-layer tests for routes/experiments.routes.ts.
//
// Bucketing / env-flag / persistence logic is covered by
// services/experiments.service.test.ts (pure) and
// test/integration/experiments.test.ts (real Postgres). Here we verify the
// HTTP glue: malformed keys are rejected with 400, valid keys return the
// service result as JSON, and the authed user is materialised before the
// service is called.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../security', () => ({
  createRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const service = vi.hoisted(() => ({
  getExperimentAssignment: vi.fn(),
  isValidExperimentKey: vi.fn(),
  isWeightedExperimentKey: vi.fn(() => false),
  readExperimentConfig: vi.fn(() => ({ enabled: true, rolloutPercent: 50 })),
}));
vi.mock('../services/experiments.service', () => service);

import { registerExperimentsRouter } from './experiments.routes';

function makeApp() {
  const deps = { getOrCreateTgUser: vi.fn().mockResolvedValue({ id: 'u1' }) };
  const app = express();
  app.use(express.json());
  // Fake the parent tgRouter auth middleware so the handler can read req.tgUser.
  app.use((req, _res, next) => {
    (req as express.Request & { tgUser?: { id: number; first_name: string } }).tgUser = {
      id: 42,
      first_name: 'Test',
    };
    next();
  });
  app.use(registerExperimentsRouter(deps));
  return { app, deps };
}

describe('experiments router — factory', () => {
  it('returns an Express Router with the route attached', () => {
    const router = registerExperimentsRouter({ getOrCreateTgUser: vi.fn() }) as {
      stack?: unknown[];
    };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /experiments/:key', () => {
  it('400s on a malformed experiment key — no user lookup, no service call', async () => {
    service.isValidExperimentKey.mockReturnValue(false);
    const { app, deps } = makeApp();

    const res = await request(app).get('/experiments/Not_A_Key');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_EXPERIMENT_KEY');
    expect(deps.getOrCreateTgUser).not.toHaveBeenCalled();
    expect(service.getExperimentAssignment).not.toHaveBeenCalled();
  });

  it('400s WRONG_EXPERIMENT_PATH on a weighted key — no user lookup, no binary persist (E17 ledger-poison guard)', async () => {
    service.isValidExperimentKey.mockReturnValue(true);
    service.isWeightedExperimentKey.mockReturnValueOnce(true);
    const { app, deps } = makeApp();

    const res = await request(app).get('/experiments/yearly-price');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('WRONG_EXPERIMENT_PATH');
    expect(deps.getOrCreateTgUser).not.toHaveBeenCalled();
    expect(service.getExperimentAssignment).not.toHaveBeenCalled();
  });

  it('200s with the service assignment for a valid key', async () => {
    service.isValidExperimentKey.mockReturnValue(true);
    service.getExperimentAssignment.mockResolvedValue({
      key: 'new-onboarding',
      variant: 'treatment',
      holdout: false,
      active: true,
    });
    const { app, deps } = makeApp();

    const res = await request(app).get('/experiments/new-onboarding');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      key: 'new-onboarding',
      variant: 'treatment',
      holdout: false,
      active: true,
    });
    expect(deps.getOrCreateTgUser).toHaveBeenCalledOnce();
    expect(service.getExperimentAssignment).toHaveBeenCalledWith('u1', 'new-onboarding', {
      enabled: true,
      rolloutPercent: 50,
    });
  });
});
