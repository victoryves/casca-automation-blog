#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { artistOps, publicationHistoryOps } from '../src/db/operations/index.js';
import { query } from '../src/db/client.js';
import {
  loadSitemapCache,
  sitemapEntryMatchesArtist,
  syncPublicationHistoryFromSitemap,
} from '../src/modules/publication-history/sitemap-sync.js';

type ResetRow = {
  full_name: string;
  status: string;
  priority: number | null;
};

const PRIORITY_TARGETS = new Set(['Tereza Costa Rêgo', 'Farnese de Andrade', 'Maria Auxiliadora']);
const RESETTABLE_STATUSES = new Set(['skipped_asset_quality', 'skipped_pure_context_failure']);

async function isAlreadyPublished(fullName: string): Promise<boolean> {
  if (await publicationHistoryOps.isPublished(fullName)) {
    return true;
  }

  const cache = loadSitemapCache();
  return cache.some((entry) => sitemapEntryMatchesArtist(fullName, entry));
}

async function main(): Promise<void> {
  initDatabase();

  try {
    const sync = await syncPublicationHistoryFromSitemap();
    console.log(`SITEMAP_SYNC urls=${sync.urls} names=${sync.synced}`);

    const rows = query.all<ResetRow>(
      `SELECT full_name, status, priority
       FROM artists
       WHERE status IN ('skipped_asset_quality', 'skipped_pure_context_failure')
          OR full_name IN ('Tereza Costa Rêgo', 'Farnese de Andrade', 'Maria Auxiliadora')
       ORDER BY priority DESC, full_name ASC`
    );

    const summary: Array<{
      artist_name: string;
      previous_status: string;
      final_status: string;
      priority: number;
      reset: boolean;
      reason: string;
    }> = [];

    for (const row of rows) {
      const artist = await artistOps.findByNormalizedName(row.full_name);
      if (!artist?.id) {
        continue;
      }

      const published = await isAlreadyPublished(artist.full_name);
      const targetPriority = PRIORITY_TARGETS.has(artist.full_name) ? 100 : Math.max(artist.priority ?? 0, 60);

      if (published) {
        await artistOps.updateStatus(artist.id, 'already_published');
        await artistOps.updatePriority(artist.id, 0);
        summary.push({
          artist_name: artist.full_name,
          previous_status: row.status,
          final_status: 'already_published',
          priority: 0,
          reset: false,
          reason: 'sitemap/publication_history match',
        });
        continue;
      }

      if (RESETTABLE_STATUSES.has(row.status) || PRIORITY_TARGETS.has(artist.full_name)) {
        await artistOps.updateStatus(artist.id, 'researched');
        await artistOps.updatePriority(artist.id, targetPriority);

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

        summary.push({
          artist_name: artist.full_name,
          previous_status: row.status,
          final_status: 'researched',
          priority: targetPriority,
          reset: true,
          reason: PRIORITY_TARGETS.has(artist.full_name) ? 'priority target reset' : 'failure cemetery reset',
        });
      }
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
