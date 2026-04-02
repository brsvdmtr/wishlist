import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.LOG_PRETTY === 'true' ? { target: 'pino-pretty' } : undefined,
  base: {
    service: 'bot',
    env: process.env.NODE_ENV || 'development',
    release: process.env.APP_RELEASE || 'unknown',
  },
});

export default logger;
