#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { artistOps, publicationHistoryOps } from '../src/db/operations/index.js';
import { query } from '../src/db/client.js';

async function main(): Promise<void> {
  initDatabase();
  try {
    const artist = await artistOps.findByNormalizedName('Hamurabi Batista');
    if (!artist?.id) {
      console.log('repair:Hamurabi Batista:not-found');
      return;
    }

    const metadata = artistOps.parseMetadata(artist);
    delete metadata.already_published_at;
    delete metadata.already_published_source;
    delete metadata.already_published_slug;
    delete metadata.already_published_url;
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

    query.run(
      `DELETE FROM publication_history
       WHERE source = 'sitemap_xml'
         AND normalized_artist_name = ?`,
      [publicationHistoryOps.normalizeArtistName('Hamurabi Batista')]
    );

    console.log('repair:Hamurabi Batista:researched:priority=100');
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
