// Pure CLI helpers for billing-reconcile, split out so they're unit-testable
// without importing the script entry (which connects to the DB and runs main()).

import type { ReconciliationReport } from '../services/billing-reconciliation';

export type Cli = { apply: boolean; json: boolean; strict: boolean; help: boolean };

export const KNOWN_FLAGS = new Set(['--apply', '--dry-run', '--json', '--strict', '--help', '-h']);

export function parseArgs(argv: string[]): Cli {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  // Warn (don't fail) on typos — the safe default is dry-run, so an unknown
  // flag can never silently mutate, but a typo'd `--apply` quietly no-op'ing
  // would confuse an operator.
  for (const f of flags) {
    if (!KNOWN_FLAGS.has(f)) {
      // eslint-disable-next-line no-console
      console.error(`⚠ unknown flag '${f}' ignored — run with --help for usage. Proceeding in safe dry-run.`);
    }
  }
  return {
    // --apply is the ONLY way to mutate. --dry-run is accepted but redundant
    // (read-only is the default); --apply always wins if both are present.
    apply: flags.has('--apply'),
    json: flags.has('--json'),
    strict: flags.has('--strict'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

/**
 * Exit codes:
 *   0 — clean, OR findings without --strict, OR a succeeded --apply.
 *   2 — --strict and findings remain.
 *   3 — --strict and the post-apply verification re-run FAILED: the mutation
 *       succeeded but the resulting state could not be confirmed. Distinct from
 *       0 so a `--apply --strict` cron never reads "applied but unverified" as
 *       "all clean".
 * (1 is reserved for an unhandled crash, set by the entry's catch handler.)
 */
export function resolveExitCode(report: ReconciliationReport | null, strict: boolean): number {
  if (!report) return strict ? 3 : 0;
  if (strict && !report.ok) return 2;
  return 0;
}
