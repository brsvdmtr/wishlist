import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

// Main-thread logger — no transport worker, no pino-roll.
//
// 2026-05-02: pino-roll's transport worker stalled after the daily-rollover
// at midnight UTC, which silenced both stdout AND the file (the worker fans
// out to all targets). Bot heartbeat stayed alive in DB while every log line
// was lost, blinding all troubleshooting on the very network incident we
// were trying to diagnose. Switching to pino.multistream keeps both writers
// in the main process — every line is flushed synchronously, no worker can
// die without the bot itself dying.
//
// Rotation is intentionally dropped in-process. The bind-mounted file grows
// linearly (~50 KB/day at current traffic). Host-side `logrotate` covers
// long-term growth if/when we wire it up. Reliability > rotation.

const pretty = process.env.LOG_PRETTY === 'true';
const filePath = process.env.LOG_FILE_PATH;

const baseOpts = {
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'bot',
    env: process.env.NODE_ENV || 'development',
    release: process.env.APP_RELEASE || 'unknown',
  },
};

let logger: pino.Logger;

if (pretty) {
  // Dev only — pretty printer goes through a transport worker, but dev is
  // not a reliability-critical environment.
  logger = pino({ ...baseOpts, transport: { target: 'pino-pretty', options: {} } });
} else {
  const streams: pino.StreamEntry[] = [
    { stream: process.stdout },
  ];

  if (filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const fileStream = fs.createWriteStream(filePath, { flags: 'a' });
      fileStream.on('error', (err) => {
        // File-side errors must NOT take down stdout. Log the failure once
        // through stdout directly and let the caller continue.
        process.stdout.write(
          JSON.stringify({
            level: 50,
            time: Date.now(),
            service: 'bot',
            msg: 'log file stream error',
            err: err.message,
          }) + '\n',
        );
      });
      streams.push({ stream: fileStream });
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          level: 50,
          time: Date.now(),
          service: 'bot',
          msg: 'log file open failed; continuing with stdout only',
          err: err instanceof Error ? err.message : String(err),
          filePath,
        }) + '\n',
      );
    }
  }

  logger = pino(baseOpts, pino.multistream(streams));
}

export default logger;
