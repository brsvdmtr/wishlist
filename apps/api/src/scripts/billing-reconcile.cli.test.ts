import { describe, it, expect, vi } from 'vitest';
import { parseArgs, resolveExitCode } from './billing-reconcile.cli';
import type { ReconciliationReport } from '../services/billing-reconciliation';

const okReport = { ok: true } as ReconciliationReport;
const dirtyReport = { ok: false } as ReconciliationReport;

describe('parseArgs', () => {
  it('defaults to a safe read-only dry-run with no flags', () => {
    expect(parseArgs([])).toEqual({ apply: false, json: false, strict: false, help: false });
  });

  it('parses each known flag', () => {
    expect(parseArgs(['--apply', '--json', '--strict'])).toMatchObject({ apply: true, json: true, strict: true });
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('warns on an unknown flag but stays safe (never mutates)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = parseArgs(['--aply']); // typo for --apply
    expect(cli.apply).toBe(false); // safe default — typo must not mutate
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown flag '--aply'"));
    errSpy.mockRestore();
  });
});

describe('resolveExitCode', () => {
  it('0 when clean regardless of --strict', () => {
    expect(resolveExitCode(okReport, false)).toBe(0);
    expect(resolveExitCode(okReport, true)).toBe(0);
  });

  it('findings: 0 without --strict, 2 with --strict', () => {
    expect(resolveExitCode(dirtyReport, false)).toBe(0);
    expect(resolveExitCode(dirtyReport, true)).toBe(2);
  });

  it('3 when --apply post-verification failed (null report) under --strict, else 0', () => {
    // The mutation already succeeded; a failed post-apply re-read must not read
    // as "all clean" (0) to a strict cron.
    expect(resolveExitCode(null, true)).toBe(3);
    expect(resolveExitCode(null, false)).toBe(0);
  });
});
