#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';
import { artistOps, draftOps } from '../src/db/operations/index.js';
import type { Draft, Image } from '../src/types/index.js';

const DEFAULT_TARGETS = ['Paulo dos Santos'];

function parseStatus(): 'researched' | 'discovered' {
  const flag = process.argv.find((value) => value.startsWith('--status='));
  const value = flag?.split('=')[1]?.trim().toLowerCase();
  return value === 'discovered' ? 'discovered' : 'researched';
}

function parseTargets(): string[] {
  const cliTargets = process.argv
    .slice(2)
    .filter((value) => !value.startsWith('--status='))
    .map((value) => value.trim())
    .filter(Boolean);
  return cliTargets.length > 0 ? cliTargets : DEFAULT_TARGETS;
}

function parseImages(draft: Draft): Image[] {
  if (!draft.images) return [];
  try {
    const parsed = JSON.parse(draft.images);
    return Array.isArray(parsed) ? (parsed as Image[]) : [];
  } catch {
    return [];
  }
}

function hasInstitutionalVerifiedImage(images: Image[]): boolean {
  return images.some((image) =>
    (image.provenance_context ?? '').startsWith('INSTITUTIONAL_VERIFIED:')
  );
}

async function resetArtistIfCorrupted(
  artistName: string,
  targetStatus: 'researched' | 'discovered'
): Promise<void> {
  const artist = await artistOps.findByNormalizedName(artistName);
  if (!artist?.id) {
    console.log(`skip:${artistName}:not-found`);
    return;
  }

  const drafts = await draftOps.findByArtistId(artist.id);
  const affectedDrafts = drafts.filter((draft) => {
    if (!['ready', 'curated', 'drafted', 'researched', 'pending'].includes(draft.status)) {
      return false;
    }
    return !hasInstitutionalVerifiedImage(parseImages(draft));
  });

  if (affectedDrafts.length === 0) {
    console.log(`skip:${artist.full_name}:no-corrupted-drafts`);
    return;
  }

  for (const draft of affectedDrafts) {
    if (!draft.id) continue;
    await draftOps.delete(draft.id);
  }

  await artistOps.updateStatus(artist.id, targetStatus);
  await artistOps.resetFailureCount(artist.id);
  await artistOps.mergeMetadata(artist.id, {
    curated: false,
    almost_ready_draft_id: null,
    almost_ready_candidates: [],
    almost_ready_last_reason: null,
    last_failure_reason: null,
    last_failure_at: null,
    hard_reset_at: new Date().toISOString(),
  });

  query.run(
    `UPDATE artists
     SET priority = CASE WHEN priority < 85 THEN 85 ELSE priority END
     WHERE id = ?`,
    [artist.id]
  );

  console.log(
    `reset:${artist.full_name}:status=${targetStatus}:drafts=${affectedDrafts.map((draft) => draft.id).filter(Boolean).join(',')}`
  );
}

async function main(): Promise<void> {
  initDatabase();
  try {
    const targetStatus = parseStatus();
    const targets = parseTargets();
    for (const target of targets) {
      await resetArtistIfCorrupted(target, targetStatus);
    }
  } finally {
    closeDatabase();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
