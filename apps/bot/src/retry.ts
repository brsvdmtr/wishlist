// Telegram API retry helpers (extracted from apps/bot/src/index.ts for
// unit testability). The bot still owns the imperative orchestration loop
// — this module owns the pure decision + log-shape pieces.
//
// Why this lives here: incident 2026-04-26 14:30–14:37 UTC saw four
// process restarts back-to-back during a deploy because every ETIMEDOUT
// was tagged transient:false, exhausting Telegraf's outer restart budget
// instead of the in-process retry budget. `isTransientError` is the
// classifier that decides "retry locally" vs "let it bubble." A bug
// here cascades to bot crashloops in the same RKN-IPv4 outage shape
// the helper exists to handle.

import type { Logger } from 'pino';

/** Transient error code allowlist (regex-anchored, case-sensitive). */
export const TRANSIENT_CODE_RE = /^E(TIMEDOUT|CONNRESET|CONNREFUSED|HOSTUNREACH|NETUNREACH|NOTFOUND|AI_AGAIN|PIPE)$/;

/**
 * Returns true if the error looks transient (network / 5xx). Used by the
 * bot's retry loop to decide between "retry locally" and "let the outer
 * Telegraf restart handler take over."
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  const msg = err.message;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const code = e.code;
  const errno = e.errno;
  if (typeof code === 'string' && TRANSIENT_CODE_RE.test(code)) return true;
  if (typeof errno === 'string' && TRANSIENT_CODE_RE.test(errno)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|network/i.test(msg)) return true;
  if (typeof code === 'number' && code >= 500) return true;
  return false;
}

/**
 * Redact the bot token from any string. The token is the only secret the
 * bot module knows; stripping it from log lines keeps it out of error
 * messages that leak via stdout / log files.
 */
export function redactToken(value: string, token: string | undefined): string {
  return token ? value.split(token).join('[REDACTED]') : value;
}

/**
 * Extract a structured summary of a Telegram API error suitable for
 * structured logging. Always returns a `{ errCode, errMessage }` pair —
 * never throws.
 */
export function telegramErrorSummary(err: unknown, token: string | undefined): { errCode: string | null; errMessage: string } {
  if (!(err instanceof Error)) return { errCode: null, errMessage: redactToken(String(err), token) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const code = e.code;
  const errno = e.errno;
  const errCode =
    typeof code === 'string' && code
      ? code
      : typeof errno === 'string' && errno
        ? errno
        : typeof code === 'number'
          ? String(code)
          : err.name && err.name !== 'Error'
            ? err.name
            : null;
  return { errCode, errMessage: redactToken(err.message, token) };
}

/**
 * Build a retryTgApi closure with the given logger + token. Returns a
 * function that retries transient errors with exponential backoff
 * (1s / 2s / 4s) up to `maxAttempts` (default 3). `bestEffort:true`
 * downgrades the final-failure log level from error→info — used for
 * cosmetic startup calls where a TG-side timeout doesn't impact users.
 */
export type RetryOpts = { maxAttempts?: number; bestEffort?: boolean } | number;

export function createRetryTgApi(deps: { logger: Logger; token: string | undefined }) {
  const { logger, token } = deps;
  return async function retryTgApi<T>(
    label: string,
    fn: () => Promise<T>,
    opts: RetryOpts = {},
  ): Promise<T | undefined> {
    const { maxAttempts = 3, bestEffort = false } = typeof opts === 'number'
      ? { maxAttempts: opts, bestEffort: false }
      : opts;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const transient = isTransientError(err);
        const errSummary = telegramErrorSummary(err, token);
        if (!transient || attempt === maxAttempts) {
          if (bestEffort && transient) {
            logger.info({ ...errSummary, label, attempt, bestEffort }, 'telegram API call failed (best-effort, ignored)');
          } else {
            logger.error({ err, ...errSummary, label, attempt, transient, bestEffort }, 'telegram API call failed');
          }
          return undefined;
        }
        const delay = 1000 * Math.pow(2, attempt - 1);
        const retryMeta = { ...errSummary, label, attempt, nextRetryMs: delay, transient, bestEffort };
        if (bestEffort) {
          logger.info(retryMeta, 'telegram API call failed, retrying');
        } else {
          logger.warn(retryMeta, 'telegram API call failed, retrying');
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return undefined;
  };
}
