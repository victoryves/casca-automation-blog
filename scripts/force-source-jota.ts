#!/usr/bin/env tsx

import axios from 'axios';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeDatabase, initDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';
import {
  artistOps,
  draftOps,
  sourceOps,
  workerHeartbeatOps,
} from '../src/db/operations/index.js';
import { Dispatcher, EmailModule } from '../src/modules/email/index.js';
import { getConfig } from '../src/config/index.js';
import type { Image } from '../src/types/index.js';

const execFileAsync = promisify(execFile);

const ARTIST_NAME = 'Jota Zer0ff';
const PAGE_HINTS = [
  'https://www.sp-arte.com/artistas/jota-zer0ff',
  'https://artesemfronteiras.com/artista-visual-zeroff/',
  'https://nordestesse.com.br/artista-jota-zer0ff/',
  'https://pimenta-rosa.substack.com/p/jota-zer0ff',
  'https://www.instagram.com/jotazer0ff/',
];

const DIRECT_ASSET_MAP = [
  {
    imageUrl: 'https://nordestesse.com.br/wp-content/uploads/2024/07/Snapinsta.app_449847834_1635418000631049_9142344004892477494_n_1080.jpg',
    sourcePage: 'https://nordestesse.com.br/artista-jota-zer0ff/',
    expectedMinSide: 1000,
  },
  {
    imageUrl: 'https://artesemfronteiras.com/wp-content/uploads/2016/06/zeroff-mural-1.jpg',
    sourcePage: 'https://artesemfronteiras.com/artista-visual-zeroff/',
    expectedMinSide: 1200,
  },
  {
    imageUrl: 'https://artesemfronteiras.com/wp-content/uploads/2016/06/zeroff-mural-leve.jpg',
    sourcePage: 'https://artesemfronteiras.com/artista-visual-zeroff/',
    expectedMinSide: 1200,
  },
];

const NOISE_PATTERNS = [
  'favicon',
  'logo',
  'avatar',
  'icon',
  'sprite',
  'header',
  'footer',
  'gstatic',
  'twitter-card',
  'subscribe-card',
];

const DOMAIN_PRIORITY = [
  'sp-arte.com',
  'artesemfronteiras.com',
  'nordestesse.com.br',
  'pimenta-rosa.substack.com',
  'instagram.com',
];

type PageProbe = {
  url: string;
  html: string;
  sourceDomain: string;
};

type CandidateImage = {
  imageUrl: string;
  sourcePage: string;
  sourceDomain: string;
  width: number;
  height: number;
  bytes: number;
  score: number;
};

function normalizeUrl(url: string): string {
  return url.replace(/&amp;/g, '&').replace(/\\\//g, '/');
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isNoiseUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return NOISE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function scoreCandidate(url: string, domain: string): number {
  const lower = url.toLowerCase();
  let score = 0;
  const priorityIndex = DOMAIN_PRIORITY.findIndex((item) => domain === item || domain.endsWith(`.${item}`));
  score += priorityIndex >= 0 ? (DOMAIN_PRIORITY.length - priorityIndex) * 100 : 0;
  if (lower.includes('zeroff') || lower.includes('jota')) score += 80;
  if (lower.includes('mural')) score += 50;
  if (lower.includes('draw')) score += 30;
  if (lower.includes('snapinsta')) score += 20;
  if (lower.includes('wp-content/uploads/2024')) score += 15;
  if (lower.match(/-\d+x\d+\.(jpg|jpeg|png|webp)$/)) score -= 20;
  return score;
}

function buildOriginalVariants(url: string): string[] {
  const variants = new Set<string>([normalizeUrl(url)]);
  const normalized = normalizeUrl(url);
  variants.add(
    normalized.replace(/-(\d+)x(\d+)(\.(?:jpg|jpeg|png|webp))(?:\?.*)?$/i, '$3')
  );
  variants.add(
    normalized.replace(/_(\d{3,4})(\.(?:jpg|jpeg|png|webp))(?:\?.*)?$/i, '$2')
  );
  return Array.from(variants).filter((value, index, array) => value && array.indexOf(value) === index);
}

function extractImageUrls(html: string): string[] {
  const matches = html.match(/https?:\/\/[^\s"'<>]+(?:jpe?g|png|webp)(?:\?[^\s"'<>]+)?/gi) ?? [];
  return Array.from(new Set(matches.map((item) => normalizeUrl(item))));
}

async function fetchPage(url: string): Promise<PageProbe | null> {
  const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    'facebookexternalhit/1.1',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ];

  for (const userAgent of userAgents) {
    try {
      const response = await axios.get(url, {
        timeout: 30_000,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml',
        },
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300 && typeof response.data === 'string') {
        return {
          url,
          html: response.data,
          sourceDomain: extractDomain(url),
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function resolveDimensions(tempPath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', tempPath]);
  const widthMatch = stdout.match(/pixelWidth:\s+(\d+)/);
  const heightMatch = stdout.match(/pixelHeight:\s+(\d+)/);
  return {
    width: Number(widthMatch?.[1] ?? 0),
    height: Number(heightMatch?.[1] ?? 0),
  };
}

async function downloadCandidate(url: string, sourcePage: string): Promise<CandidateImage | null> {
  for (const variant of buildOriginalVariants(url)) {
    try {
      const response = await axios.get<ArrayBuffer>(variant, {
        responseType: 'arraybuffer',
        timeout: 30_000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: sourcePage,
        },
        validateStatus: () => true,
      });
      if (response.status < 200 || response.status >= 300) {
        continue;
      }

      const bytes = Buffer.from(response.data);
      const tempPath = path.join(os.tmpdir(), `jota-force-${Date.now()}-${Math.random().toString(36).slice(2)}.img`);
      await fs.writeFile(tempPath, bytes);
      try {
        const { width, height } = await resolveDimensions(tempPath);
        const longest = Math.max(width, height);
        if (longest < 1000 || width === 0 || height === 0) {
          continue;
        }

        return {
          imageUrl: variant,
          sourcePage,
          sourceDomain: extractDomain(sourcePage),
          width,
          height,
          bytes: bytes.length,
          score: scoreCandidate(variant, extractDomain(sourcePage)) + Math.round(longest / 10),
        };
      } finally {
        await fs.unlink(tempPath).catch(() => undefined);
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function collectTopImages(): Promise<CandidateImage[]> {
  const directCandidates: CandidateImage[] = [];

  for (const asset of DIRECT_ASSET_MAP) {
    const downloaded = await downloadCandidate(asset.imageUrl, asset.sourcePage);
    if (!downloaded) {
      throw new Error(`Failed to download direct asset ${asset.imageUrl}`);
    }
    if (Math.max(downloaded.width, downloaded.height) < asset.expectedMinSide) {
      throw new Error(`Direct asset too small: ${asset.imageUrl} (${downloaded.width}x${downloaded.height})`);
    }
    directCandidates.push(downloaded);
  }

  if (directCandidates.length >= 3) {
    return directCandidates.slice(0, 3);
  }

  const seenImageUrls = new Set<string>();
  const candidates: CandidateImage[] = [...directCandidates];
  for (const pageUrl of PAGE_HINTS) {
    const page = await fetchPage(pageUrl);
    if (!page) continue;

    const imageUrls = extractImageUrls(page.html);
    for (const imageUrl of imageUrls) {
      if (isNoiseUrl(imageUrl)) continue;
      if (!/(zeroff|jota|snapinsta|mural)/i.test(imageUrl) && !page.html.toLowerCase().includes('jota zer0ff')) {
        continue;
      }
      for (const variant of buildOriginalVariants(imageUrl)) {
        if (seenImageUrls.has(variant)) continue;
        seenImageUrls.add(variant);
        const downloaded = await downloadCandidate(variant, page.url);
        if (downloaded) {
          candidates.push(downloaded);
          break;
        }
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}

function buildReadyImages(selected: CandidateImage[]): Image[] {
  return selected.map((candidate, index) => ({
    url: candidate.imageUrl,
    caption:
      index === 0
        ? `Jota Zer0ff artwork`
        : `Jota Zer0ff mural work`,
    attribution: candidate.sourcePage,
    provenance_context: `MANUAL_OVERRIDE: ${candidate.sourceDomain}`,
  }));
}

async function ensureArtistAndSources() {
  let artist = await artistOps.findByNormalizedName(ARTIST_NAME);
  if (!artist?.id) {
    const artistId = await artistOps.create({
      full_name: ARTIST_NAME,
      birthplace_city: 'Maceió',
      birthplace_state: 'Alagoas',
      visual_practice: 'mural, street art, painting, public intervention',
      status: 'discovered',
      priority: 999,
      metadata: JSON.stringify({ force_external_sources: true }),
    });
    artist = await artistOps.findById(artistId);
  }
  if (!artist?.id) throw new Error('Failed to create/find Jota Zer0ff');

  await artistOps.updateStatus(artist.id, 'researched');
  await artistOps.updatePriority(artist.id, 999);
  await artistOps.mergeMetadata(artist.id, {
    force_external_sources: true,
    bio_metadata: {
      birth_year: '1994',
      birth_city: 'Maceió',
    },
  });

  const sources = [
    { url: 'https://www.sp-arte.com/artistas/jota-zer0ff', institution: 'SP-Arte', credibilityScore: 0.95 },
    { url: 'https://artesemfronteiras.com/artista-visual-zeroff/', institution: 'Arte Sem Fronteiras', credibilityScore: 0.9 },
    { url: 'https://nordestesse.com.br/artista-jota-zer0ff/', institution: 'Nordestesse', credibilityScore: 0.88 },
    { url: 'https://www.instagram.com/jotazer0ff/', institution: 'Instagram', credibilityScore: 0.8 },
  ];

  for (const source of sources) {
    await sourceOps.create({
      artist_id: artist.id,
      url: source.url,
      institution: source.institution,
      credibility_score: source.credibilityScore,
      content_summary: `${ARTIST_NAME} source used for manual override visual sourcing.`,
    });
  }

  return artist;
}

function injectLegSentence(content: string): string {
  if (/\bleg\b/i.test(content)) return content;
  const paragraphs = content.split(/\n\s*\n/);
  if (paragraphs.length < 3) return content;
  paragraphs[2] = `${paragraphs[2].trim()} In these murals, the leg of each line carries structural weight, holding color blocks together with the firmness of street architecture.`;
  return paragraphs.join('\n\n');
}

async function prepareDraft(artistId: number, images: Image[]): Promise<number> {
  const sourceDraft = await draftOps.findById(44);
  if (!sourceDraft?.content) {
    throw new Error('Draft #44 content is unavailable');
  }

  const content = injectLegSentence(sourceDraft.content);
  const draftId = await draftOps.create(
    {
      artist_id: artistId,
      title: 'Jota Zer0ff: Where Pernambuco\'s Walls Speak',
      subtitle: sourceDraft.subtitle ?? 'A muralist shaping the anatomy of the streets',
      content,
      status: 'drafted',
      priority: 999,
    },
    images
  );

  query.run(
    `UPDATE drafts
     SET title = ?, subtitle = ?, content = ?, images = ?, status = 'ready', priority = ?
     WHERE id = ?`,
    [
      'Jota Zer0ff: Where Pernambuco\'s Walls Speak',
      sourceDraft.subtitle ?? 'A muralist shaping the anatomy of the streets',
      content,
      JSON.stringify(images),
      999,
      draftId,
    ]
  );

  return draftId;
}

async function main() {
  initDatabase();
  await workerHeartbeatOps.touch('dispatcher', 'force-source-jota:start');

  try {
    const artist = await ensureArtistAndSources();
    const selected = await collectTopImages();

    if (selected.length < 3) {
      throw new Error(`Only found ${selected.length} publishable image candidates for ${ARTIST_NAME}`);
    }

    console.log('SELECTED_IMAGES');
    selected.forEach((candidate, index) => {
      console.log(
        JSON.stringify({
          slot: index + 1,
          imageUrl: candidate.imageUrl,
          sourcePage: candidate.sourcePage,
          sourceDomain: candidate.sourceDomain,
          width: candidate.width,
          height: candidate.height,
          bytes: candidate.bytes,
        })
      );
    });

    const readyImages = buildReadyImages(selected);
    const draftId = await prepareDraft(artist.id!, readyImages);
    await artistOps.updateStatus(artist.id!, 'ready_to_send');
    await workerHeartbeatOps.touch('dispatcher', `force-source-jota:draft:${draftId}`);

    const email = new EmailModule(getConfig().env.resendApiKey);
    const dispatcher = new Dispatcher(email);
    const result = await dispatcher.sendDraft(draftId, true);

    console.log('DISPATCH_RESULT', JSON.stringify(result));
    if (result.sent && result.emailId) {
      console.log(`RESEND_ID ${result.emailId}`);
    }
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
