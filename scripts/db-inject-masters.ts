#!/usr/bin/env tsx

import { initDatabase, closeDatabase } from '../src/db/local.js';
import { artistOps, publicationHistoryOps } from '../src/db/operations/index.js';
import { loadSitemapCache, sitemapEntryMatchesArtist } from '../src/modules/publication-history/sitemap-sync.js';

type InjectTarget = {
  name: string;
  priority: number;
  birth_year: string;
  birth_city: string;
  birth_state: string;
  style: string;
};

const TARGETS: InjectTarget[] = [
  {
    name: 'Vicente do Rego Monteiro',
    priority: 100,
    birth_year: '1899',
    birth_city: 'Recife',
    birth_state: 'Pernambuco',
    style: 'Flat modernist painting and drawing',
  },
  {
    name: 'Wellington Virgolino',
    priority: 90,
    birth_year: '1929',
    birth_city: 'Recife',
    birth_state: 'Pernambuco',
    style: 'Flat high-contrast painting',
  },
  {
    name: 'Ismael Nery',
    priority: 80,
    birth_year: '1900',
    birth_city: 'Belém',
    birth_state: 'Pará',
    style: 'High-contrast cubist-surrealist painting',
  },
];

async function isBlockedBySitemap(name: string): Promise<boolean> {
  const cache = loadSitemapCache();
  return cache.some((entry) => sitemapEntryMatchesArtist(name, entry));
}

async function main(): Promise<void> {
  initDatabase();
  try {
    const results: Array<{ artist: string; action: string; reason?: string }> = [];

    for (const target of TARGETS) {
      const published = await publicationHistoryOps.isPublished(target.name);
      const blockedBySitemap = await isBlockedBySitemap(target.name);

      if (published || blockedBySitemap) {
        results.push({
          artist: target.name,
          action: 'skipped',
          reason: published ? 'already-published' : 'sitemap-match',
        });
        continue;
      }

      const existing = await artistOps.findByNormalizedName(target.name);
      const metadata = {
        bio_metadata: {
          birth_year: target.birth_year,
          birthplace_city: target.birth_city,
          birthplace_state: target.birth_state,
        },
        autonomous_seed: true,
        pure_context_lock: true,
        force_high_res_mode: true,
      };

      if (existing?.id) {
        await artistOps.updateStatus(existing.id, 'researched');
        await artistOps.updatePriority(existing.id, target.priority);
        await artistOps.mergeMetadata(existing.id, {
          ...artistOps.parseMetadata(existing),
          ...metadata,
          hard_failure_quarantine_at: null,
          hard_failure_quarantine_reason: null,
          skipped_asset_quality_at: null,
          skipped_asset_quality_reason: null,
          skipped_pure_context_failure_at: null,
          skipped_pure_context_failure_reason: null,
          last_failure_reason: null,
          last_failure_at: null,
        });
        await artistOps.resetFailureCount(existing.id);
        results.push({ artist: target.name, action: 'reset-to-researched' });
        continue;
      }

      await artistOps.create({
        full_name: target.name,
        birthplace_city: target.birth_city,
        birthplace_state: target.birth_state,
        visual_practice: target.style,
        status: 'researched',
        metadata: JSON.stringify(metadata),
        discovered_at: new Date().toISOString(),
        published_at: null,
        last_heartbeat: null,
        priority: target.priority,
        failure_count: 0,
      });
      results.push({ artist: target.name, action: 'inserted' });
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
