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
  // There are exactly two success exits: the "no service-level changes"
  // branch and the "rebuilt services" branch. Pinning the count at 2 means a
  // future third success path forces this guard to be revisited rather than
  // silently leaving a write unchecked.
  const writes = [...DEPLOY_YML.matchAll(/echo "\$NEW_SHA" > "\$RELEASE_MARKER"/g)];
  assert.strictEqual(
    writes.length, 2,
    `marker must be written exactly once per success branch; found ${writes.length}`,
  );

  // Ordering guard — this is what actually catches a re-introduction of the
  // bug: a marker write that runs before the deploy truly succeeded would
  // advance the baseline on a failed deploy. Each write is pinned to its own
  // branch by the surrounding anchors, not by trusting array position alone.
  const noBuildIdx = DEPLOY_YML.indexOf('up -d --no-build api bot');
  const buildIdx = DEPLOY_YML.indexOf('docker compose -f docker-compose.prod.yml build');
  const healthCheckIdx = DEPLOY_YML.indexOf('curl -sf http://localhost:3001/health');
  assert.notStrictEqual(noBuildIdx, -1, 'no-build recreate line must exist');
  assert.notStrictEqual(buildIdx, -1, 'rebuild `docker compose build` line must exist');
  assert.notStrictEqual(healthCheckIdx, -1, 'health-check line must exist');
  // The no-build branch precedes the rebuild branch in the script.
  const [noBuildWrite, rebuildWrite] = writes;
  // No-build branch: marker write after the recreate AND before the rebuild
  // branch even begins — i.e. genuinely inside the no-build branch.
  assert.ok(
    noBuildWrite.index > noBuildIdx && noBuildWrite.index < buildIdx,
    'no-build branch must write the marker after the recreate, inside its own branch',
  );
  // Rebuild branch: marker write after the image build AND after the health
  // check — i.e. only once the deploy is proven good.
  assert.ok(
    rebuildWrite.index > buildIdx && rebuildWrite.index > healthCheckIdx,
    'rebuild branch must write the marker after the build and the health check',
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
  // full rebuild of every service. Match the empty-baseline → full-rebuild
  // linkage loosely — don't pin the exact shell form (`||`-compound vs.
  // `if; then`), per this file's match-loosely convention above.
  assert.match(
    DEPLOY_YML,
    /\[ -z "\$PREV_SHA" \][\s\S]{0,150}SERVICES="api bot web"/,
    'a missing baseline (empty PREV_SHA) must force SERVICES="api bot web"',
  );
  // A marker SHA that isn't an ancestor of NEW_SHA is equally untrustworthy
  // (e.g. ops/deploy.sh wrote it from a side branch) — it must be discarded
  // so the detection falls through to the full rebuild above.
  assert.match(
    DEPLOY_YML,
    /git merge-base --is-ancestor "\$PREV_SHA" "\$NEW_SHA"/,
    'a non-ancestor marker SHA must be discarded',
  );
});
