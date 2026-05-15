// Telegram auth identity service (P5s-2) — extracted from
// apps/api/src/index.ts. Single source of truth for Telegram Mini App
// initData validation, actor-hash derivation, the auth middleware, and
// the User upsert used by every authenticated route handler.
//
// All function bodies are byte-identical to their pre-extraction
// definitions in index.ts; only their location changed. Index.ts
// imports them and continues to wire `requireTelegramAuth` into the
// `tgRouter.use(...)` chain in the same registration order — middleware
// order is preserved verbatim.
//
// `protectTgRoute`, `idem`, `billingIdem`, the `tgRouter` instance, the
// 129 `protectTgRoute(...)` registrations, and the
// `Express.Request.tgUser?` global type augmentation STAY in index.ts.
// `protectTgRoute` closes over `tgRouter` via lexical scope — moving it
// would require either a factory wrapper (added boilerplate, no gain)
// or rewriting all 129 callsites (massive diff). Per audit § 3, keep
// in composition root.
//
// Constants moved with the helpers:
//   INIT_DATA_MAX_AGE_SECONDS — env-derived; default 24 hours; minimum
//     60 seconds enforced by Math.max guard.
//   INIT_DATA_CLOCK_SKEW_SECONDS — fixed 30s tolerance for slightly-
//     ahead client clocks.
//   SYSTEM_ACTOR_HASH — sentinel UUID for system-actor entries
//     (e.g. SYSTEM ReservationEvent rows from auto-release crons).
//
// Consumers (read-only here; no consumer files change in this PR):
//   - index.ts              — middleware wiring + getOrCreateTgUser /
//                             tgActorHash / SYSTEM_ACTOR_HASH passed
//                             through factory deps.
//   - 20 routes/*.ts        — receive getOrCreateTgUser via deps.
//   - 5 routes/*.ts (items, comments, reservations, group-gifts, santa)
//                           — receive tgActorHash via deps.
//   - schedulers/birthday-reminders.ts — receives tgActorHash via deps.
//   - schedulers/reservations.ts       — receives SYSTEM_ACTOR_HASH via
//                                         deps.

import * as crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '@wishlist/db';
import { secureCompare } from '../lib/crypto';
import logger from '../logger';
import { recordIpEvent } from '../security/ipThrottle';

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
};

/**
 * Parse `INIT_DATA_MAX_AGE_SECONDS` env and clamp to a 60-second minimum.
 *
 * Exposed (rather than inlined) so the clamp behaviour is unit-testable
 * without having to re-import the module under a fresh env. NaN, negative,
 * zero, missing → 86_400 default (24h); any value < 60 is bumped to 60.
 */
export function clampMaxAgeSeconds(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '86400', 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 86_400;
  return Math.max(60, value);
}

/** Max age for Telegram initData auth_date (seconds). Default 24 hours; configurable via INIT_DATA_MAX_AGE_SECONDS. */
export const INIT_DATA_MAX_AGE_SECONDS = clampMaxAgeSeconds(process.env.INIT_DATA_MAX_AGE_SECONDS);
/** Allow minor clock skew (seconds). */
export const INIT_DATA_CLOCK_SKEW_SECONDS = 30;

export function validateTelegramInitData(initData: string, botToken: string): { user: TelegramUser } | { reason: string } {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { reason: 'no_hash' };
    params.delete('hash');
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
    if (!secureCompare(expectedHash, hash)) return { reason: 'hash_mismatch' };

    // ── auth_date expiry: reject stale or missing auth_date ───────────────
    const authDateStr = params.get('auth_date');
    if (!authDateStr) return { reason: 'no_auth_date' };
    const authDate = Number(authDateStr);
    if (!Number.isFinite(authDate) || authDate <= 0) return { reason: 'invalid_auth_date' };
    const nowSec = Math.floor(Date.now() / 1000);
    if (authDate > nowSec + INIT_DATA_CLOCK_SKEW_SECONDS) return { reason: 'future_auth_date' };
    if (nowSec - authDate > INIT_DATA_MAX_AGE_SECONDS) return { reason: 'expired' };

    const userStr = params.get('user');
    if (!userStr) return { reason: 'no_user' };
    return { user: JSON.parse(userStr) as TelegramUser };
  } catch {
    return { reason: 'parse_error' };
  }
}

/** Deterministic actor hash for a Telegram user ID. Formatted as UUID (8-4-4-4-12) to pass z.string().uuid(). */
export function tgActorHash(telegramId: number): string {
  const h = crypto.createHash('sha256').update(`tg_actor:${telegramId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const SYSTEM_ACTOR_HASH = '00000000-0000-0000-0000-000000000000';

export function requireTelegramAuth(req: Request, res: Response, next: NextFunction) {
  const botToken = process.env.BOT_TOKEN ?? '';
  if (!botToken) return res.status(500).json({ error: 'Bot not configured' });

  // Development bypass: X-TG-DEV: <telegram_id>
  if (process.env.NODE_ENV !== 'production') {
    const devId = req.get('X-TG-DEV');
    if (devId) {
      req.tgUser = { id: Number(devId) || 1, first_name: 'Dev User' };
      return next();
    }
  }

  const initData = req.get('X-TG-INIT-DATA') ?? '';
  const result = validateTelegramInitData(initData, botToken);
  if ('reason' in result) {
    logger.debug({ reason: result.reason, path: req.path, ip: req.ip, initDataLen: initData.length }, 'auth_rejected');
    // Feed the IP throttle so repeated failures from the same IP get capped
    // before they reach the validator. Skipped internally if the kill switch
    // is off; never throws, so this can't break the auth path.
    recordIpEvent(req, 'auth_rejected');
    return res.status(401).json({ error: 'Invalid Telegram auth' });
  }

  req.tgUser = result.user;
  return next();
}

export async function getOrCreateTgUser(tgUser: TelegramUser) {
  // Capture every Telegram-supplied identity field on every authenticated
  // request. These are non-auth fields (no security decision relies on
  // them) — purely for dashboards, support lookup, and richer god-mode
  // segmentation. lastName/username are nullable; isPremium defaults to
  // false on missing.
  const lastName = tgUser.last_name ?? null;
  const username = tgUser.username ?? null;
  const isPremium = tgUser.is_premium === true;
  return prisma.user.upsert({
    where: { telegramId: String(tgUser.id) },
    update: {
      telegramChatId: String(tgUser.id),
      firstName: tgUser.first_name || null,
      lastName,
      username,
      isPremium,
    },
    create: {
      telegramId: String(tgUser.id),
      telegramChatId: String(tgUser.id),
      firstName: tgUser.first_name || null,
      lastName,
      username,
      isPremium,
    },
  });
}
