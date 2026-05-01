// dotenv loader — must run BEFORE any module reads process.env at import time
// (notably ./logger and ./middleware/cors). Side-effect-only module.
//
// Resolution order matches the previous inline behaviour in index.ts:
//   1. apps/api/.env (when running from apps/api with `pnpm -C apps/api dev`)
//   2. <repo-root>/.env  (when running from the workspace root with `pnpm dev`)
// First match wins; subsequent candidates are ignored. dotenv never overrides
// already-set process.env entries, so shell/Docker env vars take precedence in
// production exactly like before.
//
// Path math (kept identical to the old in-place version, with one extra `..`
// to account for the new file living one directory deeper than index.ts):
//   src layout:   apps/api/src/bootstrap/env.ts
//   dist layout:  apps/api/dist/bootstrap/env.js
//   __dirname:    apps/api/{src|dist}/bootstrap
//   '../../.env'        -> apps/api/.env
//   '../../../../.env'  -> repo-root/.env

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

const envCandidates = [
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../..', '.env'),
];

for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}
