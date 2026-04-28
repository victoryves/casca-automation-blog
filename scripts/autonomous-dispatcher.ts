#!/usr/bin/env tsx

import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config/index.js';
import { closeDatabase, initDatabase } from '../src/db/local.js';
import { artistOps, draftOps, publicationHistoryOps, workerHeartbeatOps } from '../src/db/operations/index.js';
import { query } from '../src/db/client.js';
import type { Artist } from '../src/types/index.js';
import { syncPublicationHistoryFromSitemap } from '../src/modules/publication-history/sitemap-sync.js';
import { Dispatcher, EmailModule } from '../src/modules/email/index.js';
import { getConfig } from '../src/config/index.js';

type DispatchResult = {
  sent: boolean;
  draftId?: number;
  artistId?: number;
  artistName?: string;
  emailId?: string;
  reason?: string;
};

const MANUAL_FRONTLOAD = ['Wellington Virgolino', 'Tereza Costa Rêgo', 'Reynaldo Fonseca', 'Cícero Dias'];
const SHORTLIST_LIMIT = 10;
const FORCED_ALREADY_PUBLISHED = [
  'João Câmara',
  'Rubem Valentim',
  'Antonio Dias',
  'Vicente do Rego Monteiro',
];
const TARGET_BIOSTRAP: Record<
  string,
  { birth_year: string; birth_city: string; birth_state: string; style: string; forceExternalSources?: boolean }
> = {
  'Wellington Virgolino': {
    birth_year: '1929',
    birth_city: 'Recife',
    birth_state: 'Pernambuco',
    style: 'Flat/High-Contrast Painting',
    forceExternalSources: true,
  },
  'Tereza Costa Rêgo': {
    birth_year: '1929',
    birth_city: 'Recife',
    birth_state: 'Pernambuco',
    style: 'Flat/High-Contrast Painting',
  },
  'Cícero Dias': {
    birth_year: '1907',
    birth_city: 'Escada',
    birth_state: 'Pernambuco',
    style: 'Flat modernist painting',
  },
  'Delson Uchôa': {
    birth_year: '1955',
    birth_city: 'Maceió',
    birth_state: 'Alagoas',
    style: 'Flat geometric painting',
  },
};

function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

async function ensureBootstrapTargets(): Promise<void> {
  for (const [name, bootstrap] of Object.entries(TARGET_BIOSTRAP)) {
    const artist = await artistOps.findByNormalizedName(name);
    if (!artist?.id) {
      await artistOps.create({
        full_name: name,
        birthplace_city: bootstrap.birth_city,
        birthplace_state: bootstrap.birth_state,
        visual_practice: bootstrap.style,
        status: 'discovered',
        metadata: JSON.stringify({
          bio_metadata: {
            birth_year: bootstrap.birth_year,
            birthplace_city: bootstrap.birth_city,
            birthplace_state: bootstrap.birth_state,
          },
          force_external_sources: Boolean(bootstrap.forceExternalSources),
          autonomous_frontload: true,
        }),
        discovered_at: new Date().toISOString(),
        published_at: null,
        last_heartbeat: null,
        priority: 95,
        failure_count: 0,
      });
      continue;
    }

    await artistOps.updatePriority(artist.id, 95);
    await artistOps.mergeMetadata(artist.id, {
      ...(artistOps.parseMetadata(artist) ?? {}),
      force_external_sources: Boolean(bootstrap.forceExternalSources),
      autonomous_frontload: true,
    });
  }
}

async function markAlreadyPublished(name: string, reasonSource = 'sitemap_xml'): Promise<void> {
  let artist = await artistOps.findByNormalizedName(name);
  if (!artist?.id) {
    const createdId = await artistOps.create({
      full_name: name,
      status: 'already_published',
      metadata: JSON.stringify({
        already_published_at: new Date().toISOString(),
        already_published_source: reasonSource,
      }),
      discovered_at: new Date().toISOString(),
      published_at: null,
      last_heartbeat: null,
      priority: 0,
      failure_count: 0,
    });
    artist = await artistOps.findById(createdId);
  }
  if (!artist?.id) return;
  await artistOps.updateStatus(artist.id, 'already_published');
  await artistOps.updatePriority(artist.id, 0);
  await artistOps.mergeMetadata(artist.id, {
    ...(artistOps.parseMetadata(artist) ?? {}),
    already_published_at: new Date().toISOString(),
    already_published_source: reasonSource,
  });
}

function getResearchedShortlist(limit = SHORTLIST_LIMIT): Artist[] {
  return query.all<Artist>(
    `SELECT *
     FROM artists
     WHERE status IN ('ready_to_send', 'researched', 'curated', 'verified', 'discovered', 'pending_more_sources')
       AND status NOT IN ('review_later', 'rejected', 'rejected_by_head_of_art', 'rejected_duplicate_external', 'skipped_asset_quality', 'failed_context_preflight', 'failed_permanent')
     ORDER BY priority DESC, discovered_at ASC, id ASC
     LIMIT ?`,
    [limit]
  );
}

async function buildAttemptQueue(targetName?: string | null): Promise<Artist[]> {
  await ensureBootstrapTargets();
  const sitemapResult = await syncPublicationHistoryFromSitemap();
  console.log(`GLOBAL_ARCHIVE_SYNC urls=${sitemapResult.urls} names=${sitemapResult.synced}`);

  for (const name of FORCED_ALREADY_PUBLISHED) {
    if (await publicationHistoryOps.isPublished(name)) {
      await markAlreadyPublished(name, 'sitemap_xml');
    }
  }

  const manual: Artist[] = [];
  const desiredFrontload = targetName ? [targetName, ...MANUAL_FRONTLOAD] : MANUAL_FRONTLOAD;
  for (const name of desiredFrontload) {
    if (await publicationHistoryOps.isPublished(name)) {
      continue;
    }
    const artist = await artistOps.findByNormalizedName(name);
    if (artist?.id) {
      manual.push(artist);
    }
  }

  const shortlist = getResearchedShortlist(SHORTLIST_LIMIT * 2);
  const seen = new Set(manual.map((artist) => normalizeName(artist.full_name)));
  const combined = [...manual];
  for (const artist of shortlist) {
    const key = normalizeName(artist.full_name);
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(artist);
    if (combined.length >= SHORTLIST_LIMIT) break;
  }
  let finalQueue = combined.slice(0, SHORTLIST_LIMIT);
  if (targetName) {
    const normalizedTarget = normalizeName(targetName);
    finalQueue = finalQueue.sort((a, b) => {
      const aIsTarget = normalizeName(a.full_name) === normalizedTarget ? 1 : 0;
      const bIsTarget = normalizeName(b.full_name) === normalizedTarget ? 1 : 0;
      return bIsTarget - aIsTarget;
    });
  }
  return finalQueue;
}

async function runCommand(
  args: string[],
  cwd = process.cwd()
): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn('npx', args, {
      cwd,
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
    child.on('close', (code) => {
      resolve({ code, output });
    });
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

function parseSkipReason(output: string): string {
  const arrowLines = [...output.matchAll(/->\s+([^\n]+)/g)].map((match) => match[1].trim());
  if (arrowLines.length > 0) {
    return arrowLines[arrowLines.length - 1];
  }
  const dispatch = parseDispatchResult(output);
  return dispatch?.reason ?? 'unknown';
}

async function markSkippedAssetQuality(artist: Artist, reason: string): Promise<void> {
  if (!artist.id) return;
  await artistOps.updateStatus(artist.id, 'skipped_asset_quality');
  await artistOps.updatePriority(artist.id, 0);
  await artistOps.mergeMetadata(artist.id, {
    ...(artistOps.parseMetadata(artist) ?? {}),
    skipped_asset_quality_at: new Date().toISOString(),
    skipped_asset_quality_reason: reason,
  });
}

async function processArtist(artist: Artist): Promise<DispatchResult> {
  if (artist.id && artist.status === 'ready_to_send') {
    const config = getConfig();
    const dispatcher = new Dispatcher(new EmailModule(config.env.resendApiKey));
    const drafts = await draftOps.findByArtistId(artist.id);
    const readyDraft = drafts.find((draft) => draft.status === 'ready');
    if (readyDraft?.id) {
      return await dispatcher.sendDraft(readyDraft.id, true);
    }
    return { sent: false, reason: 'ready_to_send-without-ready-draft' };
  }

  const isForceExternal = Boolean(artistOps.parseMetadata(artist).force_external_sources);
  const args = ['tsx', 'scripts/force-diamond-run.ts', `--target=${artist.full_name}`];
  if (isForceExternal) {
    args.push('--force-external-sources');
  }
  const result = await runCommand(args);
  return (
    parseDispatchResult(result.output) ?? {
      sent: false,
      reason:
        result.code === 0
          ? parseSkipReason(result.output)
          : `force-diamond-exit-${result.code ?? 'unknown'}`,
    }
  );
}

async function triggerScoutPass(): Promise<void> {
  await runCommand(['tsx', 'scripts/scout-agent.ts', '--once']);
}

async function dispatchUntilSuccess(): Promise<DispatchResult> {
  const targetArg = process.argv.find((value) => value.startsWith('--target='));
  const targetName = targetArg?.split('=')[1]?.trim() || null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await workerHeartbeatOps.touch('autonomous-dispatcher', `attempt:${attempt}:build-shortlist`);
    const shortlist = await buildAttemptQueue(targetName);
    console.log(
      `AUTONOMOUS_SHORTLIST attempt=${attempt}: ${shortlist.map((artist) => artist.full_name).join(', ') || 'none'}`
    );

    for (const artist of shortlist) {
      if (!artist.id) continue;
      if (await publicationHistoryOps.isPublished(artist.full_name)) {
        console.log(`AUTONOMOUS_SKIP published=${artist.full_name}`);
        continue;
      }

      await workerHeartbeatOps.touch(
        'autonomous-dispatcher',
        `attempt:${attempt}:artist:${artist.full_name}`
      );
      const dispatchResult = await processArtist(artist);
      if (dispatchResult.sent) {
        await workerHeartbeatOps.touch(
          'autonomous-dispatcher',
          `sent:${dispatchResult.artistName ?? artist.full_name}:email:${dispatchResult.emailId ?? 'unknown'}`
        );
        return dispatchResult;
      }

      await markSkippedAssetQuality(
        artist,
        dispatchResult.reason ?? 'autonomous-dispatcher:no-send'
      );
      console.log(
        `AUTONOMOUS_SKIP asset_quality=${artist.full_name} reason=${dispatchResult.reason ?? 'unknown'}`
      );
    }

    if (attempt === 1) {
      await workerHeartbeatOps.touch('autonomous-dispatcher', 'attempt:1:scout-refresh');
      await triggerScoutPass();
    }
  }

  return {
    sent: false,
    reason: 'autonomous-dispatcher:shortlist-exhausted',
  };
}

function isContinuousRun(): boolean {
  return process.argv.includes('--continuous-until-success');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  loadConfig();
  initDatabase();
  try {
    let result: DispatchResult;
    if (isContinuousRun()) {
      for (;;) {
        result = await dispatchUntilSuccess();
        if (result.sent) {
          break;
        }
        console.log(`AUTONOMOUS_CONTINUE waiting reason=${result.reason ?? 'unknown'}`);
        await sleep(60_000);
      }
    } else {
      result = await dispatchUntilSuccess();
    }
    console.log(`AUTONOMOUS_DISPATCH_RESULT ${JSON.stringify(result)}`);
    process.exitCode = result.sent ? 0 : 1;
  } finally {
    closeDatabase();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
