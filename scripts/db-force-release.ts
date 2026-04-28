#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { artistOps } from '../src/db/operations/index.js';
import { query } from '../src/db/client.js';

const TARGET_NAME = process.argv[2]?.trim() || 'Hamurabi Batista';

async function main(): Promise<void> {
  initDatabase();
  try {
    const artist = await artistOps.findByNormalizedName(TARGET_NAME);
    if (!artist?.id) {
      console.log(`force-release:${TARGET_NAME}:not-found`);
      return;
    }

    const metadata = artistOps.parseMetadata(artist);
    delete metadata.hard_failure_quarantine_at;
    delete metadata.hard_failure_quarantine_reason;
    delete metadata.skipped_asset_quality_at;
    delete metadata.skipped_asset_quality_reason;
    delete metadata.skipped_pure_context_failure_at;
    delete metadata.skipped_pure_context_failure_reason;
    delete metadata.last_failure_reason;
    delete metadata.last_failure_at;

    query.run(
      `UPDATE artists
       SET status = 'researched',
           priority = 100
       WHERE id = ?`,
      [artist.id]
    );
    await artistOps.updateMetadata(artist.id, metadata);
    await artistOps.resetFailureCount(artist.id);

    console.log(`force-release:${TARGET_NAME}:researched:priority=100`);
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
