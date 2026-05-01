// Wraps an async route handler so any rejected promise is forwarded to the
// Express error middleware via next(). Identical behaviour to the previous
// inline definitions in index.ts and health/health.routes.ts.

import type { Request, Response, NextFunction } from 'express';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
