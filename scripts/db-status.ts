#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';

type StatusCount = {
  status: string;
  count: number;
};

const STATUS_INDICATORS: Record<string, string> = {
  ready_to_send: '🟢',
  verified: '🟢',
  curated: '🟢',
  drafted: '🟢',
  researched: '🟡',
  discovered: '⚪',
  pending_more_sources: '🟠',
  already_published: '🔵',
  published: '🔵',
  rejected: '🔴',
  rejected_by_head_of_art: '🔴',
  rejected_duplicate_external: '🔴',
  skipped_asset_quality: '🔴',
  failed_asset_quality_retry_headless: '🔴',
  hard_failure_quarantine: '🔴',
  skipped_pure_context_failure: '🔴',
  failed_context_preflight: '🔴',
  failed_permanent: '🔴',
  review_later: '🟣',
};

function indicatorFor(status: string): string {
  return STATUS_INDICATORS[status] ?? '⚪';
}

function printStatus(rows: StatusCount[], totalArtists: number): void {
  console.log('\nCASCA Database Status');
  console.log('=====================');
  console.log(`Total artists: ${totalArtists}\n`);

  console.table(
    rows.map((row) => ({
      status: `${indicatorFor(row.status)} ${row.status}`,
      count: row.count,
      percent: totalArtists > 0 ? `${((row.count / totalArtists) * 100).toFixed(1)}%` : '0.0%',
    }))
  );
}

async function main(): Promise<void> {
  initDatabase();
  try {
    const rows = query.all<StatusCount>(
      `SELECT status, COUNT(*) as count
       FROM artists
       GROUP BY status
       ORDER BY count DESC`
    );

    const total = query.get<{ count: number }>(`SELECT COUNT(*) as count FROM artists`);
    printStatus(rows, total?.count ?? 0);
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

// Run with: npx tsx scripts/db-status.ts
