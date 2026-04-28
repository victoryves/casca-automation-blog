#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';
import { artistOps, draftOps } from '../src/db/operations/index.js';
import type { Artist } from '../src/types/index.js';

async function main(): Promise<void> {
  initDatabase();

  try {
    const report = {
      resetArtists: [] as Array<{ id: number; name: string; from: string }>,
      deletedOrphanDrafts: [] as number[],
      vicenteReset: false,
    };

    const ghostArtists = query.all<Artist>(
      `SELECT a.*
       FROM artists a
       LEFT JOIN drafts d
         ON d.artist_id = a.id
        AND d.status IN ('ready', 'sent', 'approved')
       WHERE a.status IN ('ready_to_send')
       GROUP BY a.id
       HAVING COUNT(d.id) = 0`
    );

    for (const artist of ghostArtists) {
      if (!artist.id) continue;
      await artistOps.updateStatus(artist.id, 'researched');
      await artistOps.updatePriority(artist.id, 60);
      await artistOps.mergeMetadata(artist.id, {
        consistency_reset_at: new Date().toISOString(),
        consistency_reset_reason: 'artist-marked-ready-without-valid-draft',
      });
      report.resetArtists.push({ id: artist.id, name: artist.full_name, from: artist.status });
    }

    const orphanDraftRows = query.all<{ id: number }>(
      `SELECT d.id
       FROM drafts d
       LEFT JOIN artists a ON a.id = d.artist_id
       WHERE a.id IS NULL`
    );
    for (const row of orphanDraftRows) {
      await draftOps.delete(row.id);
      report.deletedOrphanDrafts.push(row.id);
    }

    const vicente = await artistOps.findByNormalizedName('Vicente do Rego Monteiro');
    if (vicente?.id) {
      await artistOps.updateStatus(vicente.id, 'discovered');
      await artistOps.updatePriority(vicente.id, 95);
      await artistOps.mergeMetadata(vicente.id, {
        consistency_reset_at: new Date().toISOString(),
        consistency_reset_reason: 'vicente-prioritized-for-research-recovery',
      });
      report.vicenteReset = true;
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    closeDatabase();
  }
}

void main();
