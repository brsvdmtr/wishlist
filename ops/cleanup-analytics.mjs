#!/usr/bin/env node
/**
 * Cleanup old AnalyticsEvent rows (>90 days).
 * Run via cron: 0 3 * * * node /opt/wishlist/ops/cleanup-analytics.mjs
 */
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await client.connect();
  const result = await client.query(
    `DELETE FROM "AnalyticsEvent" WHERE "createdAt" < NOW() - INTERVAL '90 days'`
  );
  console.log(`[cleanup] Deleted ${result.rowCount} analytics events older than 90 days`);
  await client.end();
}

main().catch(err => {
  console.error('[cleanup] Failed:', err.message);
  process.exit(1);
});
