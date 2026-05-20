// ops/deploy-workflow.test.mjs — node:test guards for the CI deploy
// workflow (.github/workflows/deploy.yml). Run via `pnpm test:ops`.
//
// 2026-05-20 regression: the deploy script computed PREV_SHA — the
// changed-service-detection baseline — from `git rev-parse HEAD`. Because
// the script does `git reset --hard origin/main` BEFORE the build, a deploy
// that failed mid-build left HEAD already advanced. The retry then diffed
// HEAD..origin/main == empty, found no changed services, and skipped the
// rebuild while CI still reported success (the web container kept running
// a stale image). The fix sources PREV_SHA from the persistent
// .deploy/last-successful-release marker, written only after a deploy
// fully succeeds. See docs/BUGFIX_LESSONS.md.
//
// These are grep-style guards on the YAML, not behavioural tests — the
// deploy script is inline shell with no local harness. Treat each
// assertion as "if you re-introduce the bug, this goes red."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_YML = readFileSync(
  resolve(__dirname, '../.github/workflows/deploy.yml'),
  'utf8',
);

test('deploy.yml sources PREV_SHA from the last-successful-release marker', () => {
  // The marker is the shared notion of "last known-good release":
  // ops/deploy.sh writes it, ops/rollback.sh reads it. The CI deploy must
  // use the same file rather than keeping its own (mutable) baseline.
  assert.match(
    DEPLOY_YML,
    /last-successful-release/,
    'deploy.yml must reference the .deploy/last-successful-release marker',
  );
  // PREV_SHA must be assigned FROM the marker file. Match loosely — don't
  // pin the exact command (tr/cat/sed), only that the marker feeds PREV_SHA,
  // so a correct refactor doesn't trip a false failure.
  assert.match(
    DEPLOY_YML,
    /PREV_SHA=[^\n]*RELEASE_MARKER/,
    'PREV_SHA must be sourced from the release-marker file',
  );
});

test('deploy.yml writes the release marker only after deploy success, in both branches', () => {
  // NEW_SHA must be persisted to the marker after a deploy succeeds, so the
  // next run (including a retry) has a correct changed-detection baseline.
  // One write in the "no service-level changes" branch, one in the
  // "rebuilt services" branch — both are successful-deploy exits.
  const writes = [...DEPLOY_YML.matchAll(/echo "\$NEW_SHA" > "\$RELEASE_MARKER"/g)];
  assert.ok(
    writes.length >= 2,
    `marker must be written in both success branches; found ${writes.length}`,
  );

  // Ordering guard — this is what actually catches a re-introduction of the
  // bug. A marker write moved ABOVE `docker compose build` / the health
  // check would advance the baseline even when the deploy never succeeded.
  const noBuildIdx = DEPLOY_YML.indexOf('up -d --no-build api bot');
  const healthCheckIdx = DEPLOY_YML.indexOf('curl -sf http://localhost:3001/health');
  assert.notStrictEqual(noBuildIdx, -1, 'no-build recreate line must exist');
  assert.notStrictEqual(healthCheckIdx, -1, 'health-check line must exist');
  // Branch 1 (no service-level changes): marker write after the recreate.
  assert.ok(
    writes[0].index > noBuildIdx,
    'no-build branch must write the marker after recreating containers',
  );
  // Branch 2 (rebuilt): marker write after the health check passes.
  assert.ok(
    writes[writes.length - 1].index > healthCheckIdx,
    'rebuild branch must write the marker after the health check',
  );

  // The rebuild branch must also abort on a stuck migration before writing
  // the marker — the marker means "fully successful deploy", and unfinished
  // migrations are a failed deploy.
  assert.match(
    DEPLOY_YML,
    /FAILED_MIGRATIONS[\s\S]{0,240}exit 1/,
    'an unfinished migration count must exit 1 before the marker is written',
  );
});

test('deploy.yml forces a full rebuild when the marker is missing — no git-HEAD fallback', () => {
  // The marker-missing path must NOT fall back to `git rev-parse HEAD`: on a
  // retry-after-failure HEAD is already advanced, so a HEAD baseline would
  // diff an empty range and skip the rebuild. A missing baseline must instead
  // force a full rebuild — over-rebuilding is always safe.
  assert.ok(
    !DEPLOY_YML.includes('PREV_SHA=$(git rev-parse HEAD)'),
    'deploy.yml must not fall back to git HEAD for the changed-detection baseline',
  );
  // An empty PREV_SHA (no baseline) must short-circuit the detection to a
  // full rebuild of every service.
  assert.match(
    DEPLOY_YML,
    /if \[ -z "\$PREV_SHA" \] \|\|[^\n]*\n\s*SERVICES="api bot web"/,
    'a missing baseline (empty PREV_SHA) must force SERVICES="api bot web"',
  );
});
