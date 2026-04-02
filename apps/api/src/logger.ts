import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.LOG_PRETTY === 'true' ? { target: 'pino-pretty' } : undefined,
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
