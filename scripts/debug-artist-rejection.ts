import fs from 'node:fs/promises';
import path from 'node:path';
import { artistOps, draftOps, sourceOps } from '../src/db/operations/index.js';
import { PublicationHistoryModule } from '../src/modules/publication-history/index.js';
import { SynthesisModule } from '../src/modules/synthesis/index.js';
import { getConfig } from '../src/config/index.js';
import { closeDatabase, initDatabase } from '../src/db/local.js';

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

async function loadPublicationCache() {
  const cachePath = path.join(process.cwd(), 'data', 'publication-history-cache.json');
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      entries?: Array<{ title?: string; url?: string; description?: string }>;
    };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function main() {
  initDatabase();
  const artistName = process.argv.slice(2).join(' ').trim() || 'Vicente do Rego Monteiro';
  const artist = await artistOps.findByNormalizedName(artistName);

  if (!artist?.id) {
    console.error(`Artist not found: ${artistName}`);
    process.exit(1);
  }

  const drafts = await draftOps.findByArtistId(artist.id);
  const sources = await sourceOps.findByArtistId(artist.id);
  const publicationHistory = new PublicationHistoryModule({
    rssUrl: getConfig().env.rssUrl,
    hashnodeApiKey: getConfig().env.hashnodeApiKey,
    hashnodePublicationId: getConfig().env.hashnodePublicationId,
  });
  const normalizedArtist = normalizeText(artist.full_name);
  const haystacks = await publicationHistory.getPublishedPostHaystacks();
  const duplicateDetected = haystacks.some((haystack) => haystack.includes(normalizedArtist));
  const cacheEntries = await loadPublicationCache();
  const matchingEntries = cacheEntries.filter((entry) =>
    normalizeText(`${entry.title ?? ''} ${entry.description ?? ''} ${entry.url ?? ''}`).includes(normalizedArtist)
  );

  console.log(`\n=== Artist Rejection Debug ===`);
  console.log(`Artist: ${artist.full_name}`);
  console.log(`Artist ID: ${artist.id}`);
  console.log(`Status: ${artist.status}`);
  console.log(`Priority: ${artist.priority}`);
  console.log(`Failure Count: ${artist.failure_count}`);
  console.log(`Sources: ${sources.length}`);
  console.log(`Drafts: ${drafts.length}`);
  console.log(`Duplicate in publication history: ${duplicateDetected ? 'YES' : 'NO'}`);

  if (matchingEntries.length > 0) {
    console.log(`\nMatching publication history entries:`);
    for (const entry of matchingEntries.slice(0, 5)) {
      console.log(`- ${entry.title ?? '(untitled)'}`);
      console.log(`  URL: ${entry.url ?? 'n/a'}`);
    }
  }

  console.log(`\nDraft diagnostics:`);
  for (const draft of drafts) {
    console.log(
      `- Draft #${draft.id} | status=${draft.status} | words=${wordCount(draft.content)} | title=${draft.title}`
    );
  }

  const underfilledDraft = drafts
    .filter((draft) => draft.status !== 'sent' && draft.status !== 'approved')
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
    .find((draft) => wordCount(draft.content) < 450);

  if (duplicateDetected) {
    console.log(
      `\nResult: rejection is a legitimate duplicate block. No rescue performed. See matching URL above.`
    );
    return;
  }

  if (!underfilledDraft) {
    console.log(`\nResult: no duplicate found and no underfilled draft found.`);
    return;
  }

  console.log(
    `\nUnderfilled draft detected (#${underfilledDraft.id}, ${wordCount(underfilledDraft.content)} words). Re-synthesizing with hyper-expansion.`
  );

  await artistOps.updateStatus(artist.id, 'researched');
  const synthesis = new SynthesisModule(getConfig().env.geminiApiKey);
  const result = await synthesis.synthesize(artist.id);
  const words = wordCount(result.draft.content);

  console.log(`\n=== Hyper-Expanded Draft Preview ===`);
  console.log(`Title: ${result.draft.title}`);
  console.log(`Words: ${words}`);
  console.log(result.draft.content);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => {
  closeDatabase();
});
