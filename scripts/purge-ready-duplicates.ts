#!/usr/bin/env tsx

import { initDatabase, closeDatabase } from '../src/db/local.js';
import { purgeReadyDuplicatesAgainstPublicationHistory } from '../src/modules/publication-history/ready-purge.js';

async function main(): Promise<void> {
  initDatabase();
  const purged = await purgeReadyDuplicatesAgainstPublicationHistory();
  console.log(`Purged duplicates from ready queue: ${purged.length}`);
  for (const item of purged) {
    console.log(
      `- ${item.artistName} | artist=${item.artistId} | draft=${item.draftId ?? 'n/a'} | source=${item.matchedPublicationUrl ?? 'n/a'}`
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    closeDatabase();
  });
