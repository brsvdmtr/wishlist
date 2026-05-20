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
  // PREV_SHA must be read FROM the marker file — not solely from
  // `git rev-parse HEAD`, which advances on a failed deploy.
  assert.match(
    DEPLOY_YML,
    /PREV_SHA=\$\(tr [^\n]*RELEASE_MARKER/,
    'PREV_SHA must be sourced from the release-marker file',
  );
});

test('deploy.yml writes the release marker in both success branches', () => {
  // NEW_SHA must be persisted to the marker after a deploy succeeds, so the
  // next run (including a retry) has a correct changed-detection baseline.
  // One write in the "no service-level changes" branch, one in the
  // "rebuilt services" branch — both are successful-deploy exits.
  const writes = DEPLOY_YML.match(/echo "\$NEW_SHA" > "\$RELEASE_MARKER"/g) || [];
  assert.ok(
    writes.length >= 2,
    `marker must be written in both success branches; found ${writes.length}`,
  );
});

test('deploy.yml keeps git HEAD only as the fallback for PREV_SHA', () => {
  // `git rev-parse HEAD` may remain — but only as the fallback when the
  // marker is missing/invalid (first run after this change). Require the
  // marker-based read to appear before the HEAD fallback in the script.
  const markerIdx = DEPLOY_YML.indexOf('PREV_SHA=$(tr');
  const fallbackIdx = DEPLOY_YML.indexOf('PREV_SHA=$(git rev-parse HEAD)');
  assert.notStrictEqual(markerIdx, -1, 'marker-based PREV_SHA assignment must exist');
  assert.ok(
    fallbackIdx === -1 || markerIdx < fallbackIdx,
    'the marker read must precede the git-HEAD fallback',
  );
});
