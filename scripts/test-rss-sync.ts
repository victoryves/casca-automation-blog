#!/usr/bin/env tsx

import { initDatabase, closeDatabase } from '../src/db/local.js';
import { librarianPendingReviewOps, publicationHistoryOps } from '../src/db/operations/index.js';
import { fetchRssArtistNames, syncRssFeedToPublicationHistory } from '../src/modules/publication-history/rss-sync.js';

async function main(): Promise<void> {
  initDatabase();

  const result = await fetchRssArtistNames('https://blog.casca-archive.org/rss.xml');
  console.log(`RSS auto-sync entries found: ${result.synced.length}`);
  for (const entry of result.synced) {
    console.log(`- ${entry.artistName} | ${entry.title}`);
  }
  console.log(`\nRSS pending-review entries found: ${result.pendingReview.length}`);
  for (const entry of result.pendingReview.slice(0, 10)) {
    console.log(`- ${entry.resolvedName} | confidence ${entry.confidence} | ${entry.originalTitle}`);
  }

  const syncResult = await syncRssFeedToPublicationHistory('https://blog.casca-archive.org/rss.xml');
  const sampleNames = ['Antonio Dias', 'Arthur Bispo do Rosário', 'Carlos Araujo', 'Rayana Rayo', 'Alcir Lacerda', 'Francisco Brennand'];
  console.log('\nPublication history presence after sync:');
  for (const name of sampleNames) {
    console.log(`- ${name}: ${await publicationHistoryOps.isPublished(name) ? 'present' : 'missing'}`);
  }
  console.log(`\nSync summary: synced=${syncResult.synced.length} pending=${syncResult.pendingReview.length}`);
  const pending = await librarianPendingReviewOps.findAll();
  const boatSails = pending.find((entry) => /boat sails|velames/i.test(entry.original_title));
  console.log(`Boat Sails pending review: ${boatSails ? `${boatSails.resolved_name} (${boatSails.confidence})` : 'not found'}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    closeDatabase();
  });
