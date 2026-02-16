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

// Avoid interactive prompt on first migrate in a fresh repo/DB.
// You can override by passing `--name your_migration` or setting PRISMA_MIGRATION_NAME.
if (args[0] === 'migrate' && args[1] === 'dev' && !args.includes('--name')) {
  args.push('--name', process.env.PRISMA_MIGRATION_NAME ?? 'init');
}

const result = spawnSync(prismaBin, args, {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
