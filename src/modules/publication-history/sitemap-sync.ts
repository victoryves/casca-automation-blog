import fs from 'node:fs';
import path from 'node:path';
import { publicationHistoryOps } from '../../db/operations/index.js';

const SITEMAP_URL = 'https://blog.casca-archive.org/sitemap.xml';
const CACHE_PATH = path.join(process.cwd(), 'data', 'sitemap-cache.json');
const FORCED_SITEMAP_NAMES: Record<string, string> = {
  'joao-camara': 'João Câmara',
  'rubem-valentim': 'Rubem Valentim',
  'antonio-dias': 'Antonio Dias',
  'vicente-do-rego-monteiro': 'Vicente do Rego Monteiro',
  'delson-uchoa': 'Delson Uchôa',
  'gilvan-samico': 'Gilvan Samico',
  'lula-cardoso-ayres': 'Lula Cardoso Ayres',
};

export interface SitemapCacheEntry {
  url: string;
  slug: string;
  normalizedSlug: string;
  guessedArtistName: string;
  normalizedGuessedArtistName: string;
}

function slugToReadableTitle(slug: string): string {
  return slug
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeLoose(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getSlugFromUrl(url: string): string {
  const clean = url.replace(/\/+$/, '');
  return clean.split('/').pop() ?? '';
}

function guessArtistNameFromSlug(url: string): string {
  const slug = getSlugFromUrl(url);
  const lowerSlug = slug.toLowerCase();

  for (const [needle, artistName] of Object.entries(FORCED_SITEMAP_NAMES)) {
    if (lowerSlug.includes(needle)) {
      return artistName;
    }
  }

  const readable = slugToReadableTitle(slug);
  if (!readable) {
    return '';
  }

  const stopSignals = [
    ' where ',
    ' and ',
    ' the ',
    ' through ',
    ' from ',
    ' in ',
    ' with ',
    ' at ',
    ' of ',
  ];

  let trimmed = readable;
  for (const stop of stopSignals) {
    const index = readable.toLowerCase().indexOf(stop);
    if (index > 0) {
      trimmed = readable.slice(0, index);
      break;
    }
  }

  const tokens = trimmed.split(' ').filter(Boolean);
  return normalizeWhitespace(tokens.slice(0, 4).join(' '));
}

function getSignificantFragments(artistName: string): string[] {
  const normalized = normalizeLoose(artistName);
  const tokens = normalized.split(' ').filter((token) => token.length >= 3);
  const fragments = new Set<string>();

  if (normalized) {
    fragments.add(normalized);
  }

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]) {
      fragments.add(tokens[i]);
    }
    if (i + 1 < tokens.length) {
      fragments.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    if (i + 2 < tokens.length) {
      fragments.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  }

  return [...fragments].filter((fragment) => fragment.length >= 4);
}

function tokenizeNormalized(value: string): string[] {
  return normalizeLoose(value).split(' ').filter(Boolean);
}

function singularizeToken(token: string): string {
  if (token.endsWith('es') && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith('s') && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function tokensContainStrictIdentity(artistName: string, normalizedSlug: string): boolean {
  const artistTokens = tokenizeNormalized(artistName);
  const slugTokens = tokenizeNormalized(normalizedSlug).map(singularizeToken);
  if (artistTokens.length === 0 || slugTokens.length === 0) {
    return false;
  }

  const firstName = singularizeToken(artistTokens[0] ?? '');
  const lastName = singularizeToken(artistTokens[artistTokens.length - 1] ?? '');
  if (!firstName || !lastName) {
    return false;
  }

  if (artistTokens.length === 1) {
    return slugTokens.includes(firstName);
  }

  return slugTokens.includes(firstName) && slugTokens.includes(lastName);
}

export function sitemapEntryMatchesArtist(
  artistName: string,
  entry: Pick<SitemapCacheEntry, 'normalizedSlug' | 'normalizedGuessedArtistName'>
): boolean {
  const normalizedArtist = normalizeLoose(artistName);
  if (!normalizedArtist) {
    return false;
  }

  if (
    entry.normalizedGuessedArtistName === normalizedArtist ||
    entry.normalizedSlug.includes(normalizedArtist)
  ) {
    return true;
  }

  if (!tokensContainStrictIdentity(artistName, entry.normalizedSlug)) {
    return false;
  }

  const fragments = getSignificantFragments(artistName);
  const normalizedSlug = entry.normalizedSlug;

  let matchedFragments = 0;
  for (const fragment of fragments) {
    if (normalizedSlug.includes(fragment)) {
      matchedFragments += 1;
    }
  }

  return matchedFragments >= 1;
}

async function fetchXml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed sitemap fetch: ${response.status}`);
  }
  return await response.text();
}

async function collectSitemapUrls(url: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(url)) {
    return [];
  }
  seen.add(url);

  const xml = await fetchXml(url);
  const nestedSitemaps = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (/<sitemapindex[\s>]/i.test(xml)) {
    const nestedResults = await Promise.all(
      nestedSitemaps.map((nested) => collectSitemapUrls(nested, seen))
    );
    return nestedResults.flat();
  }

  return nestedSitemaps.filter((entryUrl) => /blog\.casca-archive\.org/i.test(entryUrl));
}

function buildCacheEntries(urls: string[]): SitemapCacheEntry[] {
  return urls.map((url) => {
    const slug = getSlugFromUrl(url);
    const guessedArtistName = guessArtistNameFromSlug(url);
    return {
      url,
      slug,
      normalizedSlug: normalizeLoose(slugToReadableTitle(slug)),
      guessedArtistName,
      normalizedGuessedArtistName: publicationHistoryOps.normalizeArtistName(guessedArtistName),
    };
  });
}

function persistCache(entries: SitemapCacheEntry[]): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(
    CACHE_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        entries,
      },
      null,
      2
    )
  );
}

export function loadSitemapCache(): SitemapCacheEntry[] {
  if (!fs.existsSync(CACHE_PATH)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as {
      entries?: SitemapCacheEntry[];
    };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export async function syncPublicationHistoryFromSitemap(
  sitemapUrl = SITEMAP_URL
): Promise<{ synced: number; urls: number; names: string[]; entries: SitemapCacheEntry[] }> {
  const urls = await collectSitemapUrls(sitemapUrl);
  const entries = buildCacheEntries(urls);
  const names = new Set<string>();

  for (const entry of entries) {
    if (!entry.guessedArtistName || !entry.normalizedGuessedArtistName) {
      continue;
    }
    names.add(entry.guessedArtistName);
    await publicationHistoryOps.upsert({
      artist_name: entry.guessedArtistName,
      normalized_artist_name: entry.normalizedGuessedArtistName,
      post_title: null,
      post_url: entry.url,
      source: 'sitemap_xml',
      published_at: null,
      synced_at: new Date().toISOString(),
    });
  }

  persistCache(entries);
  return { synced: names.size, urls: urls.length, names: [...names], entries };
}
