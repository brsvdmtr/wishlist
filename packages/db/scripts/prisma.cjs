const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Load DATABASE_URL from repo root .env (preferred), so db commands work from this package.
const repoRootEnvPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(repoRootEnvPath)) {
  require('dotenv').config({ path: repoRootEnvPath });
}

const binBase = path.resolve(__dirname, '../node_modules/.bin/prisma');
const prismaBin = process.platform === 'win32' ? `${binBase}.cmd` : binBase;

// pnpm passes script args with an extra standalone "--". Prisma treats it as
// "end of options", so we strip it.
const args = process.argv.slice(2).filter((arg) => arg !== '--');

const result = spawnSync(prismaBin, args, {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
