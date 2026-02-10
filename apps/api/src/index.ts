import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';

// Prefer app-local .env when running from repo root (pnpm dev),
// but also support running from within apps/api (pnpm -C apps/api start).
const envCandidates = [
  path.resolve(process.cwd(), 'apps/api/.env'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const app = express();

app.use(
  cors({
    origin: process.env.WEB_ORIGIN ?? true,
    credentials: true,
  }),
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${port}`);
});
