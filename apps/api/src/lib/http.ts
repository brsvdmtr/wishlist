// Standard HTTP error responders shared across routes.
//
// `zodError` returns the canonical Wishlist validation-failure shape:
//   400 { error: 'Validation error', issues: error.issues }
// Status code, JSON shape, and field names MUST stay byte-identical — Mini
// App and bot rely on this exact contract.

import type { Response } from 'express';
import type { z } from 'zod';

export function zodError(res: Response, error: z.ZodError) {
  return res.status(400).json({ error: 'Validation error', issues: error.issues });
}
