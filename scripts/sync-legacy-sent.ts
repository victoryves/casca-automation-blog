#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';
import { publicationHistoryOps } from '../src/db/operations/index.js';

type LegacySentRow = {
  draft_id: number;
  title: string;
  sent_at: string | null;
  artist_name: string;
};

async function main(): Promise<void> {
  initDatabase();
  try {
    const rows = query.all<LegacySentRow>(
      `SELECT d.id AS draft_id, d.title, d.sent_at, a.full_name AS artist_name
       FROM drafts d
       JOIN artists a ON a.id = d.artist_id
       WHERE d.status = 'sent'
       ORDER BY d.id ASC`
    );

    let synced = 0;
    for (const row of rows) {
      if (await publicationHistoryOps.isPublished(row.artist_name)) {
        console.log(`skip:${row.artist_name}:already-present`);
        continue;
      }

      await publicationHistoryOps.upsert({
        artist_name: row.artist_name,
        normalized_artist_name: publicationHistoryOps.normalizeArtistName(row.artist_name),
        post_title: row.title,
        post_url: null,
        source: 'legacy_db',
        published_at: row.sent_at,
        synced_at: new Date().toISOString(),
      });
      synced += 1;
      console.log(`synced:${row.artist_name}:draft=${row.draft_id}`);
    }

    console.log(`SYNC_RESULT ${JSON.stringify({ synced, total: rows.length })}`);
  } finally {
    closeDatabase();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
