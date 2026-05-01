// pino-http request logger middleware. Identical to the previous inline
// pinoHttp({...}) call in index.ts:
//   - skip auto-logging for /api/health and /api/health/deep so the noisy
//     prod healthcheck loop doesn't flood logs;
//   - attach a fresh UUID req.id and surface it as `requestId` on every log
//     line, so a request can be traced across nested log statements.

import pinoHttp from 'pino-http';
import crypto from 'node:crypto';
import logger from '../logger';

export const requestLogger = pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/api/health' || req.url === '/api/health/deep',
  },
  customProps: (req) => ({
    requestId: req.id,
  }),
  genReqId: () => crypto.randomUUID(),
});
