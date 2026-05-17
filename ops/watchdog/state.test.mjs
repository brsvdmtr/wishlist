// ops/watchdog/state.test.mjs — node:test for the pure state machine and
// the persistence layer. Run with:
//
//   node --test ops/watchdog/state.test.mjs
//
// or via the root package script: `pnpm test:ops`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PROMOTE_THRESHOLD,
  RECOVERY_THRESHOLD,
  ZERO_EXPOSURE_MIN_AGE_MS,
  defaultState,
  mergeWithDefaults,
  loadState,
  saveStateAtomic,
  transitionOnDown,
  transitionOnHealthy,
  evaluateZeroExposureAlerts,
  markZeroExposureAlerted,
} from './state.mjs';

const NOW = '2026-05-17T02:25:00.000Z';
const LATER = '2026-05-17T02:30:00.000Z';
const MUCH_LATER = '2026-05-17T02:50:00.000Z';

function tmpStateFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-state-')), name);
}

// ─── defaultState / mergeWithDefaults ────────────────────────────────────────

test('defaultState has the expected shape', () => {
  const s = defaultState();
  assert.equal(s.wasDown, false);
  assert.equal(s.consecutiveDownChecks, 0);
  assert.equal(s.consecutiveHealthyChecks, 0);
  assert.equal(s.firstDownSince, null);
  assert.equal(s.downSince, null);
  assert.equal(s.botWasStale, false);
  assert.equal(s.incidentId, null);
  assert.deepEqual(s.zeroExposureAlertedIncidentIds, []);
});

test('mergeWithDefaults fills missing fields without dropping legacy ones', () => {
  const legacy = { wasDown: true, downSince: '2026-01-01T00:00:00.000Z', legacyField: 'keep me' };
  const merged = mergeWithDefaults(legacy);
  assert.equal(merged.wasDown, true);
  assert.equal(merged.downSince, '2026-01-01T00:00:00.000Z');
  assert.equal(merged.consecutiveDownChecks, 0);
  assert.deepEqual(merged.zeroExposureAlertedIncidentIds, []);
  assert.equal(merged.legacyField, 'keep me');
});

test('mergeWithDefaults coerces wrong types back to safe defaults', () => {
  const bad = {
    consecutiveDownChecks: null,
    consecutiveHealthyChecks: 'three',
    zeroExposureAlertedIncidentIds: 'not-an-array',
    wasDown: 1,
    botWasStale: undefined,
  };
  const merged = mergeWithDefaults(bad);
  assert.equal(merged.consecutiveDownChecks, 0);
  assert.equal(merged.consecutiveHealthyChecks, 0);
  assert.deepEqual(merged.zeroExposureAlertedIncidentIds, []);
  assert.equal(merged.wasDown, false);
  assert.equal(merged.botWasStale, false);
});

test('mergeWithDefaults rejects non-object inputs', () => {
  assert.deepEqual(mergeWithDefaults(null), defaultState());
  assert.deepEqual(mergeWithDefaults('string'), defaultState());
  assert.deepEqual(mergeWithDefaults([1, 2, 3]), defaultState());
});

// ─── transitionOnDown ────────────────────────────────────────────────────────

test('first DOWN tick increments counter, does not promote, sets firstDownSince', () => {
  const r = transitionOnDown(defaultState(), NOW);
  assert.equal(r.promote, false);
  assert.equal(r.alreadyDown, false);
  assert.equal(r.state.consecutiveDownChecks, 1);
  assert.equal(r.state.firstDownSince, NOW);
  assert.equal(r.state.wasDown, false);
  assert.match(r.log, /waiting for confirmation/);
});

test('second consecutive DOWN tick promotes to incident', () => {
  let s = defaultState();
  s = transitionOnDown(s, NOW).state;
  const r = transitionOnDown(s, LATER);
  assert.equal(r.promote, true);
  assert.equal(r.state.wasDown, true);
  assert.equal(r.state.downSince, NOW, 'downSince must equal the first observation, not the promotion time');
  assert.equal(r.state.consecutiveDownChecks, 0, 'counter resets after promotion so it does not grow during the outage');
  assert.match(r.log, /promoted to incident/);
});

test('DOWN tick after promotion is a no-op (no duplicate incident, no counter growth)', () => {
  const promoted = { ...defaultState(), wasDown: true, downSince: NOW };
  const r = transitionOnDown(promoted, LATER);
  assert.equal(r.promote, false);
  assert.equal(r.alreadyDown, true);
  assert.equal(r.state.consecutiveDownChecks, 0);
  assert.equal(r.state.wasDown, true);
  assert.equal(r.state.consecutiveHealthyChecks, 0, 'a DOWN tick must reset the recovery counter');
});

test('DOWN tick after partial recovery progress resets the healthy counter', () => {
  const recovering = { ...defaultState(), wasDown: true, downSince: NOW, consecutiveHealthyChecks: 2 };
  const r = transitionOnDown(recovering, LATER);
  assert.equal(r.state.consecutiveHealthyChecks, 0);
  assert.equal(r.state.wasDown, true, 'still in an incident; healthy progress is wiped but wasDown stays true');
});

// ─── transitionOnHealthy ─────────────────────────────────────────────────────

test('healthy tick when never-was-down is a no-op apart from logging', () => {
  const r = transitionOnHealthy(defaultState());
  assert.equal(r.recovered, false);
  assert.equal(r.clearedTransientBlip, false);
  assert.equal(r.log, 'all healthy');
});

test('healthy tick after a single (un-promoted) DOWN resets suspicion', () => {
  const suspicious = { ...defaultState(), consecutiveDownChecks: 1, firstDownSince: NOW };
  const r = transitionOnHealthy(suspicious);
  assert.equal(r.recovered, false);
  assert.equal(r.clearedTransientBlip, true);
  assert.equal(r.state.consecutiveDownChecks, 0);
  assert.equal(r.state.firstDownSince, null);
});

test('1 healthy tick during an incident bumps recovery counter only', () => {
  const promoted = { ...defaultState(), wasDown: true, downSince: NOW };
  const r = transitionOnHealthy(promoted);
  assert.equal(r.recovered, false);
  assert.equal(r.state.consecutiveHealthyChecks, 1);
  assert.equal(r.state.wasDown, true);
});

test(`${RECOVERY_THRESHOLD} consecutive healthy ticks during an incident trigger RECOVERED`, () => {
  let s = { ...defaultState(), wasDown: true, downSince: NOW };
  let r;
  for (let i = 0; i < RECOVERY_THRESHOLD; i++) {
    r = transitionOnHealthy(s);
    s = r.state;
  }
  assert.equal(r.recovered, true);
  assert.equal(r.downSinceForAlert, NOW);
  assert.equal(s.wasDown, false);
  assert.equal(s.downSince, null);
  assert.equal(s.consecutiveHealthyChecks, 0, 'counter resets after RECOVERED so the next incident starts clean');
});

// ─── Round-trip: full incident lifecycle ─────────────────────────────────────

test('full lifecycle: blip, suspicion, promote, recover, all clean', () => {
  let s = defaultState();

  // Tick 1: transient blip
  const t1 = transitionOnDown(s, NOW);
  s = t1.state;
  assert.equal(t1.promote, false);
  assert.equal(s.consecutiveDownChecks, 1);

  // Tick 2: healthy — suspicion cleared, no alert ever fired
  const t2 = transitionOnHealthy(s);
  s = t2.state;
  assert.equal(t2.clearedTransientBlip, true);
  assert.equal(s.consecutiveDownChecks, 0);
  assert.equal(s.firstDownSince, null);

  // Tick 3 & 4: two real DOWN observations → promote on the second
  s = transitionOnDown(s, LATER).state;
  const t4 = transitionOnDown(s, LATER);
  s = t4.state;
  assert.equal(t4.promote, true);

  // Ticks 5,6,7: three healthy → RECOVERED on the third
  s = transitionOnHealthy(s).state;
  s = transitionOnHealthy(s).state;
  const t7 = transitionOnHealthy(s);
  s = t7.state;
  assert.equal(t7.recovered, true);
  assert.equal(s.wasDown, false);
});

// ─── Persistence ─────────────────────────────────────────────────────────────

test('loadState returns defaults when file does not exist', () => {
  const p = tmpStateFile('absent.json');
  const s = loadState(p, { warn: () => {} });
  assert.deepEqual(s, defaultState());
});

test('saveStateAtomic + loadState round-trip', () => {
  const p = tmpStateFile('roundtrip.json');
  const s = { ...defaultState(), wasDown: true, downSince: NOW, incidentId: 'abc' };
  saveStateAtomic(p, s);
  const loaded = loadState(p, { warn: () => {} });
  assert.equal(loaded.wasDown, true);
  assert.equal(loaded.downSince, NOW);
  assert.equal(loaded.incidentId, 'abc');
});

test('saveStateAtomic creates the parent directory if missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-state-'));
  const p = path.join(dir, 'nested', 'sub', 'state.json');
  saveStateAtomic(p, defaultState());
  assert.ok(fs.existsSync(p));
});

test('saveStateAtomic leaves no .tmp- files behind on success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-state-'));
  const p = path.join(dir, 'state.json');
  saveStateAtomic(p, defaultState());
  const stragglers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(stragglers, [], 'temp file should be renamed away');
});

test('saveStateAtomic succeeds when state dir pre-exists with loose mode', () => {
  // Models an operator who manually `mkdir -p /var/lib/wishlist` with the
  // default 0755 mode before the watchdog ever runs. saveStateAtomic should
  // still write the state file (the chmod in ensureStateDir is best-effort,
  // not a precondition). We verify save+load round-trip rather than the
  // post-chmod mode itself, because chmod outcome depends on the test
  // process owning the directory — which it does in tmpdir, but a strict
  // mode assertion would be flaky across CI environments with unusual umask
  // or POSIX-emulation filesystems.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-state-'));
  fs.chmodSync(dir, 0o755);
  const p = path.join(dir, 'state.json');
  const warnings = [];
  saveStateAtomic(p, { ...defaultState(), wasDown: true, downSince: NOW });
  const loaded = loadState(p, { warn: (m) => warnings.push(m) });
  assert.equal(loaded.wasDown, true);
  assert.equal(loaded.downSince, NOW);
  assert.deepEqual(warnings, [], 'load path should not warn on a healthy save');
});

test('loadState backs up corrupted JSON and returns defaults', () => {
  const p = tmpStateFile('corrupted.json');
  fs.writeFileSync(p, '{ this is not valid JSON');
  const warnings = [];
  const s = loadState(p, { warn: (msg) => warnings.push(msg) });
  assert.deepEqual(s, defaultState());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid JSON/);
  assert.match(warnings[0], /\.corrupt-/);
  const siblings = fs.readdirSync(path.dirname(p));
  assert.equal(siblings.some((n) => n.includes('.corrupt-')), true, 'a .corrupt-<ts> backup should exist');
  // Original path is gone — that's why we backed it up.
  assert.equal(fs.existsSync(p), false);
});

// ─── Zero-exposure alert logic ───────────────────────────────────────────────

test('zero-exposure: a stale incident with 0 exposures is listed for alert', () => {
  const incident = {
    id: 'inc-1',
    ageMs: 16 * 60 * 1000, // 16 min — past the 15-min threshold
    exposureCount: 0,
    status: 'active',
  };
  const r = evaluateZeroExposureAlerts(defaultState(), [incident]);
  assert.deepEqual(r.toAlert.map((c) => c.id), ['inc-1']);
  // Dedup is NOT added inside evaluateZeroExposureAlerts; that's the
  // caller's job after a successful Telegram send.
  assert.deepEqual(r.state.zeroExposureAlertedIncidentIds, []);
});

test('zero-exposure: same incident re-alerts on next tick if dedup was not marked', () => {
  // Models "Telegram delivery failed — leave dedup untouched, retry next tick".
  const incident = { id: 'inc-1', ageMs: 16 * 60 * 1000, exposureCount: 0, status: 'active' };
  const r1 = evaluateZeroExposureAlerts(defaultState(), [incident]);
  // Caller skipped markZeroExposureAlerted because sendAlert returned false.
  const r2 = evaluateZeroExposureAlerts(r1.state, [incident]);
  assert.deepEqual(r2.toAlert.map((c) => c.id), ['inc-1'], 'must retry until acked');
});

test('zero-exposure: markZeroExposureAlerted dedup prevents re-alert', () => {
  // Models "Telegram delivery succeeded — caller marks the id as alerted".
  const incident = { id: 'inc-1', ageMs: 16 * 60 * 1000, exposureCount: 0, status: 'active' };
  const r1 = evaluateZeroExposureAlerts(defaultState(), [incident]);
  const acked = markZeroExposureAlerted(r1.state, r1.toAlert.map((c) => c.id));
  assert.deepEqual(acked.zeroExposureAlertedIncidentIds, ['inc-1']);
  const r2 = evaluateZeroExposureAlerts(acked, [incident]);
  assert.deepEqual(r2.toAlert, []);
  assert.deepEqual(r2.state.zeroExposureAlertedIncidentIds, ['inc-1'], 'still deduped');
});

test('markZeroExposureAlerted is idempotent', () => {
  const a = markZeroExposureAlerted(defaultState(), ['inc-1', 'inc-1', 'inc-2']);
  assert.deepEqual(a.zeroExposureAlertedIncidentIds.sort(), ['inc-1', 'inc-2']);
  const b = markZeroExposureAlerted(a, ['inc-1']);
  assert.deepEqual(b.zeroExposureAlertedIncidentIds.sort(), ['inc-1', 'inc-2']);
});

test('zero-exposure: too-young incident does not alert yet', () => {
  const young = { id: 'inc-1', ageMs: 10 * 60 * 1000, exposureCount: 0, status: 'active' };
  const r = evaluateZeroExposureAlerts(defaultState(), [young]);
  assert.deepEqual(r.toAlert, []);
});

test('zero-exposure: incident with exposures is not a candidate', () => {
  const ok = { id: 'inc-1', ageMs: 16 * 60 * 1000, exposureCount: 5, status: 'active' };
  const r = evaluateZeroExposureAlerts(defaultState(), [ok]);
  assert.deepEqual(r.toAlert, []);
});

test('zero-exposure: recovered incident drops out of dedup set', () => {
  const stale = { id: 'inc-1', ageMs: 16 * 60 * 1000, exposureCount: 0, status: 'active' };
  const acked = markZeroExposureAlerted(defaultState(), ['inc-1']);
  // Next tick: same incident has now recovered (status flipped).
  const recovered = { ...stale, status: 'recovered' };
  const next = evaluateZeroExposureAlerts(acked, [recovered]);
  assert.deepEqual(next.toAlert, []);
  assert.deepEqual(next.state.zeroExposureAlertedIncidentIds, [], 'dedup pruned once incident is no longer eligible');
});

test('zero-exposure: exposures back-filled later → dedup is pruned too', () => {
  const acked = markZeroExposureAlerted(defaultState(), ['inc-1']);
  const fixed = { id: 'inc-1', ageMs: 16 * 60 * 1000, exposureCount: 12, status: 'active' };
  const next = evaluateZeroExposureAlerts(acked, [fixed]);
  assert.deepEqual(next.toAlert, []);
  assert.deepEqual(next.state.zeroExposureAlertedIncidentIds, []);
});

test(`zero-exposure: ZERO_EXPOSURE_MIN_AGE_MS sanity (= ${ZERO_EXPOSURE_MIN_AGE_MS / 60_000} min)`, () => {
  assert.equal(ZERO_EXPOSURE_MIN_AGE_MS, 15 * 60 * 1000);
});

test(`promotion threshold = ${PROMOTE_THRESHOLD}, recovery threshold = ${RECOVERY_THRESHOLD}`, () => {
  assert.equal(PROMOTE_THRESHOLD, 2);
  assert.equal(RECOVERY_THRESHOLD, 3);
});

// ─── Default state path contract ─────────────────────────────────────────────
// state.mjs is path-agnostic (caller passes the file path in), so this test
// is a source-text assertion against the actual cron-runnable entry point,
// not a behavioural test. It locks the default in place so an accidental
// path change (back to /tmp, or back to /var/lib/wishlist directly) shows
// up in CI rather than after a deploy.

test('health-watchdog.mjs defaults state file to /var/lib/wishlist/watchdog/state.json', () => {
  const here = new URL('.', import.meta.url).pathname;
  const src = fs.readFileSync(path.join(here, 'health-watchdog.mjs'), 'utf8');
  // Single string-literal match, must be the dedicated subdir form.
  assert.match(
    src,
    /WATCHDOG_STATE_FILE\s*\?\?\s*['"]\/var\/lib\/wishlist\/watchdog\/state\.json['"]/,
    'default state path must be /var/lib/wishlist/watchdog/state.json so ensureStateDir only chmods the dedicated subdir',
  );
  // Negative: the parent-dir form is what we explicitly moved AWAY from.
  // If this regex matches as the DEFAULT (not as a legacy-fallback entry),
  // someone reverted the surgical fix.
  assert.doesNotMatch(
    src,
    /WATCHDOG_STATE_FILE\s*\?\?\s*['"]\/var\/lib\/wishlist\/watchdog-state\.json['"]/,
    'do not regress to /var/lib/wishlist/watchdog-state.json — that path makes ensureStateDir touch the shared parent dir',
  );
});
