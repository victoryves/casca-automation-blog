#!/usr/bin/env tsx

import fs from 'node:fs';

import { loadConfig } from '../src/config/index.js';
import { initDatabase, closeDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';
import {
  artistOps,
  draftOps,
  sourceOps,
  workerHeartbeatOps,
} from '../src/db/operations/index.js';
import { ResearchAgent } from '../src/modules/agents/researcher.js';
import { CuratorAgent } from '../src/modules/agents/curator.js';
import { Dispatcher, EmailModule } from '../src/modules/email/index.js';
import type { Artist, Source } from '../src/types/index.js';

interface CacheBiographySource {
  url: string;
  title?: string;
  institution?: string;
  credibilityScore?: number;
  contentLength?: number;
  summary?: string;
}

interface CacheEntry {
  artistName: string;
  states?: string;
  practice?: string;
  biographySources?: CacheBiographySource[];
}

interface CandidateSelection {
  artist: Artist;
  sources: Source[];
  mode: 'diamond-db' | 'research-cache';
}

async function main(): Promise<void> {
  const config = loadConfig();
  initDatabase();

  try {
    console.log('\n=== CASCA Immediate Send Test ===\n');
    await diagnoseAndTouchHeartbeats();
    const candidates = await selectCandidates();
    const failures: string[] = [];

    for (const candidate of candidates) {
      try {
        console.log(`Selected candidate [${candidate.mode}]: ${candidate.artist.full_name} (#${candidate.artist.id ?? 'n/a'})`);
        console.log(`Status: ${candidate.artist.status} | Priority: ${candidate.artist.priority ?? 0}`);
        console.log(`Sources: ${candidate.sources.length}`);
        candidate.sources.forEach((source, index) => {
          console.log(`  ${index + 1}. ${source.institution} | ${source.url}`);
        });

        const mergedSummary = await forceResearch(candidate.artist, candidate.sources);
        console.log('\n=== Research Synthesis Output ===\n');
        console.log(mergedSummary);

        const draftId = await forceCuration(candidate.artist.id!);
        const draft = await draftOps.findByIdWithImages(draftId);
        if (!draft) {
          throw new Error(`Draft ${draftId} not found after curation`);
        }

        console.log('\n=== Draft Output Before Email ===\n');
        console.log(`# ${draft.title}`);
        if (draft.subtitle) {
          console.log(`## ${draft.subtitle}`);
        }
        console.log('');
        console.log(draft.content);
        console.log('\n=== Approved Images ===');
        draft.parsedImages.forEach((image, index) => {
          console.log(`${index + 1}. ${image.url}`);
          console.log(`   caption: ${image.caption ?? ''}`);
          console.log(`   attribution: ${image.attribution}`);
        });

        const email = new EmailModule(config.env.resendApiKey);
        const dispatcher = new Dispatcher(email);
        const result = await dispatcher.sendDraft(draftId, true);

        await workerHeartbeatOps.touch('draft-hydrator', 'manual-test-immediate-send:completed');
        await workerHeartbeatOps.touch('curator-agent', 'manual-test-immediate-send:completed');
        await workerHeartbeatOps.touch('research-agent', 'manual-test-immediate-send:completed');

        console.log('\n=== Dispatch Result ===\n');
        console.log(JSON.stringify(result, null, 2));
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${candidate.artist.full_name}: ${message}`);
        console.error(`\nCandidate failed: ${candidate.artist.full_name}\n${message}\n`);
      }
    }

    throw new Error(`No candidate could complete the immediate-send test.\n${failures.join('\n')}`);
  } finally {
    closeDatabase();
  }
}

async function selectCandidates(): Promise<CandidateSelection[]> {
  const rows = query.all<{
    id: number;
  }>(
    `SELECT a.id
     FROM artists a
     JOIN sources s ON s.artist_id = a.id
     WHERE (s.url LIKE '%itaucultural.org.br%' OR s.url LIKE '%.gov.br%' OR s.url LIKE '%secult.%' OR s.url LIKE '%mapa.cultura.%')
       AND a.status NOT IN ('published', 'failed_permanent', 'rejected')
     GROUP BY a.id
     ORDER BY MAX(a.priority) DESC, MAX(a.discovered_at) DESC
     LIMIT 5`
  );

  const candidates: CandidateSelection[] = [];
  for (const row of rows) {
    const artist = await artistOps.findById(row.id);
    const sources = await sourceOps.findByArtistId(row.id);
    if (artist && sources.length > 0) {
      candidates.push({
        artist,
        sources,
        mode: 'diamond-db',
      });
    }
  }

  const fallback = await buildArtistFromResearchCache();
  if (fallback) {
    candidates.push(fallback);
  }

  if (candidates.length === 0) {
    throw new Error('No diamond-domain candidate and no usable research-cache fallback found');
  }

  return candidates;
}

async function buildArtistFromResearchCache(): Promise<CandidateSelection | null> {
  const cachePath = 'data/artist-research-cache.json';
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
    artists?: CacheEntry[];
    entries?: CacheEntry[];
    items?: CacheEntry[];
  };

  const entries = parsed.artists ?? parsed.entries ?? parsed.items ?? [];
  const eligible = entries
    .map((entry) => {
      const length = (entry.biographySources ?? []).reduce(
        (total, source) => total + (source.contentLength ?? source.summary?.length ?? 0),
        0
      );
      return { entry, length };
    })
    .filter((item) => item.length > 1500)
    .sort((a, b) => b.length - a.length);

  for (const item of eligible) {
    const existing = await artistOps.findByNormalizedName(item.entry.artistName);
    let artistId: number;

    if (existing?.id) {
      artistId = existing.id;
    } else {
      artistId = await artistOps.create({
        full_name: item.entry.artistName,
        birthplace_state: item.entry.states,
        visual_practice: item.entry.practice,
        status: 'discovered',
        priority: 55,
        metadata: JSON.stringify({
          imported_from_research_cache: true,
        }),
      });
    }

    const artist = await artistOps.findById(artistId);
    if (!artist) {
      continue;
    }

    const createdSources: Source[] = [];
    for (const source of item.entry.biographySources ?? []) {
      if (!source.url || !(source.summary ?? '').trim()) {
        continue;
      }
      const sourceId = await sourceOps.create({
        artist_id: artistId,
        url: source.url,
        institution: source.institution ?? 'Research Cache',
        credibility_score: source.credibilityScore ?? 0.8,
        content_summary: source.summary?.slice(0, 4000),
      });
      const created = await sourceOps.findById(sourceId);
      if (created) {
        createdSources.push(created);
      }
    }

    if (createdSources.length > 0) {
      return {
        artist,
        sources: createdSources,
        mode: 'research-cache',
      };
    }
  }

  return null;
}

async function diagnoseAndTouchHeartbeats(): Promise<void> {
  const heartbeats = await workerHeartbeatOps.findAll();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  console.log('\n=== Worker Diagnostics ===\n');
  if (heartbeats.length === 0) {
    console.log('No worker heartbeat rows yet.');
  } else {
    for (const heartbeat of heartbeats) {
      const stale = !heartbeat.last_heartbeat || heartbeat.last_heartbeat < staleBefore;
      console.log(
        `${heartbeat.agent_name} | last=${heartbeat.last_heartbeat ?? 'null'} | detail=${heartbeat.detail ?? 'n/a'} | stale=${stale}`
      );
    }
  }

  console.log('\nDiagnosis: one-shot agent scripts now keep a grace heartbeat after a successful run, so stale warnings should no longer appear immediately.');

  await workerHeartbeatOps.touch('draft-hydrator', 'manual-test-immediate-send:start');
  await workerHeartbeatOps.touch('research-agent', 'manual-test-immediate-send:start');
  await workerHeartbeatOps.touch('curator-agent', 'manual-test-immediate-send:start');
}

async function forceResearch(artist: Artist, sources: Source[]): Promise<string> {
  const researchAgent = new ResearchAgent() as unknown as {
    cleanMergedSourceSummary: (artist: Artist, sources: Source[], rawText: string) => Promise<{ usable: boolean; cleanedSummary: string; reason: string }>;
    cleanSourceSummary: (artist: Artist, source: Source) => Promise<{ usable: boolean; cleanedSummary: string; reason: string }>;
  };

  const preferredSources = [...sources]
    .sort((a, b) => (b.credibility_score ?? 0) - (a.credibility_score ?? 0))
    .slice(0, 3);

  const cleanedSources = await Promise.all(preferredSources.map((source) => researchAgent.cleanSourceSummary(artist, source)));
  const combinedRawText = cleanedSources
    .filter((result) => result.usable && result.cleanedSummary.trim().length > 120)
    .map((result) => result.cleanedSummary.trim())
    .join('\n\n');

  let merged = await researchAgent.cleanMergedSourceSummary(artist, preferredSources, combinedRawText);

  if (!merged.usable || !merged.cleanedSummary.trim()) {
    for (const cleaned of cleanedSources) {
      if (cleaned.usable && cleaned.cleanedSummary.trim()) {
        merged = cleaned;
        break;
      }
    }
  }

  if (!merged.usable || !merged.cleanedSummary.trim()) {
    throw new Error(`Research synthesis failed for ${artist.full_name}: ${merged.reason}`);
  }

  for (const source of preferredSources) {
    if (source.id) {
      await sourceOps.updateContentSummary(source.id, merged.cleanedSummary);
    }
  }

  await artistOps.updateStatus(artist.id!, 'researched');
  await artistOps.updatePriority(artist.id!, 70);
  await artistOps.resetFailureCount(artist.id!);

  return merged.cleanedSummary;
}

async function forceCuration(artistId: number): Promise<number> {
  const artist = await artistOps.findById(artistId);
  if (!artist) {
    throw new Error(`Artist ${artistId} not found before curation`);
  }

  const curator = new CuratorAgent() as unknown as {
    processArtist: (artist: Artist) => Promise<{ ready: number; permanent: number; failures: number; approved: number; rejected: number }>;
  };

  const result = await curator.processArtist(artist);
  if (result.ready < 1) {
    const refreshed = await artistOps.findById(artistId);
    throw new Error(
      `Curator did not produce a ready draft for ${artist.full_name}. Result=${JSON.stringify(result)} Metadata=${refreshed?.metadata ?? 'n/a'}`
    );
  }

  const drafts = await draftOps.findByArtistId(artistId);
  const latest = drafts.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
  if (!latest?.id) {
    throw new Error(`No draft found for artist ${artist.full_name} after curation`);
  }

  return latest.id;
}

void main();
