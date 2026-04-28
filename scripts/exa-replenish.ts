#!/usr/bin/env tsx

import { pathToFileURL } from 'node:url';
import { closeDatabase, initDatabase } from '../src/db/local.js';
import { getConfig } from '../src/config/index.js';
import { artistOps, publicationHistoryOps, sourceOps, workerHeartbeatOps } from '../src/db/operations/index.js';
import { ExaClient } from '../src/modules/discovery/exa-client.js';
import { SEED_ARTISTS, type SeedArtist } from '../src/modules/discovery/seed-artists.js';
import {
  loadSitemapCache,
  sitemapEntryMatchesArtist,
  syncPublicationHistoryFromSitemap,
} from '../src/modules/publication-history/sitemap-sync.js';

type ReplenishResult = {
  inserted: number;
  skippedPublished: number;
  skippedExisting: number;
  skippedUnverified: number;
  insertedNames: string[];
};

type CandidateValidation = {
  biographyResults: Awaited<ReturnType<ExaClient['search']>>['results'];
  imageResults: Awaited<ReturnType<ExaClient['search']>>['results'];
};

const TARGET_INSERT_COUNT = 10;
const HIGH_PRIORITY = 98;
const BIOGRAPHY_DOMAINS = [
  'enciclopedia.itaucultural.org.br',
  'pinacoteca.org.br',
  'wikipedia.org',
  'pt.wikipedia.org',
  'artsy.net',
  'leiloesbr.com.br',
  'iam-pba.com.br',
  'catalogodasartes.com.br',
];

function matchesArchiveAesthetic(seed: SeedArtist): boolean {
  const haystack = `${seed.practice} ${seed.category} ${seed.states ?? ''}`.toLowerCase();
  return (
    /(xilograv|gravura|pintura|desenho|modern|armorial|naif|popular|regional)/.test(haystack) &&
    !/(fotografia|performance|instala|mural|urbana|graffiti|street)/.test(haystack)
  );
}

function inferBirthplaceState(seed: SeedArtist): string | undefined {
  const [primary] = (seed.states ?? '').split('/');
  return primary?.trim() || undefined;
}

function inferInstitutionName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'exa-discovery';
  }
}

async function validateCandidate(exa: ExaClient, seed: SeedArtist): Promise<CandidateValidation | null> {
  const biographyQuery = `"${seed.name}" biografia análise crítica artista brasileiro ${seed.practice} Nordeste Brasil`;
  const imageQuery = `High resolution original artwork file for ${seed.name}, high-fidelity scan, direct image link from auction houses or museum archives, original size, 2000px`;

  const [biography, images] = await Promise.all([
    exa.search({
      query: biographyQuery,
      maxResults: 4,
      includeDomains: BIOGRAPHY_DOMAINS,
    }),
    exa.search({
      query: imageQuery,
      maxResults: 6,
      includeDomains: ['leiloesbr.com.br', 'iam-pba.com.br', 'catalogodasartes.com.br', 'artsy.net', 'artsandculture.google.com'],
    }),
  ]);

  const biographyResults = biography.results.filter(
    (result) => result.content.trim().length >= 180 || /biografia|obra|acervo|pintura|xilogravura/i.test(result.title)
  );
  const imageResults = images.results.filter(
    (result) => /image|jpg|jpeg|artwork|obra|painting|xilogravura|gravura|oil|canvas/i.test(
      `${result.title} ${result.content} ${result.url}`
    )
  );

  if (biographyResults.length === 0 || imageResults.length === 0) {
    return null;
  }

  return { biographyResults, imageResults };
}

export async function replenishWithExa(targetCount = TARGET_INSERT_COUNT): Promise<ReplenishResult> {
  const exa = new ExaClient(getConfig().env.exaApiKey);
  const sitemapSync = await syncPublicationHistoryFromSitemap();
  const sitemapEntries = sitemapSync.entries.length > 0 ? sitemapSync.entries : loadSitemapCache();

  let inserted = 0;
  let skippedPublished = 0;
  let skippedExisting = 0;
  let skippedUnverified = 0;
  const insertedNames: string[] = [];

  const candidates = SEED_ARTISTS
    .filter(matchesArchiveAesthetic)
    .sort((a, b) => {
      const score = (seed: SeedArtist) => {
        const haystack = `${seed.practice} ${seed.category}`.toLowerCase();
        if (/xilograv|gravura/.test(haystack)) return 3;
        if (/pintura|desenho/.test(haystack)) return 2;
        return 1;
      };
      return score(b) - score(a);
    });

  for (const seed of candidates) {
    if (inserted >= targetCount) {
      break;
    }

    const normalizedName = publicationHistoryOps.normalizeArtistName(seed.name);
    if (!normalizedName) {
      skippedUnverified += 1;
      continue;
    }

    if (
      sitemapEntries.some((entry) => sitemapEntryMatchesArtist(seed.name, entry)) ||
      (await publicationHistoryOps.isPublished(seed.name))
    ) {
      skippedPublished += 1;
      continue;
    }

    const existingArtist = await artistOps.findByNormalizedName(seed.name);
    if (existingArtist?.id) {
      skippedExisting += 1;
      continue;
    }

    let validated: CandidateValidation | null = null;
    try {
      validated = await validateCandidate(exa, seed);
    } catch (error) {
      console.warn(
        `Exa replenish validation failed for ${seed.name}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      skippedUnverified += 1;
      continue;
    }

    if (!validated) {
      skippedUnverified += 1;
      continue;
    }

    const metadata = {
      exa_replenished: true,
      research_refresh_required: true,
      pure_context_lock: true,
      force_high_res_mode: true,
      exa_replenished_at: new Date().toISOString(),
      exa_seed_category: seed.category,
      exa_seed_practice: seed.practice,
      exa_seed_states: seed.states ?? null,
      editorial_guardrails: {
        anatomy_focus: true,
        leg_required: true,
      },
      exa_candidate_queries: {
        biography: validated.biographyResults.slice(0, 3).map((result) => result.url),
        images: validated.imageResults.slice(0, 3).map((result) => result.url),
      },
    };

    const artistId = await artistOps.create({
      full_name: seed.name,
      birthplace_state: inferBirthplaceState(seed),
      visual_practice: seed.practice,
      status: 'researched',
      metadata: JSON.stringify(metadata),
      discovered_at: new Date().toISOString(),
      published_at: null,
      last_heartbeat: null,
      priority: HIGH_PRIORITY,
      failure_count: 0,
    });

    for (const result of [...validated.biographyResults.slice(0, 3), ...validated.imageResults.slice(0, 2)]) {
      await sourceOps.create({
        artist_id: artistId,
        url: result.url,
        institution: inferInstitutionName(result.url),
        credibility_score: /itau|pinacoteca|wikipedia|artsy|leiloesbr|catalogodasartes|iam-pba/i.test(result.url)
          ? 0.92
          : 0.75,
        content_summary: result.content.slice(0, 1800),
      });
    }

    inserted += 1;
    insertedNames.push(seed.name);
  }

  return {
    inserted,
    skippedPublished,
    skippedExisting,
    skippedUnverified,
    insertedNames,
  };
}

async function main(): Promise<void> {
  initDatabase();
  try {
    await workerHeartbeatOps.touch('exa-replenish', 'start');
    const requestedCount = Number(process.argv[2] ?? TARGET_INSERT_COUNT);
    const result = await replenishWithExa(Number.isFinite(requestedCount) ? requestedCount : TARGET_INSERT_COUNT);
    await workerHeartbeatOps.touch(
      'exa-replenish',
      `inserted:${result.inserted};published:${result.skippedPublished};existing:${result.skippedExisting};unverified:${result.skippedUnverified}`
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    closeDatabase();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
