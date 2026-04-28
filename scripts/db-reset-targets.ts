#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { artistOps } from '../src/db/operations/index.js';
import { query } from '../src/db/client.js';

const DEFAULT_TARGETS = ['Tereza Costa Rêgo', 'Farnese de Andrade', 'Wellington Virgolino'];

async function resetTargets(targets: string[]): Promise<void> {
  for (const name of targets) {
    const artist = await artistOps.findByNormalizedName(name);
    if (!artist?.id) {
      console.log(`skip:${name}:not-found`);
      continue;
    }

    query.run(
      `UPDATE artists
       SET status = 'researched',
           priority = 100
       WHERE id = ?`,
      [artist.id]
    );

    const metadata = artistOps.parseMetadata(artist);
    delete metadata.last_failure_reason;
    delete metadata.last_failure_at;
    delete metadata.skipped_asset_quality_at;
    delete metadata.skipped_asset_quality_reason;
    delete metadata.skipped_pure_context_failure_at;
    delete metadata.skipped_pure_context_failure_reason;
    delete metadata.pending_more_sources_reason;
    delete metadata.pending_more_sources_at;
    delete metadata.pending_more_sources_length;
    delete metadata.pending_more_sources_threshold;
    delete metadata.pending_more_sources_has_diamond_source;

    await artistOps.updateMetadata(artist.id, metadata);
    await artistOps.resetFailureCount(artist.id);
    console.log(`reset:${name}:researched:priority=100`);
  }
}

async function main(): Promise<void> {
  initDatabase();
  try {
    const cliTargets = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
    const targets = cliTargets.length > 0 ? cliTargets : DEFAULT_TARGETS;
    await resetTargets(targets);
  } finally {
    closeDatabase();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
