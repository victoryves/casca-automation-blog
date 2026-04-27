#!/usr/bin/env tsx

import path from 'node:path';
import {
  loadConfig,
  getConfig,
  getInstitutionCredibility,
  getInstitutionName,
} from '../src/config/index.js';
import { initDatabase, closeDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';
import { SEED_ARTISTS, type SeedArtist } from '../src/modules/discovery/seed-artists.js';
import { TavilyClient } from '../src/modules/discovery/tavily-client.js';
import { PublicationHistoryModule } from '../src/modules/publication-history/index.js';
import { ScraperBridge } from '../src/modules/scraper-bridge/index.js';
import {
  ArtistResearchCache,
  type ArtistResearchCacheEntry,
  type ArtworkResearchCandidate,
  type BiographyResearchSource,
} from '../src/modules/research-cache/index.js';
import type { TavilySearchResult } from '../src/types/index.js';

interface CliOptions {
  limit: number;
  offset: number;
  force: boolean;
}

const DEFAULT_LIMIT = 20;
const BIOGRAPHY_SOURCE_LIMIT = 3;
const ARTWORK_CANDIDATE_LIMIT = 5;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  initDatabase();

  try {
    const cache = new ArtistResearchCache();
    const tavily = new TavilyClient(config.env.tavilyApiKey);
    const publicationHistory = new PublicationHistoryModule({
      rssUrl: config.env.rssUrl,
      hashnodeApiKey: config.env.hashnodeApiKey,
      hashnodePublicationId: config.env.hashnodePublicationId,
    });
    const scraperBridge = new ScraperBridge();
    const publishedHaystacks = await publicationHistory.getPublishedPostHaystacks();
    const cachedEntries = await cache.readAll();
    const cachedArtistNames = new Set(
      cachedEntries.map((entry) => normalizeName(entry.artistName))
    );

    const prioritized = [...SEED_ARTISTS].sort((a, b) => compareSeedPriority(a, b));
    const candidatePool = options.force
      ? prioritized
      : prioritized.filter((seed) => !cachedArtistNames.has(normalizeName(seed.name)));
    const shortlist = candidatePool.slice(options.offset, options.offset + options.limit);

    console.log(`\n🔎 Pre-mining shortlist (${shortlist.length} artists)\n`);
    if (!options.force) {
      console.log(
        `↳ Candidate pool filtered to ${candidatePool.length} still-unmined artist(s) before slicing`
      );
    }

    let completed = 0;
    for (let index = 0; index < shortlist.length; index++) {
      const seed = shortlist[index];
      const existing = await cache.findByArtistName(seed.name);
      if (existing && !options.force) {
        console.log(`↷ Skipping cached artist: ${seed.name}`);
        continue;
      }

      const shortlistRank = options.offset + index + 1;
      console.log(`\n[${shortlistRank}] ${seed.name}`);

      const repetition = getRepetitionStatus(seed.name, publishedHaystacks);
      const biographySources = await preMineBiographySources(seed, tavily, scraperBridge);
      const artworkCandidates = await preMineArtworkCandidates(seed, scraperBridge, biographySources);
      const notes = buildNotes(repetition, biographySources, artworkCandidates);

      const entry: ArtistResearchCacheEntry = {
        artistName: seed.name,
        states: seed.states,
        practice: seed.practice,
        category: seed.category,
        shortlistRank,
        minedAt: new Date().toISOString(),
        repetition,
        biographySources,
        artworkCandidates,
        notes,
      };

      await cache.upsert(entry);
      completed += 1;

      console.log(
        `  ✓ Cached biography=${biographySources.length} artworkCandidates=${artworkCandidates.length} eligible=${repetition.eligible ? 'yes' : 'no'}`
      );
    }

    console.log(`\n✅ Pre-mining complete. Updated ${completed} cache entries.`);
    console.log(
      `📁 Cache file: ${path.resolve(process.cwd(), 'data', 'artist-research-cache.json')}`
    );
  } finally {
    closeDatabase();
  }
}

function parseArgs(args: string[]): CliOptions {
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  let force = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--limit') {
      limit = Number(args[index + 1] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
      index += 1;
      continue;
    }
    if (arg === '--offset') {
      offset = Number(args[index + 1] ?? 0) || 0;
      index += 1;
      continue;
    }
    if (arg === '--force') {
      force = true;
    }
  }

  return {
    limit: Math.max(1, limit),
    offset: Math.max(0, offset),
    force,
  };
}

function compareSeedPriority(a: SeedArtist, b: SeedArtist): number {
  const scoreDelta = seedPriorityScore(b) - seedPriorityScore(a);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const tokenDelta = seedDistinctiveTokenCount(b.name) - seedDistinctiveTokenCount(a.name);
  if (tokenDelta !== 0) {
    return tokenDelta;
  }

  return a.name.localeCompare(b.name, 'pt-BR');
}

function seedPriorityScore(seed: SeedArtist): number {
  let score = 0;
  const normalizedPractice = normalizeName(seed.practice);
  const normalizedCategory = normalizeName(seed.category);
  const normalizedName = normalizeName(seed.name);
  const tokens = normalizedName.split(' ').filter(Boolean);

  score += Math.min(seedDistinctiveTokenCount(seed.name), 4) * 4;

  if (tokens.length >= 3) score += 8;
  else if (tokens.length === 2) score += 4;
  else score -= 6;

  if (/[()&]/.test(seed.name)) score -= 4;
  if (/jr\.?|filho|neto/i.test(seed.name)) score += 2;
  if (tokens.some((token) => token.length === 1)) score -= 2;

  if (
    normalizedCategory.includes('pintura') ||
    normalizedCategory.includes('armorial') ||
    normalizedCategory.includes('fotografia') ||
    normalizedCategory.includes('xilogravura') ||
    normalizedCategory.includes('arte popular')
  ) {
    score += 10;
  }

  if (
    normalizedPractice.includes('pintura') ||
    normalizedPractice.includes('escultura') ||
    normalizedPractice.includes('ceramica') ||
    normalizedPractice.includes('xilogravura') ||
    normalizedPractice.includes('fotografia') ||
    normalizedPractice.includes('gravura')
  ) {
    score += 8;
  }

  if (
    normalizedPractice.includes('arte urbana') ||
    normalizedPractice.includes('graffiti') ||
    normalizedPractice.includes('quadrinhos') ||
    normalizedPractice.includes('ilustracao') ||
    normalizedPractice.includes('arte digital') ||
    normalizedPractice.includes('design grafico')
  ) {
    score -= 10;
  }

  score -= seedAmbiguityPenalty(seed.name);
  return score;
}

function seedDistinctiveTokenCount(name: string): number {
  return normalizeName(name)
    .split(' ')
    .filter((token) => token.length >= 4 && !isVeryCommonPortugueseNameToken(token)).length;
}

function seedAmbiguityPenalty(name: string): number {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  let penalty = 0;

  if (tokens.length <= 2) {
    penalty += 8;
  }

  for (const token of tokens) {
    if (isVeryCommonPortugueseNameToken(token)) {
      penalty += 4;
    }
  }

  return penalty;
}

function isVeryCommonPortugueseNameToken(token: string): boolean {
  return new Set([
    'antonio',
    'joao',
    'jose',
    'maria',
    'pedro',
    'paulo',
    'francisco',
    'manuel',
    'miguel',
    'raimundo',
    'severino',
    'ribeiro',
    'silva',
    'santos',
    'souza',
    'gomes',
    'barbosa',
    'ferreira',
    'lima',
    'araujo',
    'oliveira',
    'carvalho',
    'nascimento',
    'almeida',
    'rodrigues',
    'cunha',
    'melo',
    'pires',
    'martins',
  ]).has(token);
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function slugify(value: string): string {
  return normalizeName(value).replace(/\s+/g, '-');
}

function buildWikipediaTitle(value: string): string {
  return value.trim().replace(/\s+/g, '_');
}

function buildPublicationVariants(name: string): string[] {
  const normalized = normalizeName(name);
  const tokens = normalized.split(' ').filter(Boolean);
  const variants = new Set<string>([normalized]);

  if (tokens.length >= 2) variants.add(tokens.slice(-2).join(' '));
  if (tokens.length >= 3) variants.add(tokens.slice(-3).join(' '));

  return Array.from(variants).filter((variant) => variant.length >= 8);
}

function getRepetitionStatus(artistName: string, publishedHaystacks: string[]) {
  const variants = buildPublicationVariants(artistName);
  const matchedHaystack =
    publishedHaystacks.find((haystack) => variants.some((variant) => haystack.includes(variant))) ?? null;

  const localArtist = query.get<{ status: string | null }>(
    `SELECT status FROM artists WHERE lower(full_name) = lower(?) ORDER BY discovered_at DESC LIMIT 1`,
    [artistName]
  );
  const localDraftStatuses = query
    .all<{ status: string }>(
      `SELECT d.status
         FROM drafts d
         JOIN artists a ON a.id = d.artist_id
        WHERE lower(a.full_name) = lower(?)
        ORDER BY d.created_at DESC`,
      [artistName]
    )
    .map((row) => row.status);

  const publishedExternally = Boolean(matchedHaystack);
  const localPublished = localArtist?.status === 'published';
  const eligible = !publishedExternally && !localPublished;

  return {
    publishedExternally,
    localArtistStatus: localArtist?.status ?? null,
    draftStatuses: Array.from(new Set(localDraftStatuses)),
    eligible,
    matchedVariant: matchedHaystack,
  };
}

async function preMineBiographySources(
  seed: SeedArtist,
  tavily: TavilyClient,
  scraperBridge: ScraperBridge
): Promise<BiographyResearchSource[]> {
  const urlsToProbe = buildBiographyUrlCandidates(seed.name);
  const collected = new Map<string, BiographyResearchSource>();

  for (const url of urlsToProbe) {
    const source = await fetchBiographySource(url, scraperBridge);
    if (source) {
      collected.set(source.url, source);
    }
  }

  if (collected.size >= BIOGRAPHY_SOURCE_LIMIT) {
    return Array.from(collected.values()).slice(0, BIOGRAPHY_SOURCE_LIMIT);
  }

  const searchQueries = buildBiographyQueries(seed);
  for (const queryText of searchQueries) {
    try {
      const response = await tavily.search({
        query: queryText,
        searchDepth: 'advanced',
        maxResults: 8,
        includeDomains: [
          'escritoriodearte.com',
          'enciclopedia.itaucultural.org.br',
          'itaucultural.org.br',
          'pt.wikipedia.org',
          'en.wikipedia.org',
          'museudeartedorio.org.br',
          'pinacoteca.org.br',
          'masp.org.br',
          'museuafrobrasil.org.br',
        ],
      });

      for (const result of response.results) {
        if (collected.has(result.url)) continue;
        const source = await hydrateBiographySearchResult(result, scraperBridge);
        if (source) {
          collected.set(source.url, source);
        }
        if (collected.size >= BIOGRAPHY_SOURCE_LIMIT) {
          break;
        }
      }
    } catch (error) {
      console.warn(`  ⚠ Biography search failed for ${seed.name}: ${queryText}`);
    }

    if (collected.size >= BIOGRAPHY_SOURCE_LIMIT) {
      break;
    }
  }

  return Array.from(collected.values())
    .sort((a, b) => b.credibilityScore - a.credibilityScore || b.contentLength - a.contentLength)
    .slice(0, BIOGRAPHY_SOURCE_LIMIT);
}

function buildBiographyUrlCandidates(artistName: string): string[] {
  const slug = slugify(artistName);
  const wikiTitle = buildWikipediaTitle(artistName);

  return [
    `https://www.escritoriodearte.com/artista/${slug}`,
    `https://www.escritoriodearte.com/en/artista/${slug}`,
    `https://pt.wikipedia.org/wiki/${wikiTitle}`,
    `https://en.wikipedia.org/wiki/${wikiTitle}`,
  ];
}

function buildBiographyQueries(seed: SeedArtist): string[] {
  const primaryPractice = normalizeName(seed.practice).split(' ')[0] || 'artista visual';
  return [
    `"${seed.name}" biografia artista`,
    `"${seed.name}" ${primaryPractice} obra`,
    `"${seed.name}" site:escritoriodearte.com`,
    `"${seed.name}" site:enciclopedia.itaucultural.org.br`,
  ];
}

async function fetchBiographySource(
  url: string,
  scraperBridge: ScraperBridge
): Promise<BiographyResearchSource | null> {
  const fetched = await scraperBridge.fetchPage(url, 4500);
  if (!fetched.success || !fetched.content || fetched.content_length < 220) {
    return null;
  }

  if (!isUsableBiographySource(url, fetched.title, fetched.content)) {
    return null;
  }

  return {
    url,
    title: fetched.title || url,
    institution: getInstitutionName(url, getConfig().institutions) ?? safeDomain(url),
    credibilityScore: getInstitutionCredibility(url, getConfig().institutions) || fallbackCredibility(url),
    extractor: fetched.extractor,
    contentLength: fetched.content_length,
    summary: summarize(fetched.content, 320),
  };
}

async function hydrateBiographySearchResult(
  result: TavilySearchResult,
  scraperBridge: ScraperBridge
): Promise<BiographyResearchSource | null> {
  const fetched = await scraperBridge.fetchPage(result.url, 4500);
  const content = fetched.success && fetched.content_length >= 220 ? fetched.content : result.content;
  const contentLength =
    fetched.success && fetched.content_length >= 220 ? fetched.content_length : result.content.length;

  if (!content || contentLength < 180) {
    return null;
  }

  const title = fetched.success ? fetched.title || result.title : result.title;
  if (!isUsableBiographySource(result.url, title, content)) {
    return null;
  }

  return {
    url: result.url,
    title,
    institution: getInstitutionName(result.url, getConfig().institutions) ?? safeDomain(result.url),
    credibilityScore: getInstitutionCredibility(result.url, getConfig().institutions) || fallbackCredibility(result.url),
    extractor: fetched.success ? fetched.extractor : 'tavily',
    contentLength,
    summary: summarize(content, 320),
  };
}

async function preMineArtworkCandidates(
  seed: SeedArtist,
  scraperBridge: ScraperBridge,
  biographySources: BiographyResearchSource[]
): Promise<ArtworkResearchCandidate[]> {
  const candidates = new Map<string, ArtworkResearchCandidate>();

  for (const source of biographySources) {
    if (source.url.includes('escritoriodearte.com/artista/')) {
      const directCandidates = await extractEscritorioArtworkCandidates(source.url);
      for (const candidate of directCandidates) {
        candidates.set(candidate.pageUrl, candidate);
      }
    }
  }

  const queries = buildArtworkImageQueries(seed);
  const siteFilters = [
    'escritoriodearte.com',
    'artsandculture.google.com',
    'enciclopedia.itaucultural.org.br',
    'itaucultural.org.br',
    'pinacoteca.org.br',
    'masp.org.br',
  ];

  for (const queryText of queries) {
    if (candidates.size >= ARTWORK_CANDIDATE_LIMIT) {
      break;
    }

    const imageSearch = await scraperBridge.searchImages(queryText, 'all', 12, {
      artworkOnly: true,
      siteFilters,
    });

    if (!imageSearch.success) {
      continue;
    }

    for (const image of imageSearch.images) {
      const pageUrl = image.source_page || image.url;
      if (!pageUrl || candidates.has(pageUrl)) {
        continue;
      }

      if (!isUsableArtworkCandidate(pageUrl, image.caption || '')) {
        continue;
      }

      const domain = image.source_domain || safeDomain(pageUrl);
      const confidence = sourceDomainScore(domain);
      const highResolutionEscritorioCandidate =
        domain.includes('escritoriodearte.com') &&
        /\/artista\/.+-\d+$/i.test(pageUrl) &&
        /\/quadro\/.+g\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(image.url);

      if (!highResolutionEscritorioCandidate && confidence < 0.78) {
        continue;
      }

      candidates.set(pageUrl, {
        pageUrl,
        imageUrl: image.url,
        title: image.caption || pageUrl,
        sourceDomain: domain,
        sourceType: 'image-search',
        confidence,
      });

      if (candidates.size >= ARTWORK_CANDIDATE_LIMIT) {
        break;
      }
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => b.confidence - a.confidence || a.pageUrl.localeCompare(b.pageUrl))
    .slice(0, ARTWORK_CANDIDATE_LIMIT);
}

function buildArtworkImageQueries(seed: SeedArtist): string[] {
  const practiceTerms = buildPracticeTerms(seed.practice);
  const regionTerms = buildRegionTerms(seed.states);
  const queries = [
    `${seed.name} artwork high resolution`,
    `${seed.name} obra alta resolução`,
    `${seed.name} artwork only`,
    `${seed.name} obra sem moldura`,
    ...practiceTerms.flatMap((term) => [
      `${seed.name} ${term} obra`,
      `${seed.name} ${term} artwork`,
      `${seed.name} ${term} museum`,
      `${seed.name} ${term} acervo`,
    ]),
    ...regionTerms.flatMap((region) => [
      `${seed.name} ${region} obra`,
      `${seed.name} ${region} artwork`,
      `${seed.name} ${region} ${practiceTerms[0] ?? 'art'}`,
    ]),
  ];

  return queries.filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);
}

function buildPracticeTerms(practice: string): string[] {
  const normalized = normalizeName(practice);
  const terms = new Set<string>();

  if (normalized.includes('pint')) {
    terms.add('painting');
    terms.add('pintura');
  }
  if (normalized.includes('escult')) {
    terms.add('sculpture');
    terms.add('escultura');
  }
  if (normalized.includes('gravur') || normalized.includes('xilo')) {
    terms.add('print');
    terms.add('gravura');
    terms.add('xilogravura');
  }
  if (normalized.includes('desenh')) {
    terms.add('drawing');
    terms.add('desenho');
  }
  if (normalized.includes('ceram')) {
    terms.add('ceramic');
    terms.add('ceramica');
  }
  if (normalized.includes('fot')) {
    terms.add('photography');
    terms.add('fotografia');
  }

  terms.add(practice);
  return Array.from(terms).filter(Boolean).slice(0, 4);
}

function buildRegionTerms(states?: string): string[] {
  const raw = (states ?? '').trim();
  const normalized = normalizeName(raw);
  const terms = new Set<string>();

  const stateMap: Record<string, string[]> = {
    pe: ['Pernambuco', 'Recife', 'Nordeste'],
    ba: ['Bahia', 'Salvador', 'Nordeste'],
    ce: ['Ceara', 'Fortaleza', 'Nordeste'],
    pb: ['Paraiba', 'Joao Pessoa', 'Nordeste'],
    rn: ['Rio Grande do Norte', 'Natal', 'Nordeste'],
    al: ['Alagoas', 'Maceio', 'Nordeste'],
    se: ['Sergipe', 'Aracaju', 'Nordeste'],
    pi: ['Piaui', 'Teresina', 'Nordeste'],
    ma: ['Maranhao', 'Sao Luis', 'Nordeste'],
  };

  if (raw) {
    terms.add(raw);
  }

  for (const [code, mappedTerms] of Object.entries(stateMap)) {
    if (normalized.includes(code) || mappedTerms.some((term) => normalized.includes(normalizeName(term)))) {
      mappedTerms.forEach((term) => terms.add(term));
    }
  }

  if (terms.size === 0) {
    terms.add('Nordeste');
  }

  return Array.from(terms).slice(0, 4);
}

function isUsableBiographySource(url: string, title: string, content: string): boolean {
  const normalizedTitle = normalizeName(title);
  const normalizedContent = normalizeName(content);
  const normalizedUrl = normalizeName(url);

  if (
    normalizedTitle === 'artistas' ||
    normalizedTitle === 'artists' ||
    normalizedTitle.startsWith('artists see below') ||
    normalizedContent.includes('conheca abaixo o rol de artistas') ||
    normalizedContent.includes('see below the list of artists')
  ) {
    return false;
  }

  if (
    normalizedContent.includes('criar criar codigo fonte') ||
    normalizedContent.includes('o conteudo da pagina nao e suportado noutras linguas')
  ) {
    return false;
  }

  if (normalizedUrl.includes('/wiki/') && normalizedContent.includes('criar criar')) {
    return false;
  }

  return true;
}

function isUsableArtworkCandidate(pageUrl: string, title: string): boolean {
  const normalizedUrl = normalizeName(pageUrl);
  const normalizedTitle = normalizeName(title);
  const blockedDomains = [
    'alamy.com',
    'dreamstime.com',
    'shutterstock.com',
    'behance.net',
    'pinterest.com',
    'pinimg.com',
    'instagram.com',
    'facebook.com',
    'reddit.com',
  ];

  if (blockedDomains.some((domain) => pageUrl.includes(domain))) {
    return false;
  }

  const blockedSignals = [
    'hi res stock',
    'stock photography',
    'editorial photography',
    'book cover',
    'poster',
    'banner',
    'catalogo',
    'catalog',
    'principais tags',
    'imagens',
    'artista',
    'profile',
    'perfil',
    'auction',
    'leilao',
    'leiloeiro',
  ];

  return !blockedSignals.some(
    (signal) => normalizedTitle.includes(signal) || normalizedUrl.includes(signal)
  );
}

async function extractEscritorioArtworkCandidates(
  url: string
): Promise<ArtworkResearchCandidate[]> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    const html = await response.text();
    if (!response.ok || !html) {
      return [];
    }

    const matches = Array.from(
      html.matchAll(
        /<div class="lista_quadros">[\s\S]*?<a href="(?<href>\/(?:en\/)?artista\/[^"]+\/[^"]*-\d+)"><img src="(?<img>\/quadro\/[^"]+)"[^>]*alt="(?<alt>[^"]+)"/gi
      )
    );

    const candidates = new Map<string, ArtworkResearchCandidate>();
    for (const match of matches) {
      const relativeHref = match.groups?.href?.trim();
      const relativeImg = match.groups?.img?.trim();
      const alt = match.groups?.alt?.trim() ?? 'Artwork';
      if (!relativeHref) continue;

      const pageUrl = new URL(relativeHref, 'https://www.escritoriodearte.com').toString();
      candidates.set(pageUrl, {
        pageUrl,
        imageUrl: relativeImg
          ? new URL(relativeImg.replace(/p\.webp$/i, 'g.webp'), 'https://www.escritoriodearte.com').toString()
          : undefined,
        title: alt,
        sourceDomain: 'escritoriodearte.com',
        sourceType: 'source-page',
        confidence: 0.95,
      });
    }

    return Array.from(candidates.values());
  } catch {
    return [];
  }
}

function fallbackCredibility(url: string): number {
  const domain = safeDomain(url);
  if (domain.includes('wikipedia.org')) return 0.7;
  if (domain.includes('wikidata.org')) return 0.65;
  if (domain.includes('artsandculture.google.com')) return 0.92;
  if (domain.includes('escritoriodearte.com')) return 0.9;
  return 0.55;
}

function sourceDomainScore(domain: string): number {
  if (!domain) return 0.4;
  if (domain.includes('escritoriodearte.com')) return 0.95;
  if (domain.includes('artsandculture.google.com')) return 0.92;
  if (domain.includes('itaucultural.org.br')) return 0.9;
  if (domain.includes('pinacoteca.org.br')) return 0.88;
  if (domain.includes('masp.org.br')) return 0.88;
  if (domain.includes('wikipedia.org')) return 0.68;
  return 0.6;
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function summarize(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}...`;
}

function buildNotes(
  repetition: ArtistResearchCacheEntry['repetition'],
  biographySources: BiographyResearchSource[],
  artworkCandidates: ArtworkResearchCandidate[]
): string[] {
  const notes: string[] = [];

  if (!repetition.eligible) {
    notes.push('Not currently eligible for new approval email due to repetition status.');
  }

  if (biographySources.length === 0) {
    notes.push('No usable biography sources found yet.');
  } else if (biographySources.length < 2) {
    notes.push('Only one biography source found; needs stronger corroboration.');
  }

  if (artworkCandidates.length < 3) {
    notes.push('Fewer than 3 artwork candidate URLs found; needs deeper image mining.');
  }

  return notes;
}

main().catch((error) => {
  console.error('\n❌ Pre-mining failed:', error);
  closeDatabase();
  process.exit(1);
});
