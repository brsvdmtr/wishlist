import pino, { type TransportTargetOptions } from 'pino';

const pretty = process.env.LOG_PRETTY === 'true';
const filePath = process.env.LOG_FILE_PATH;

const targets: TransportTargetOptions[] = [];

if (pretty) {
  targets.push({ target: 'pino-pretty', level: 'trace', options: {} });
} else {
  targets.push({
    target: 'pino/file',
    level: 'trace',
    options: { destination: 1 },
  });
}

// File-based log with daily rotation. Enabled only when LOG_FILE_PATH is set
// (prod). Survives container recreation when the target dir is bind-mounted.
if (filePath) {
  targets.push({
    target: 'pino-roll',
    level: 'trace',
    options: {
      file: filePath,
      frequency: 'daily',
      size: '100m',
      mkdir: true,
      dateFormat: 'yyyy-MM-dd',
      limit: { count: 14 },
    },
  });
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { targets },
  base: {
    service: 'api',
    env: process.env.NODE_ENV || 'development',
    release: process.env.APP_RELEASE || 'unknown',
  },
  redact: {
    paths: ['req.headers["x-tg-init-data"]', 'req.headers["x-admin-key"]', 'req.headers.authorization'],
    censor: '[REDACTED]',
  },
});

export default logger;
