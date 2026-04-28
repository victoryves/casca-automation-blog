#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { closeDatabase, initDatabase } from '../src/db/local.js';
import { artistOps, draftOps, publicationHistoryOps, sourceOps, workerHeartbeatOps } from '../src/db/operations/index.js';
import { query } from '../src/db/client.js';
import type { Artist } from '../src/types/index.js';
import {
  loadSitemapCache,
  sitemapEntryMatchesArtist,
  syncPublicationHistoryFromSitemap,
} from '../src/modules/publication-history/sitemap-sync.js';
import { replenishWithExa } from './exa-replenish.js';

type DispatchResult = {
  sent: boolean;
  draftId?: number;
  artistId?: number;
  artistName?: string;
  emailId?: string;
  reason?: string;
};

type NecropsyRow = {
  artistName: string;
  status: string;
  reason: string;
};

type AttemptTruthLog = {
  artist_name: string;
  sitemap_match: boolean;
  images_found_count: number;
  vision_gate_reason: string;
  research_word_count: number;
};

const BOOTSTRAP_TARGETS: Record<
  string,
  { birth_year: string; birth_city: string; birth_state: string; style: string; priority: number }
> = {
  'Maria Auxiliadora': {
    birth_year: '1935',
    birth_city: 'Campo Belo',
    birth_state: 'Minas Gerais',
    style: 'Flat high-contrast painting',
    priority: 96,
  },
  'Emanoel Araújo': {
    birth_year: '1940',
    birth_city: 'Santo Amaro',
    birth_state: 'Bahia',
    style: 'High-contrast graphic painting and printmaking',
    priority: 96,
  },
  'Rubem Valentim': {
    birth_year: '1922',
    birth_city: 'Salvador',
    birth_state: 'Bahia',
    style: 'Flat geometric painting and emblematic abstraction',
    priority: 96,
  },
  'Wellington Virgolino': {
    birth_year: '1929',
    birth_city: 'Recife',
    birth_state: 'Pernambuco',
    style: 'Flat/High-Contrast Painting',
    priority: 95,
  },
  'Monteiro Lobato': {
    birth_year: '1882',
    birth_city: 'Taubaté',
    birth_state: 'São Paulo',
    style: 'Painting',
    priority: 95,
  },
  'Lula Cardoso Ayres': {
    birth_year: '1910',
    birth_city: 'Recife',
    birth_state: 'Pernambuco',
    style: 'Modern-regionalist painting',
    priority: 95,
  },
  'Francisco Brennand': {
    birth_year: '1927',
    birth_city: 'Recife',
    birth_state: 'Pernambuco',
    style: 'Ceramics and painting',
    priority: 95,
  },
  'Cícero Dias': {
    birth_year: '1907',
    birth_city: 'Escada',
    birth_state: 'Pernambuco',
    style: 'Abstract and figurative painting',
    priority: 95,
  },
  Djanira: {
    birth_year: '1914',
    birth_city: 'Avaré',
    birth_state: 'São Paulo',
    style: 'Flat painting',
    priority: 95,
  },
  'Farnese de Andrade': {
    birth_year: '1926',
    birth_city: 'Araguari',
    birth_state: 'Minas Gerais',
    style: 'Assemblage, painting, engraving',
    priority: 95,
  },
  'Delson Uchôa': {
    birth_year: '1955',
    birth_city: 'Maceió',
    birth_state: 'Alagoas',
    style: 'Vibrant flat chromatic painting',
    priority: 95,
  },
  'Hamurabi Batista': {
    birth_year: '1950',
    birth_city: 'Recife',
    birth_state: 'Pernambuco',
    style: 'Geometric abstraction, painting, printmaking',
    priority: 100,
  },
  'Chico da Silva': {
    birth_year: '1910',
    birth_city: 'Rio Branco',
    birth_state: 'Acre',
    style: 'Figurative-fantastic painting with vibrant high contrast',
    priority: 100,
  },
  'Ismael Nery': {
    birth_year: '1900',
    birth_city: 'Belém',
    birth_state: 'Pará',
    style: 'High-contrast cubist-surrealist painting',
    priority: 100,
  },
};

function isHeadlessRun(): boolean {
  return process.argv.includes('--headless');
}

function isVerboseRun(): boolean {
  return process.argv.includes('--verbose');
}

function parseTargetArgument(): string | null {
  const targetArg = process.argv.find((value) => value.startsWith('--target='));
  if (!targetArg) {
    return null;
  }
  const [, rawTarget] = targetArg.split('=');
  return rawTarget?.trim() ? rawTarget.trim() : null;
}

function isForceHighResRun(): boolean {
  return (
    process.argv.includes('--force-high-res') ||
    process.argv.includes('--force-deep-extraction') ||
    process.argv.includes('--decrypt-urls') ||
    process.argv.includes('--auction-priority') ||
    process.argv.includes('--use-browser-render') ||
    process.argv.includes('--use-4k-render') ||
    process.argv.includes('--force-pivot')
  );
}

function isForceResetRun(): boolean {
  return process.argv.includes('--force-reset');
}

function isForcePivotRun(): boolean {
  return process.argv.includes('--force-pivot');
}

function isHydrateOnlyRun(): boolean {
  return process.argv.includes('--hydrate-only') || process.argv.includes('--no-dispatch');
}

async function forceResetTargets(): Promise<void> {
  const targets = ['Tereza Costa Rêgo', 'Farnese de Andrade', 'Wellington Virgolino'];
  for (const name of targets) {
    const artist = await artistOps.findByNormalizedName(name);
    if (!artist?.id) {
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
  }
}

async function prepareForcePivotTargets(): Promise<void> {
  const targets = ['Hamurabi Batista', 'Chico da Silva'];
  for (const name of targets) {
    const artist = await artistOps.findByNormalizedName(name);
    if (!artist?.id) {
      continue;
    }
    const metadata = artistOps.parseMetadata(artist);
    delete metadata.hard_failure_quarantine_at;
    delete metadata.hard_failure_quarantine_reason;
    delete metadata.skipped_asset_quality_at;
    delete metadata.skipped_asset_quality_reason;
    delete metadata.last_failure_reason;
    delete metadata.last_failure_at;
    await artistOps.updateMetadata(artist.id, metadata);
    await artistOps.resetFailureCount(artist.id);
    await artistOps.updateStatus(artist.id, 'researched');
    await artistOps.updatePriority(artist.id, 100);
  }
}

async function ensureBootstrapTargets(): Promise<void> {
  for (const [name, bootstrap] of Object.entries(BOOTSTRAP_TARGETS)) {
    const existing = await artistOps.findByNormalizedName(name);
    if (!existing?.id) {
      await artistOps.create({
        full_name: name,
        birthplace_city: bootstrap.birth_city,
        birthplace_state: bootstrap.birth_state,
        visual_practice: bootstrap.style,
        status: 'researched',
        metadata: JSON.stringify({
          bio_metadata: {
            birth_year: bootstrap.birth_year,
            birthplace_city: bootstrap.birth_city,
            birthplace_state: bootstrap.birth_state,
          },
          autonomous_sentinel: true,
          pure_context_lock: true,
          force_high_res_mode: isForceHighResRun(),
        }),
        discovered_at: new Date().toISOString(),
        published_at: null,
        last_heartbeat: null,
        priority: bootstrap.priority,
        failure_count: 0,
      });
      continue;
    }

    await artistOps.updatePriority(existing.id, bootstrap.priority);
    await artistOps.mergeMetadata(existing.id, {
      ...(artistOps.parseMetadata(existing) ?? {}),
      autonomous_sentinel: true,
      pure_context_lock: true,
      force_high_res_mode: isForceHighResRun(),
    });
    if (
      existing.status === 'discovered' ||
      existing.status === 'pending_more_sources' ||
      existing.status === 'skipped_asset_quality' ||
      existing.status === 'failed_asset_quality_retry_headless' ||
      existing.status === 'skipped_pure_context_failure' ||
      existing.status === 'failed_permanent' ||
      existing.status === 'rejected'
    ) {
      await artistOps.updateStatus(existing.id, 'researched');
    }
  }
}

async function ensureTargetIsRunnable(targetedArtistName: string | null): Promise<void> {
  if (!targetedArtistName) return;
  const artist = await artistOps.findByNormalizedName(targetedArtistName);
  if (!artist?.id) return;

  const metadata = artistOps.parseMetadata(artist);
  delete metadata.hard_failure_quarantine_at;
  delete metadata.hard_failure_quarantine_reason;
  delete metadata.skipped_asset_quality_at;
  delete metadata.skipped_asset_quality_reason;
  delete metadata.skipped_pure_context_failure_at;
  delete metadata.skipped_pure_context_failure_reason;
  delete metadata.last_failure_reason;
  delete metadata.last_failure_at;
  delete metadata.pending_more_sources_reason;
  delete metadata.pending_more_sources_at;
  await artistOps.updateMetadata(artist.id, metadata);
  await artistOps.resetFailureCount(artist.id);

  if (
    [
      'skipped_asset_quality',
      'failed_asset_quality_retry_headless',
      'skipped_pure_context_failure',
      'hard_failure_quarantine',
      'failed_context_preflight',
      'pending_more_sources',
      'rejected',
    ].includes(artist.status)
  ) {
    await artistOps.updateStatus(artist.id, 'researched');
  }

  await artistOps.updatePriority(artist.id, Math.max(artist.priority ?? 0, 100));
}

function getResearchedQueue(): Artist[] {
  return query.all<Artist>(
    `SELECT *
     FROM artists
     WHERE status = 'researched'
     ORDER BY priority DESC, discovered_at ASC, id ASC`
  );
}

function getEligibleQueue(targetedArtistName: string | null): Artist[] {
  return getResearchedQueue()
    .filter(
      (artist) =>
        ![
          'already_published',
          'skipped_asset_quality',
          'failed_asset_quality_retry_headless',
          'hard_failure_quarantine',
          'skipped_pure_context_failure',
          'failed_context_preflight',
        ].includes(artist.status)
    )
    .filter((artist) => !targetedArtistName || artist.full_name === targetedArtistName)
    .filter((artist) => !isRecentHardFailure(artist));
}

async function runCommand(args: string[]): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn('npx', args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function parseDispatchResult(output: string): DispatchResult | null {
  const match = output.match(/DISPATCH_RESULT\s+(\{.*\})/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as DispatchResult;
  } catch {
    return null;
  }
}

function parseReadyDraftResult(output: string): { draftId: number } | null {
  const match = output.match(/READY_DRAFT\s+(\{.*\})/s);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { draftId?: unknown };
    return typeof parsed.draftId === 'number' ? { draftId: parsed.draftId } : null;
  } catch {
    return null;
  }
}

function parseCurationReason(output: string): string {
  const arrow = [...output.matchAll(/->\s+([^\n]+)/g)].map((match) => match[1].trim());
  if (arrow.length > 0) {
    return arrow[arrow.length - 1];
  }
  const dispatch = parseDispatchResult(output);
  return dispatch?.reason ?? 'unknown-pure-context-failure';
}

async function markSkippedPureContextFailure(artist: Artist, reason: string): Promise<void> {
  if (!artist.id) return;
  await artistOps.updateStatus(artist.id, 'skipped_pure_context_failure');
  await artistOps.updatePriority(artist.id, 0);
  await artistOps.mergeMetadata(artist.id, {
    ...(artistOps.parseMetadata(artist) ?? {}),
    skipped_pure_context_failure_at: new Date().toISOString(),
    skipped_pure_context_failure_reason: reason,
  });
}

async function markSkippedAssetQuality(artist: Artist, reason: string): Promise<void> {
  if (!artist.id) return;
  await artistOps.updateStatus(artist.id, 'hard_failure_quarantine');
  await artistOps.updatePriority(artist.id, 0);
  await artistOps.mergeMetadata(artist.id, {
    ...(artistOps.parseMetadata(artist) ?? {}),
    skipped_asset_quality_at: new Date().toISOString(),
    skipped_asset_quality_reason: reason,
    hard_failure_quarantine_at: new Date().toISOString(),
    hard_failure_quarantine_reason: reason,
  });
}

function isIdentityCollisionReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    normalized.includes('identity-collision') ||
    normalized.includes('poeta') ||
    normalized.includes('poesia') ||
    normalized.includes('poema') ||
    normalized.includes('literatura') ||
    normalized.includes('book page') ||
    normalized.includes('document scan') ||
    normalized.includes('text-first artifact') ||
    normalized.includes('nilo')
  );
}

async function markIdentityCollisionAttempt(artist: Artist, reason: string): Promise<boolean> {
  if (!artist.id) return false;
  const existingMetadata = artistOps.parseMetadata(artist) ?? {};
  const attempts = Number(existingMetadata.identity_collision_attempts ?? 0) + 1;
  const quarantineDays = 7;
  const nextMetadata = {
    ...existingMetadata,
    identity_collision_attempts: attempts,
    identity_collision_last_reason: reason,
    identity_collision_last_at: new Date().toISOString(),
  };

  if (attempts >= 2) {
    await artistOps.updateStatus(artist.id, 'hard_failure_quarantine');
    await artistOps.updatePriority(artist.id, 0);
    await artistOps.mergeMetadata(artist.id, {
      ...nextMetadata,
      hard_failure_quarantine_at: new Date().toISOString(),
      hard_failure_quarantine_reason: `identity-collision:${reason}`,
      hard_failure_quarantine_days: quarantineDays,
    });
    return true;
  }

  await artistOps.updateStatus(artist.id, 'skipped_pure_context_failure');
  await artistOps.updatePriority(artist.id, 0);
  await artistOps.mergeMetadata(artist.id, nextMetadata);
  return false;
}

function isRecentHardFailure(artist: Artist): boolean {
  const metadata = artistOps.parseMetadata(artist);
  const timestamp =
    metadata.hard_failure_quarantine_at ??
    metadata.skipped_asset_quality_at ??
    metadata.skipped_pure_context_failure_at;

  if (!timestamp) return false;
  const then = Date.parse(String(timestamp));
  if (!Number.isFinite(then)) return false;
  const quarantineDays = Number(metadata.hard_failure_quarantine_days ?? 2);
  return Date.now() - then < quarantineDays * 24 * 60 * 60 * 1000;
}

function isAssetQualityFailure(output: string, reason: string): boolean {
  const text = `${output}\n${reason}`.toLowerCase();
  return (
    text.includes('resolution too small') ||
    text.includes('file too small') ||
    text.includes('thumbnail') ||
    text.includes('minimum 600px') ||
    text.includes('minimum 1200px') ||
    text.includes('quality warning') ||
    text.includes('low-res') ||
    text.includes('low resolution')
  );
}

async function markAlreadyPublishedFromSitemap(artists: Artist[]): Promise<number> {
  const cache = loadSitemapCache();
  let matched = 0;

  for (const artist of artists) {
    if (!artist.id) {
      continue;
    }
    const matchedEntry = cache.find((entry) => sitemapEntryMatchesArtist(artist.full_name, entry));
    if (!matchedEntry) {
      continue;
    }
    await artistOps.updateStatus(artist.id, 'already_published');
    await artistOps.updatePriority(artist.id, 0);
    await artistOps.mergeMetadata(artist.id, {
      ...(artistOps.parseMetadata(artist) ?? {}),
      already_published_at: new Date().toISOString(),
      already_published_source: 'sitemap_fuzzy',
      already_published_slug: matchedEntry.slug,
      already_published_url: matchedEntry.url,
    });
    matched += 1;
  }

  return matched;
}

function printNecropsy(rows: NecropsyRow[]): void {
  if (rows.length === 0) {
    return;
  }

  console.log('\nNECROPSY');
  console.log('Artist Name | Status | Failure Reason');
  console.log('--- | --- | ---');
  for (const row of rows) {
    console.log(`${row.artistName} | ${row.status} | ${row.reason}`);
  }
}

async function buildAttemptTruthLog(
  artist: Artist,
  sitemapMatch: boolean,
  visionGateReason: string
): Promise<AttemptTruthLog> {
  const refreshed = artist.id ? await artistOps.findById(artist.id) : artist;
  const drafts = artist.id ? await draftOps.findByArtistId(artist.id) : [];
  const rankedDrafts = [...drafts].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

  let imagesFoundCount = 0;
  let researchWordCount = 0;

  for (const draft of rankedDrafts) {
    if (draft.images) {
      try {
        const parsed = JSON.parse(draft.images) as unknown[];
        if (Array.isArray(parsed)) {
          imagesFoundCount = Math.max(imagesFoundCount, parsed.length);
        }
      } catch {
        // ignore malformed image JSON for truth log purposes
      }
    }

    if (draft.content?.trim()) {
      researchWordCount = Math.max(
        researchWordCount,
        draft.content
          .trim()
          .split(/\s+/)
          .filter(Boolean).length
      );
    }
  }

  const metadata = artistOps.parseMetadata(refreshed);
  if (imagesFoundCount === 0 && Array.isArray(metadata.almost_ready_candidates)) {
    imagesFoundCount = metadata.almost_ready_candidates.length;
  }

  return {
    artist_name: artist.full_name,
    sitemap_match: sitemapMatch,
    images_found_count: imagesFoundCount,
    vision_gate_reason: visionGateReason,
    research_word_count: researchWordCount,
  };
}

async function runUntilSuccess(): Promise<string | null> {
  await ensureBootstrapTargets();
  await ensureTargetIsRunnable(parseTargetArgument());
  if (isForceResetRun()) {
    await forceResetTargets();
  }
  if (isForcePivotRun()) {
    await prepareForcePivotTargets();
  }
  const targetedArtistName = parseTargetArgument();
  const necropsy: NecropsyRow[] = [];
  let replenished = false;

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const syncResult = await syncPublicationHistoryFromSitemap();
    if (isVerboseRun()) {
      console.log(`SITEMAP_SYNC urls=${syncResult.urls} names=${syncResult.synced}`);
    }

    const researchedQueue = getResearchedQueue();
    const fuzzyBlocked = await markAlreadyPublishedFromSitemap(researchedQueue);
    if (isVerboseRun()) {
      console.log(`SITEMAP_FUZZY_BLOCKED ${fuzzyBlocked}`);
    }

    const queue = getEligibleQueue(targetedArtistName);
    if (queue.length === 0 && !targetedArtistName && !replenished) {
      const replenish = await replenishWithExa();
      replenished = true;
      if (isVerboseRun()) {
        console.log(
          `EXA_REPLENISH inserted=${replenish.inserted} published=${replenish.skippedPublished} existing=${replenish.skippedExisting} unverified=${replenish.skippedUnverified}`
        );
        if (replenish.insertedNames.length > 0) {
          console.log(`EXA_REPLENISH_NAMES ${replenish.insertedNames.join(', ')}`);
        }
      }
      continue;
    }

    for (const queueArtist of queue) {
      if (!queueArtist.id) {
        continue;
      }

      let artist = (await artistOps.findById(queueArtist.id)) ?? queueArtist;
      const sourceCount = artist.id ? await sourceOps.countForArtist(artist.id) : 0;
      const metadata = artistOps.parseMetadata(artist);
      if (artist.id && (metadata.research_refresh_required === true || sourceCount === 0)) {
        await artistOps.updateStatus(artist.id, 'discovered');
        await artistOps.mergeMetadata(artist.id, {
          ...metadata,
          research_refresh_required: false,
          exa_replenished: metadata.exa_replenished ?? false,
        });
        artist = (await artistOps.findById(artist.id)) ?? artist;
      }
    if (!artist.id) {
      continue;
    }

    const sitemapMatch =
      loadSitemapCache().some((entry) => sitemapEntryMatchesArtist(artist.full_name, entry)) ||
      (await publicationHistoryOps.isPublished(artist.full_name));

    if (await publicationHistoryOps.isPublished(artist.full_name)) {
      await artistOps.updateStatus(artist.id, 'already_published');
      await artistOps.updatePriority(artist.id, 0);
      const truthLog = await buildAttemptTruthLog(
        artist,
        sitemapMatch,
        'sitemap/publication_history match'
      );
      console.log(JSON.stringify(truthLog));
      necropsy.push({
        artistName: artist.full_name,
        status: 'already_published',
        reason: 'sitemap/publication_history match',
      });
      continue;
    }

    await workerHeartbeatOps.touch(
      'autonomous-sentinel',
      `processing:${artist.full_name}:${artist.priority ?? 0}`
    );

    try {
      const args = [
        'tsx',
        'scripts/force-diamond-run.ts',
        `--target=${artist.full_name}`,
        '--pure-context-lock',
      ];
      if (isForceHighResRun()) {
        args.push('--force-high-res');
      }
      if (process.argv.includes('--use-4k-render')) {
        args.push('--use-4k-render');
        args.push('--use-browser-render');
      }
      if (process.argv.includes('--force-dispatch')) {
        args.push('--force-dispatch');
      }
      if (isHydrateOnlyRun()) {
        args.push('--hydrate-only');
      }

      const result = await runCommand(args);
      const dispatch = parseDispatchResult(result.output);
      const readyDraft = parseReadyDraftResult(result.output);
      const reason = parseCurationReason(result.output);
      const truthLog = await buildAttemptTruthLog(artist, sitemapMatch, reason);
      console.log(JSON.stringify(truthLog));

      if (readyDraft) {
        console.log(`READY_DRAFT ${JSON.stringify({ artistId: artist.id, artistName: artist.full_name, draftId: readyDraft.draftId })}`);
        return `ready:${readyDraft.draftId}`;
      }

      if (dispatch?.sent && dispatch.emailId) {
        console.log(dispatch.emailId);
        return dispatch.emailId;
      }

      if (isAssetQualityFailure(result.output, reason)) {
        await markSkippedAssetQuality(artist, reason);
        necropsy.push({
          artistName: artist.full_name,
          status: 'hard_failure_quarantine',
          reason,
        });
        continue;
      }

      if (isIdentityCollisionReason(reason)) {
        const quarantined = await markIdentityCollisionAttempt(artist, reason);
        necropsy.push({
          artistName: artist.full_name,
          status: quarantined ? 'hard_failure_quarantine' : 'skipped_pure_context_failure',
          reason: quarantined ? `identity-collision-twice:${reason}` : `identity-collision-once:${reason}`,
        });
        continue;
      }

      await markSkippedPureContextFailure(artist, reason);
      necropsy.push({
        artistName: artist.full_name,
        status: 'skipped_pure_context_failure',
        reason,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const truthLog = await buildAttemptTruthLog(artist, sitemapMatch, reason);
      console.log(JSON.stringify(truthLog));
      await markSkippedPureContextFailure(artist, reason);
      necropsy.push({
        artistName: artist.full_name,
        status: 'skipped_pure_context_failure',
        reason,
      });
    }
  }

    if (!targetedArtistName && !replenished) {
      const replenish = await replenishWithExa();
      replenished = true;
      if (isVerboseRun()) {
        console.log(
          `EXA_REPLENISH inserted=${replenish.inserted} published=${replenish.skippedPublished} existing=${replenish.skippedExisting} unverified=${replenish.skippedUnverified}`
        );
      }
      continue;
    }

    break;
  }

  printNecropsy(necropsy);
  throw new Error(`AUTONOMOUS_SENTINEL_FAILED ${JSON.stringify(necropsy)}`);
}

async function main(): Promise<void> {
  initDatabase();
  try {
    if (!isHeadlessRun() && !parseTargetArgument() && !isForceHighResRun()) {
      throw new Error('autonomous-sentinel requires --headless, --force-high-res, or an explicit --target');
    }
    await workerHeartbeatOps.touch('autonomous-sentinel', 'start');
    const emailId = await runUntilSuccess();
    if (!emailId) {
      process.exitCode = 1;
    }
  } finally {
    await workerHeartbeatOps.touch('autonomous-sentinel', 'stop');
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
