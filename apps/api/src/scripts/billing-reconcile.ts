#!/usr/bin/env node
// CLI entry for billing reconciliation.
//
//   pnpm billing:reconcile                 # dry-run (read-only) — DEFAULT
//   pnpm billing:reconcile -- --dry-run    # same, explicit
//   pnpm billing:reconcile -- --json       # machine-readable report on stdout
//   pnpm billing:reconcile -- --apply      # perform the safe relink backfill
//   pnpm billing:reconcile -- --strict     # exit 2 when any finding exists
//
// On prod (no tsx in the image) run the compiled output inside the container:
//   docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/billing-reconcile.js --dry-run
//
// Dry-run is the DEFAULT precisely so that a forwarded-flag hiccup can never
// silently mutate billing data — the dangerous path requires an explicit
// --apply. See docs/ops/billing-reconciliation.md.

import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@wishlist/db';
import {
  reconcileBilling,
  applySafeFixes,
  FINDING_SEVERITY,
  type ReconciliationFinding,
  type ReconciliationReport,
} from '../services/billing-reconciliation';

// Load DATABASE_URL from repo-root .env when running locally (prod sets it in
// the container env). Mirrors packages/db/scripts/prisma.cjs.
function loadLocalEnv(): void {
  if (process.env.DATABASE_URL) return;
  const repoRootEnv = path.resolve(__dirname, '../../../../.env');
  if (fs.existsSync(repoRootEnv)) {
    // dotenv is a runtime dep of @wishlist/api.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('dotenv').config({ path: repoRootEnv });
  }
}

type Cli = { apply: boolean; json: boolean; strict: boolean; help: boolean };

const KNOWN_FLAGS = new Set(['--apply', '--dry-run', '--json', '--strict', '--help', '-h']);

function parseArgs(argv: string[]): Cli {
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

const HELP = `billing:reconcile — cross-check PaymentEvent / Subscription / Purchase

Usage:
  pnpm billing:reconcile [-- <flags>]

Flags:
  --dry-run   Report only, no writes (DEFAULT).
  --apply     Perform the safe relink backfill (orphan subscription-payment
              PaymentEvents → owner's PRO subscription, when unambiguous).
  --json      Emit the full report as JSON on stdout.
  --strict    Exit code 2 when any finding exists (for cron alerting).
  -h, --help  Show this help.

Detection is read-only. Refunds, re-grants and EXPIRED transitions are never
automated — see docs/ops/billing-reconciliation.md.`;

const SEV_ICON: Record<string, string> = { high: '🔴', medium: '🟡', low: '⚪' };

function fmtFinding(f: ReconciliationFinding): string {
  const ids = [
    f.paymentEventId && `pe=${f.paymentEventId}`,
    f.subscriptionId && `sub=${f.subscriptionId}`,
    f.purchaseId && `pur=${f.purchaseId}`,
    f.userId && `user=${f.userId}`,
    f.chargeIdHash && `charge#${f.chargeIdHash}`,
    f.skuCode && `sku=${f.skuCode}`,
    typeof f.amount === 'number' && `${f.amount} ${f.currency ?? ''}`.trim(),
  ]
    .filter(Boolean)
    .join('  ');
  return `  ${SEV_ICON[f.severity] ?? '•'} [${f.kind}] ${f.detail}\n      ${ids}`;
}

function printHuman(report: ReconciliationReport): void {
  const { scanned, bySeverity, counts, findings } = report;
  // eslint-disable-next-line no-console
  const log = console.log;
  log('');
  log('━━━ Billing reconciliation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`  generated: ${report.generatedAt}`);
  log(
    `  scanned:   ${scanned.paymentEvents} payment events · ${scanned.subscriptions} subscriptions · ${scanned.purchases} purchases`,
  );
  if (report.ok) {
    log('  result:    ✅ no discrepancies');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return;
  }
  log(
    `  result:    ⚠ ${findings.length} finding(s) — 🔴 ${bySeverity.high} high · 🟡 ${bySeverity.medium} medium · ⚪ ${bySeverity.low} low`,
  );
  log('');
  (Object.keys(counts) as (keyof typeof counts)[])
    .filter((k) => counts[k] > 0)
    .sort((a, b) => severityRank(b) - severityRank(a))
    .forEach((kind) => {
      log(`  ${SEV_ICON[FINDING_SEVERITY[kind]]} ${kind}: ${counts[kind]}`);
      findings.filter((f) => f.kind === kind).forEach((f) => log(fmtFinding(f)));
      log('');
    });
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

function severityRank(kind: ReconciliationFinding['kind']): number {
  return { high: 3, medium: 2, low: 1 }[FINDING_SEVERITY[kind]];
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return 0;
  }

  loadLocalEnv();
  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL is not set — cannot reconcile.');
    return 1;
  }

  const prisma = new PrismaClient();
  try {
    const report = await reconcileBilling(prisma);

    if (cli.apply) {
      const applied = await applySafeFixes(prisma);
      if (!cli.json) {
        // eslint-disable-next-line no-console
        console.log(
          `\n🔧 --apply: relinked ${applied.relinkedPaymentEvents.length} PaymentEvent(s); skipped ${applied.skipped.length}.`,
        );
        applied.skipped.forEach((s) =>
          // eslint-disable-next-line no-console
          console.log(`     skip pe=${s.paymentEventId}: ${s.reason}`),
        );
      }
      // Re-run so the printed report reflects post-fix state. The mutation has
      // ALREADY succeeded and been reported above, so a failure of this
      // read-only post-pass must NOT mask that — print what we have and exit 0
      // rather than surfacing a misleading hard failure (exit 1).
      let after: ReconciliationReport | null = null;
      try {
        after = await reconcileBilling(prisma);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `⚠ relink succeeded, but the post-apply report failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (cli.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ before: report, applied, after }, null, 2));
      } else if (after) {
        printHuman(after);
      }
      return after ? exitCode(after, cli.strict) : 0;
    }

    if (cli.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHuman(report);
    }
    return exitCode(report, cli.strict);
  } finally {
    await prisma.$disconnect();
  }
}

function exitCode(report: ReconciliationReport, strict: boolean): number {
  if (strict && !report.ok) return 2;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('billing:reconcile failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
