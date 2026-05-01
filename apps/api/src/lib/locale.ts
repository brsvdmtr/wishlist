// Detect the effective Locale for a request from the Telegram user's
// language_code header. The req.tgUser augmentation on Express.Request lives
// in apps/api/src/index.ts (`declare global { namespace Express { ... } }`)
// and is project-wide via tsconfig include glob, so referencing req.tgUser
// from this module type-checks without an extra import.

import type { Request } from 'express';
import { detectLocale, type Locale } from '@wishlist/shared';

export function getRequestLocale(req: Request): Locale {
  const langCode = req.tgUser?.language_code;
  return detectLocale(langCode);
}
