// pino-http request logger middleware. Identical to the previous inline
// pinoHttp({...}) call in index.ts:
//   - skip auto-logging for /api/health and /api/health/deep so the noisy
//     prod healthcheck loop doesn't flood logs;
//   - attach a fresh UUID req.id and surface it as `requestId` on every log
//     line, so a request can be traced across nested log statements.
//   - **redact privacy-sensitive query parameters** before they reach the log
//     transport via the shared `sanitizeUrlForLog` helper (lib/logSafety).
//     /tg/search?q=<user query> would otherwise persist to the rotated
//     daily log file (LOG_FILE_PATH, 14-day retention). Same helper is
//     used by Sentry beforeSend (bootstrap/sentry.ts) and the security
//     event logger (security/securityEvents.ts) — single audit point.

import pinoHttp from 'pino-http';
import type { IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import logger from '../logger';
import { sanitizeUrlForLog } from '../lib/logSafety';

export const requestLogger = pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/api/health/deep',
  },
  customProps: (req) => ({
    requestId: req.id,
  }),
  genReqId: () => crypto.randomUUID(),
  serializers: {
    req: (req: IncomingMessage & { id?: string; remoteAddress?: string; remotePort?: number; headers: Record<string, string | string[] | undefined> }) => ({
      id: req.id,
      method: req.method,
      url: sanitizeUrlForLog(req.url),
      remoteAddress: req.remoteAddress,
      remotePort: req.remotePort,
      headers: req.headers,
    }),
  },
});

