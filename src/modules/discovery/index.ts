/**
 * Discovery Module
 *
 * Main entry point for artist discovery functionality.
 */

import axios from 'axios';
import { ExaClient } from './exa-client.js';
import { DuckDuckGoClient } from './duckduckgo-client.js';
import { CandidateExtractor } from './candidate-extractor.js';
import { SEED_ARTISTS, type SeedArtist } from './seed-artists.js';
import { artistOps, draftOps, publicationHistoryOps, sourceOps } from '../../db/operations/index.js';
import { PublicationHistoryModule } from '../publication-history/index.js';
import { ScraperBridge } from '../scraper-bridge/index.js';
import { assessSourceWithLibrarian, isDiamondDomain } from './librarian.js';
import {
  getConfig,
  getInstitutionCredibility,
  getInstitutionName,
  type Config,
} from '../../config/index.js';
import type { DiscoveryResult, Artist, Source, SearchResult } from '../../types/index.js';

export class DiscoveryModule {
  private exaClient: ExaClient;
  private duckDuckGoClient: DuckDuckGoClient;
  private extractor: CandidateExtractor;
  private scraperBridge: ScraperBridge;
  private exaUnavailable = false;
  private publicationHistory: PublicationHistoryModule | null = null;
  private readonly STATE_MAP: Record<string, string> = {
    PE: 'Pernambuco',
    PB: 'Paraíba',
    CE: 'Ceará',
    BA: 'Bahia',
    RN: 'Rio Grande do Norte',
    AL: 'Alagoas',
    SE: 'Sergipe',
    MA: 'Maranhão',
    PI: 'Piauí',
    ES: 'Espírito Santo',
    RJ: 'Rio de Janeiro',
    SP: 'São Paulo',
    MG: 'Minas Gerais',
  };

  constructor(exaApiKey: string) {
    this.exaClient = new ExaClient(exaApiKey);
    this.duckDuckGoClient = new DuckDuckGoClient();
    this.extractor = new CandidateExtractor();
    this.scraperBridge = new ScraperBridge();
  }

  /**
   * Discover new artist candidates
   * @param maxCandidates - Maximum number of candidates to find (default: unlimited)
   */
  async discover(maxCandidates?: number): Promise<DiscoveryResult> {
    const config = getConfig();
    const candidates: Artist[] = [];
    const sourcesMap = new Map<number, Source[]>();
    const errors: string[] = [];

    console.log('🔍 Starting artist discovery...');
    if (maxCandidates) {
      console.log(`  (stopping after finding ${maxCandidates} candidate${maxCandidates > 1 ? 's' : ''})`);
    }

    const existingNames = await this.loadExistingArtistNames();
    // 0) Collection-first discovery from museum/acervo item pages
    await this.discoverFromCollectionAnchors({
      config,
      maxCandidates,
      candidates,
      sourcesMap,
      errors,
      existingNames,
    });

    if (maxCandidates && candidates.length >= maxCandidates) {
      console.log(`  ✓ Reached target of ${maxCandidates} candidate(s) via collection-first discovery`);
      return {
        candidates,
        sources: sourcesMap,
        errors,
      };
    }

    // 1) Seed list: name-first discovery (primary strategy)
    await this.discoverFromSeedList({
      config,
      maxCandidates,
      candidates,
      sourcesMap,
      errors,
      existingNames,
    });

    if (maxCandidates && candidates.length >= maxCandidates) {
      console.log(`  ✓ Reached target of ${maxCandidates} candidate(s) via seed list`);
      return {
        candidates,
        sources: sourcesMap,
        errors,
      };
    }

    // 2) Fallback: execute searches from config (no institutional-only filter)
    for (const searchQuery of config.searchQueries.queries) {
      if (maxCandidates && candidates.length >= maxCandidates) {
        break;
      }

      try {
        console.log(`  Searching: ${searchQuery.description}`);

        const response = await this.searchWithFallback({
          query: searchQuery.query,
          maxResults: 10,
        });

        console.log(`  Found ${response.results.length} results`);

        const institutionalCount = response.results.filter((result) =>
          getInstitutionCredibility(result.url, config.institutions) > 0
        ).length;
        console.log(`  ${institutionalCount} from trusted institutions`);

        const extracted = this.extractor.extract(response.results);

        for (const { artist, sources } of extracted) {
          const normalized = this.normalizeName(artist.full_name);
          if (existingNames.has(normalized)) {
            console.log(`  ⊘ Duplicate: ${artist.full_name}`);
            continue;
          }

          const artistId = await artistOps.create(artist);
          const createdArtist = await artistOps.findById(artistId);

          if (!createdArtist) {
            errors.push(`Failed to create artist: ${artist.full_name}`);
            continue;
          }

          candidates.push(createdArtist);
          existingNames.add(normalized);

          const artistSources: Source[] = [];
          for (const source of this.enrichSources(sources, config)) {
            const sourceId = await sourceOps.create({
              artist_id: artistId,
              url: source.url,
              institution: source.institution,
              credibility_score: source.credibility_score,
              content_summary: source.content_summary,
            });

            const createdSource = await sourceOps.findById(sourceId);
            if (createdSource) {
              artistSources.push(createdSource);
            }
          }

          sourcesMap.set(artistId, artistSources);
          const hasDiamondSource = artistSources.some((source) => isDiamondDomain(source.url));
          await artistOps.updatePriority(artistId, hasDiamondSource ? 60 : 50);
          console.log(`  ✓ Added: ${artist.full_name} (${artistSources.length} sources)`);

          if (maxCandidates && candidates.length >= maxCandidates) {
            console.log(`  ✓ Reached target of ${maxCandidates} candidate(s), stopping search`);
            return {
              candidates,
              sources: sourcesMap,
              errors,
            };
          }
        }

        await this.sleep(2000);
      } catch (error) {
        const errorMsg = `Search failed for "${searchQuery.query}": ${error instanceof Error ? error.message : String(error)}`;
        console.error(`  ✗ ${errorMsg}`);
        errors.push(errorMsg);
      }
    }

    console.log(`\n✓ Discovery complete: ${candidates.length} candidates found`);

    return {
      candidates,
      sources: sourcesMap,
      errors,
    };
  }

  private async discoverFromCollectionAnchors(params: {
    config: Config;
    maxCandidates?: number;
    candidates: Artist[];
    sourcesMap: Map<number, Source[]>;
    errors: string[];
    existingNames: Set<string>;
  }): Promise<void> {
    const { config, maxCandidates, candidates, sourcesMap, errors, existingNames } = params;
    const availableSeeds = await this.filterSeedsByPublishedHistory(
      this.balanceSeedsAcrossCategories(SEED_ARTISTS).filter(
        (seed) => !existingNames.has(this.normalizeName(seed.name))
      )
    );

    if (availableSeeds.length === 0) {
      return;
    }

    const collectionQueries = [
      'site:enciclopedia.itaucultural.org.br "obras" "nordeste"',
      'site:itaucultural.org.br/obra "nordeste"',
      'site:museudeartecontemporanea.org.br/acervo/obra',
      'site:pinacoteca.org.br/acervo',
      'site:artsandculture.google.com/asset "nordeste" obra',
    ];

    const seenUrls = new Set<string>();
    for (const query of collectionQueries) {
      if (maxCandidates && candidates.length >= maxCandidates) {
        return;
      }

      try {
        const response = await this.searchWithFallback({
          query,
          maxResults: 12,
        });

        for (const result of response.results) {
          if (maxCandidates && candidates.length >= maxCandidates) {
            return;
          }
          if (
            !result.url ||
            seenUrls.has(result.url) ||
            this.isInstitutionalNoise(result.url) ||
            !this.isCollectionItemUrl(result.url)
          ) {
            continue;
          }
          seenUrls.add(result.url);

          const matchedSeed = availableSeeds.find((seed) => this.isStrongArtistMatch(result, seed.name));
          if (!matchedSeed) {
            continue;
          }

          const normalized = this.normalizeName(matchedSeed.name);
          if (existingNames.has(normalized)) {
            continue;
          }

          const resolvedStates = this.resolveStates(matchedSeed.states);
          const primarySource: Omit<Source, 'id' | 'artist_id'> = {
            url: result.url,
            institution:
              getInstitutionName(result.url, config.institutions) ??
              this.safeDomain(result.url) ??
              'unknown',
            credibility_score: Math.min(
              1,
              this.estimateCredibility(result.url, result.score, config) + 0.15
            ),
            content_summary: result.content?.substring(0, 500),
          };

          const guessedSources = await this.collectGuessedSeedSources(matchedSeed, config);
          const sources = this.mergeSources([primarySource], guessedSources, 3);
          const hasDiamondSource = sources.some((source) => isDiamondDomain(source.url));
          if (!this.hasSufficientSourcesForSeed(sources)) {
            continue;
          }

          const artist: Omit<Artist, 'id'> = {
            full_name: matchedSeed.name,
            birthplace_city: undefined,
            birthplace_state: resolvedStates[0],
            visual_practice: matchedSeed.practice,
            status: 'discovered',
            metadata: JSON.stringify({
              curated: true,
              seed_category: matchedSeed.category,
              seed_states: resolvedStates,
              seed_state_codes: matchedSeed.states,
              discovery_mode: 'collection-first',
              collection_query: query,
              collection_url: result.url,
              source_count: sources.length,
              has_diamond_source: hasDiamondSource,
            }),
          };

          const artistId = await artistOps.create(artist);
          const createdArtist = await artistOps.findById(artistId);
          if (!createdArtist) {
            errors.push(`Failed to create collection-first artist: ${matchedSeed.name}`);
            continue;
          }

          const artistSources: Source[] = [];
          for (const source of sources) {
            const sourceId = await sourceOps.create({
              artist_id: artistId,
              url: source.url,
              institution: source.institution,
              credibility_score: source.credibility_score,
              content_summary: source.content_summary,
            });
            const createdSource = await sourceOps.findById(sourceId);
            if (createdSource) {
              artistSources.push(createdSource);
            }
          }

          candidates.push(createdArtist);
          existingNames.add(normalized);
          sourcesMap.set(artistId, artistSources);
          await artistOps.updatePriority(artistId, hasDiamondSource ? 70 : 55);
          console.log(`  ✓ Added collection-first artist: ${matchedSeed.name} (${artistSources.length} sources)`);
        }
      } catch (error) {
        const errorMsg = `Collection-first query failed for "${query}": ${error instanceof Error ? error.message : String(error)}`;
        console.warn(`  ⚠ ${errorMsg}`);
        errors.push(errorMsg);
      }

      await this.sleep(900);
    }
  }

  private async filterSeedsByPublishedHistory(seeds: SeedArtist[]): Promise<SeedArtist[]> {
    if (seeds.length === 0) {
      return seeds;
    }
    const publishedNames = await publicationHistoryOps.getNormalizedNames();
    if (publishedNames.size === 0) {
      const config = getConfig();
      const publicationHistory = this.ensurePublicationHistory(config);
      const haystacks = await publicationHistory.getPublishedPostHaystacks();
      if (haystacks.length === 0) {
        return seeds;
      }
      return seeds.filter((seed) => !this.isArtistPublishedInExternalBlog(seed.name, haystacks));
    }

    return seeds.filter((seed) => !publishedNames.has(this.normalizeName(seed.name)));
  }

  private ensurePublicationHistory(config: Config): PublicationHistoryModule {
    if (!this.publicationHistory) {
      this.publicationHistory = new PublicationHistoryModule({
        rssUrl: config.env.rssUrl,
        hashnodeApiKey: config.env.hashnodeApiKey,
        hashnodePublicationId: config.env.hashnodePublicationId,
      });
    }

    return this.publicationHistory;
  }

  private isInstitutionalNoise(url: string): boolean {
    const normalized = url.toLowerCase();
    const blockedFragments = [
      '/faq',
      '/equipe',
      '/staff',
      '/about',
      '/quem-somos',
      '/educador',
      '/educativo',
      '/agenda',
      '/noticias',
      '/contato',
      '/login',
      '/imprensa',
      '/associe-se',
      '/acesso-a-informacao',
      '/ouvidoria',
      '/editais',
      '/espaco-do-educador',
    ];
    return blockedFragments.some((fragment) => normalized.includes(fragment));
  }

  private isArtistPublishedInExternalBlog(artistName: string, publishedHaystacks: string[]): boolean {
    const normalized = this.normalizeName(artistName);
    if (!normalized) {
      return false;
    }

    return publishedHaystacks.some((haystack) => haystack.includes(normalized));
  }

  private async discoverFromSeedList(params: {
    config: Config;
    maxCandidates?: number;
    candidates: Artist[];
    sourcesMap: Map<number, Source[]>;
    errors: string[];
    existingNames: Set<string>;
  }): Promise<void> {
    const { config, maxCandidates, candidates, sourcesMap, errors, existingNames } = params;

    const remainingSeeds = await this.filterSeedsByPublishedHistory(
      this.balanceSeedsAcrossCategories(SEED_ARTISTS).filter(
        (seed) => !existingNames.has(this.normalizeName(seed.name))
      )
    );

    if (remainingSeeds.length === 0) {
      console.log('  Seed list exhausted - falling back to generic discovery');
      return;
    }

    for (const seed of remainingSeeds) {
      if (maxCandidates && candidates.length >= maxCandidates) {
        return;
      }

      const normalized = this.normalizeName(seed.name);
      if (existingNames.has(normalized)) {
        continue;
      }

      const resolvedStates = this.resolveStates(seed.states);
      console.log(`  🎯 Searching by artist name: ${seed.name}`);

      try {
        const { sources, queriesUsed } = await this.collectSeedSources(seed, resolvedStates, config);
        const hasDiamondSource = sources.some((source) => isDiamondDomain(source.url));

        if (!this.hasSufficientSourcesForSeed(sources)) {
          errors.push(
            `Seed search produced insufficient trusted sources for ${seed.name} (${sources.length})`
          );
          continue;
        }

        const artist: Omit<Artist, 'id'> = {
          full_name: seed.name,
          birthplace_city: undefined,
          birthplace_state: resolvedStates[0],
          visual_practice: seed.practice,
          status: 'discovered',
          metadata: JSON.stringify({
            curated: true,
            seed_category: seed.category,
            seed_states: resolvedStates,
            seed_state_codes: seed.states,
            queries_used: queriesUsed,
            source_count: sources.length,
            has_diamond_source: hasDiamondSource,
          }),
        };

        const artistId = await artistOps.create(artist);
        const createdArtist = await artistOps.findById(artistId);

        if (!createdArtist) {
          errors.push(`Failed to create seed artist: ${seed.name}`);
          continue;
        }

        candidates.push(createdArtist);
        existingNames.add(normalized);

        const artistSources: Source[] = [];
        for (const source of sources) {
          const sourceId = await sourceOps.create({
            artist_id: artistId,
            url: source.url,
            institution: source.institution,
            credibility_score: source.credibility_score,
            content_summary: source.content_summary,
          });

          const createdSource = await sourceOps.findById(sourceId);
          if (createdSource) {
            artistSources.push(createdSource);
          }
        }

        sourcesMap.set(artistId, artistSources);
        await artistOps.updatePriority(artistId, hasDiamondSource ? 60 : 50);
        console.log(`  ✓ Added seed artist: ${seed.name} (${artistSources.length} sources)`);
      } catch (error) {
        const errorMsg = `Seed search failed for "${seed.name}": ${error instanceof Error ? error.message : String(error)}`;
        console.error(`  ✗ ${errorMsg}`);
        errors.push(errorMsg);
      }

      await this.sleep(1200);
    }
  }

  private async loadExistingArtistNames(): Promise<Set<string>> {
    const reservedNames = new Set<string>();
    const artists = await artistOps.findAll();
    const artistById = new Map(
      artists
        .filter((artist): artist is Artist & { id: number } => typeof artist.id === 'number')
        .map((artist) => [artist.id, artist])
    );

    for (const artist of artists) {
      if (artist.status === 'pending_more_sources') {
        continue;
      }
      reservedNames.add(this.normalizeName(artist.full_name));
    }

    const publishedNames = await publicationHistoryOps.getNormalizedNames();
    for (const normalizedName of publishedNames) {
      reservedNames.add(normalizedName);
    }

    const reservedDrafts = [
      ...(await draftOps.findByStatus('pending')),
      ...(await draftOps.findByStatus('researched')),
      ...(await draftOps.findByStatus('curated')),
      ...(await draftOps.findByStatus('drafted')),
      ...(await draftOps.findByStatus('ready')),
      ...(await draftOps.findByStatus('sent')),
      ...(await draftOps.findByStatus('approved')),
      ...(await draftOps.findByStatus('rejected')),
    ];

    for (const draft of reservedDrafts) {
      const artist = artistById.get(draft.artist_id);
      if (artist) {
        reservedNames.add(this.normalizeName(artist.full_name));
      }
    }

    return reservedNames;
  }

  private resolveStates(stateCodes?: string): string[] {
    if (!stateCodes) return [];
    const codes = stateCodes
      .split('/')
      .map((code) => code.trim())
      .filter(Boolean);

    return codes.map((code) => this.STATE_MAP[code] ?? code);
  }

  private hasSufficientSourcesForSeed(
    sources: Omit<Source, 'id' | 'artist_id'>[]
  ): boolean {
    const highCredibility = sources.filter((source) => (source.credibility_score ?? 0) >= 0.9).length;
    const credible = sources.filter((source) => (source.credibility_score ?? 0) >= 0.5).length;
    return highCredibility >= 1 || credible >= 2;
  }

  private balanceSeedsAcrossCategories(seeds: SeedArtist[]): SeedArtist[] {
    const grouped = new Map<string, SeedArtist[]>();

    for (const seed of seeds) {
      const current = grouped.get(seed.category) ?? [];
      current.push(seed);
      grouped.set(seed.category, current);
    }

    for (const [category, queue] of grouped.entries()) {
      grouped.set(
        category,
        [...queue].sort((a, b) => this.compareSeedPriority(a, b))
      );
    }

    const categories = Array.from(grouped.keys());
    const balanced: SeedArtist[] = [];
    let added = true;

    while (added) {
      added = false;
      for (const category of categories) {
        const queue = grouped.get(category);
        if (queue && queue.length > 0) {
          balanced.push(queue.shift()!);
          added = true;
        }
      }
    }

    return balanced;
  }

  private compareSeedPriority(a: SeedArtist, b: SeedArtist): number {
    const scoreDelta = this.seedPriorityScore(b) - this.seedPriorityScore(a);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    const tokenDelta = this.seedDistinctiveTokenCount(b.name) - this.seedDistinctiveTokenCount(a.name);
    if (tokenDelta !== 0) {
      return tokenDelta;
    }

    return a.name.localeCompare(b.name, 'pt-BR');
  }

  private seedPriorityScore(seed: SeedArtist): number {
    let score = 0;
    const normalizedPractice = this.normalizeName(seed.practice);
    const normalizedCategory = this.normalizeName(seed.category);
    const normalizedName = this.normalizeName(seed.name);
    const tokens = normalizedName.split(' ').filter(Boolean);

    score += Math.min(this.seedDistinctiveTokenCount(seed.name), 4) * 4;

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

    score -= this.seedAmbiguityPenalty(seed.name);
    return score;
  }

  private seedDistinctiveTokenCount(name: string): number {
    return this.normalizeName(name)
      .split(' ')
      .filter((token) => token.length >= 4 && !this.isVeryCommonPortugueseNameToken(token)).length;
  }

  private seedAmbiguityPenalty(name: string): number {
    const tokens = this.normalizeName(name).split(' ').filter(Boolean);

    if (tokens.length === 0) {
      return 100;
    }

    let penalty = 0;
    const commonTokenCount = tokens.filter((token) => this.isVeryCommonPortugueseNameToken(token)).length;

    if (tokens.length === 1) penalty += 8;
    if (tokens.length === 2 && commonTokenCount === 2) penalty += 10;
    if (tokens.length >= 3 && commonTokenCount >= tokens.length - 1) penalty += 6;
    if (this.seedDistinctiveTokenCount(name) === 0) penalty += 12;

    return penalty;
  }

  private isVeryCommonPortugueseNameToken(token: string): boolean {
    return new Set([
      'antonio',
      'antonio',
      'jose',
      'joao',
      'maria',
      'ana',
      'paulo',
      'pedro',
      'francisco',
      'carlos',
      'luiz',
      'luis',
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

  private buildSeedQueries(seed: SeedArtist, states: string[]): string[] {
    const base = `"${seed.name}"`;
    const primaryState = states[0];
    const practiceHints = this.getPracticeHints(seed.practice);
    const highResTerms = ['"high resolution"', '"original size"', '"2000px"'];

    const queries = [
      `${base} site:iam-pba.com.br ${highResTerms.join(' ')}`,
      `${base} site:leiloesbr.com.br ${highResTerms.join(' ')}`,
      `${base} site:itaucultural.org.br/obra ${highResTerms.join(' ')}`,
      `${base} site:pinacoteca.org.br/acervo ${highResTerms.join(' ')}`,
      `${base} site:artsandculture.google.com/asset ${highResTerms.join(' ')}`,
      `${base} site:catalogodasartes.com.br ${highResTerms.join(' ')}`,
      `${base} site:itaucultural.org.br ${highResTerms.join(' ')}`,
      `${base} site:enciclopedia.itaucultural.org.br ${highResTerms.join(' ')}`,
      `${base} biografia obra`,
      `${base} instituição de arte`,
      `${base} museu`,
      this.buildQuery(base, practiceHints[0], primaryState, 'artista visual'),
      this.buildQuery(base, 'biografia', primaryState),
      this.buildQuery(base, 'biografia', 'análise crítica'),
      this.buildQuery(base, 'pintura', 'óleo sobre tela'),
      this.buildQuery(base, 'pintura', 'desenho'),
      this.buildQuery(base, 'artista visual', 'Nordeste'),
      this.buildQuery(base, practiceHints[1] ?? practiceHints[0], primaryState),
      this.buildQuery(base, practiceHints[0], 'obra', `site:artsandculture.google.com`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:artsandculture.google.com/asset`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:enciclopedia.itaucultural.org.br`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:itaucultural.org.br/obra`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:itaucultural.org.br`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:masp.org.br`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:pinacoteca.org.br`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:iam-pba.com.br`, ...highResTerms),
      this.buildQuery(base, practiceHints[0], 'obra', `site:leiloesbr.com.br`, ...highResTerms),
      this.buildQuery(base, practiceHints[0], 'obra', `site:catalogodasartes.com.br`, ...highResTerms),
      this.buildQuery(base, 'acervo', `site:pinacoteca.org.br/acervo`),
      this.buildQuery(base, 'site:enciclopedia.itaucultural.org.br'),
      this.buildQuery(base, 'site:wikipedia.org'),
      this.buildQuery(base, 'site:wikidata.org'),
      this.buildQuery(base, 'site:fundaj.gov.br'),
      this.buildQuery(base, practiceHints[0], 'museu', primaryState),
      this.buildQuery(base, practiceHints[0], 'instituição de arte', primaryState),
    ];

    return Array.from(new Set(queries.filter((q) => q.length > 0)));
  }

  private buildQuery(...parts: Array<string | undefined>): string {
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  private getPracticeHints(practice: string): string[] {
    const normalized = practice.toLowerCase();

    if (normalized.includes('xilo')) {
      return ['xilogravura', 'xilógrafo', 'cordel'];
    }
    if (normalized.includes('quadrinho')) {
      return ['quadrinista', 'HQ', 'ilustrador'];
    }
    if (normalized.includes('arte urbana')) {
      return ['grafite', 'muralista', 'street art'];
    }
    if (normalized.includes('cerâmica')) {
      return ['cerâmica', 'ceramista', 'arte popular'];
    }
    if (normalized.includes('fotografia')) {
      return ['fotógrafo', 'fotografia', 'artista visual'];
    }
    if (normalized.includes('escultura')) {
      return ['escultor', 'escultura', 'artista visual'];
    }
    if (normalized.includes('pintura')) {
      return ['pintor', 'pintura', 'artista visual'];
    }
    if (normalized.includes('performance')) {
      return ['performance', 'artista performático', 'arte contemporânea'];
    }
    if (normalized.includes('instalação')) {
      return ['instalação', 'instalação artística', 'arte contemporânea'];
    }

    return ['artista visual', practice];
  }

  private async collectSeedSources(
    seed: SeedArtist,
    states: string[],
    config: Config
  ): Promise<{ sources: Omit<Source, 'id' | 'artist_id'>[]; queriesUsed: string[] }> {
    const queries = this.buildSeedQueries(seed, states);
    const resultsByUrl = new Map<string, SearchResult>();
    const queriesUsed: string[] = [];
    const guessedSources = await this.collectGuessedSeedSources(seed, config);

    if (this.hasSufficientSourcesForSeed(guessedSources)) {
      console.log(`  ✓ Using guessed fallback sources for ${seed.name}`);
      return { sources: guessedSources, queriesUsed };
    }

    for (const query of queries) {
      try {
        const response = await this.searchWithFallback({
          query,
          maxResults: 6,
        });

        queriesUsed.push(query);
        for (const result of response.results) {
          if (!result.url || resultsByUrl.has(result.url) || this.isInstitutionalNoise(result.url)) continue;
          resultsByUrl.set(result.url, result);
        }

        const interimSources = this.buildSourcesFromResults(
          Array.from(resultsByUrl.values()),
          seed.name,
          config,
          3
        );

        if (this.hasSufficientSourcesForSeed(interimSources)) {
          return { sources: interimSources, queriesUsed };
        }
      } catch (error) {
        console.warn(`  ⚠ Seed query failed (${seed.name}): ${query}`);
      }

      await this.sleep(800);
    }

    const sources = this.buildSourcesFromResults(
      Array.from(resultsByUrl.values()),
      seed.name,
      config,
      3
    );

    if (sources.length >= 2) {
      return { sources, queriesUsed };
    }

    const merged = this.mergeSources(sources, guessedSources, 3);

    if (merged.length > sources.length) {
      console.log(`  ✓ Added ${merged.length - sources.length} guessed fallback source(s) for ${seed.name}`);
    }

    if (this.hasSufficientSourcesForSeed(merged)) {
      return { sources: merged, queriesUsed };
    }

    return { sources: merged, queriesUsed };
  }

  private mergeSources(
    primary: Omit<Source, 'id' | 'artist_id'>[],
    secondary: Omit<Source, 'id' | 'artist_id'>[],
    limit: number
  ): Omit<Source, 'id' | 'artist_id'>[] {
    const merged: Omit<Source, 'id' | 'artist_id'>[] = [];
    const seen = new Set<string>();

    for (const source of [...primary, ...secondary]) {
      if (merged.length >= limit) {
        break;
      }
      if (seen.has(source.url)) {
        continue;
      }
      seen.add(source.url);
      merged.push(source);
    }

    return merged;
  }

  private async collectGuessedSeedSources(
    seed: SeedArtist,
    config: Config
  ): Promise<Omit<Source, 'id' | 'artist_id'>[]> {
    const guessedUrls = this.buildGuessedSourceUrls(seed.name);
    const sources: Omit<Source, 'id' | 'artist_id'>[] = [];

    for (const url of guessedUrls) {
      const summary = await this.fetchSourceSummary(url);
      if (!summary) {
        continue;
      }

      if (!this.isExpectedArtistLandingUrl(url, summary.finalUrl, seed.name)) {
        continue;
      }

      if (this.isInstitutionalNoise(summary.finalUrl)) {
        continue;
      }

      const librarian = assessSourceWithLibrarian(summary.finalUrl, config, summary.score);
      if (librarian.blocked) {
        continue;
      }

      const strongMatch = this.isStrongArtistMatch(
        {
          title: summary.title,
          url: summary.finalUrl,
          content: summary.content,
          score: summary.score,
        },
        seed.name
      );

      if (!strongMatch || this.isBlockedDiscoverySource(summary.finalUrl)) {
        continue;
      }

      sources.push({
        url: summary.finalUrl,
        institution: librarian.institution ?? getInstitutionName(summary.finalUrl, config.institutions) ?? this.safeDomain(summary.finalUrl) ?? 'unknown',
        credibility_score: Math.min(1, this.estimateCredibility(summary.finalUrl, summary.score, config) + librarian.boost * 0.04),
        content_summary: summary.content.substring(0, 500),
      });

      if (sources.length >= 3) {
        break;
      }
    }

    return sources;
  }

  private buildGuessedSourceUrls(artistName: string): string[] {
    const slug = this.slugifyArtistName(artistName);
    const wikiTitle = this.wikipediaTitle(artistName);

    return [
      `https://www.escritoriodearte.com/artista/${slug}`,
      `https://en.wikipedia.org/wiki/${wikiTitle}`,
      `https://pt.wikipedia.org/wiki/${wikiTitle}`,
    ];
  }

  private slugifyArtistName(value: string): string {
    return this.normalizeName(value)
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private wikipediaTitle(value: string): string {
    return value.trim().replace(/\s+/g, '_');
  }

  private isExpectedArtistLandingUrl(originalUrl: string, finalUrl: string, artistName: string): boolean {
    try {
      const original = new URL(originalUrl);
      const final = new URL(finalUrl);
      const finalPath = final.pathname.toLowerCase();
      const artistSlug = this.slugifyArtistName(artistName);

      if (original.hostname.includes('escritoriodearte.com')) {
        return final.hostname.includes('escritoriodearte.com') && finalPath.includes(`/artista/${artistSlug}`);
      }

      if (original.hostname.includes('dailyartfair.com')) {
        return final.hostname.includes('dailyartfair.com') && finalPath.includes(`/artist/${artistSlug}`);
      }

      return true;
    } catch {
      return false;
    }
  }

  private async fetchSourceSummary(
    url: string
  ): Promise<{ title: string; content: string; score: number; finalUrl: string } | null> {
    try {
      if (await this.scraperBridge.isPageFetchAvailable()) {
        const fetched = await this.scraperBridge.fetchPage(url, 5000);
        if (fetched.success && fetched.content && fetched.content.length >= 180) {
          const score =
            fetched.extractor === 'crawl4ai'
              ? 0.86
              : fetched.extractor === 'jina-reader'
                ? 0.83
                : 0.8;
          return {
            title: fetched.title || url,
            content: fetched.content,
            score,
            finalUrl: fetched.final_url || fetched.url || url,
          };
        }
      }
    } catch {
      // Fall back to basic HTML extraction below.
    }

    try {
      const response = await axios.get<string>(url, {
        timeout: 12000,
        maxRedirects: 5,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        },
        responseType: 'text',
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const html = typeof response.data === 'string' ? response.data : '';
      if (!html) {
        return null;
      }

      const title = this.extractHtmlTitle(html) || url;
      const content = this.extractHtmlSummary(html);

      if (!content) {
        return null;
      }

      const finalUrl =
        response.request?.res?.responseUrl ||
        response.request?.responseURL ||
        url;

      return {
        title,
        content,
        score: 0.72,
        finalUrl,
      };
    } catch {
      return null;
    }
  }

  private extractHtmlTitle(html: string): string {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return this.cleanHtmlSnippet(titleMatch?.[1] ?? '');
  }

  private extractHtmlSummary(html: string): string {
    const descriptionMatch = html.match(
      /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i
    );
    const description = this.cleanHtmlSnippet(descriptionMatch?.[1] ?? '');
    if (description.length >= 40) {
      return description;
    }

    const bodyText = this.cleanHtmlSnippet(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    );

    return bodyText.substring(0, 600).trim();
  }

  private cleanHtmlSnippet(value: string): string {
    return value
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private buildSourcesFromResults(
    results: SearchResult[],
    artistName: string,
    config: Config,
    limit: number
  ): Omit<Source, 'id' | 'artist_id'>[] {
    const scored = results
      .map((result) => {
        const librarian = assessSourceWithLibrarian(result.url, config, result.score ?? 0);
        const credibility = this.estimateCredibility(result.url, result.score, config);
        const matchBoost = this.matchScore(result, artistName);
        const strongMatch = this.isStrongArtistMatch(result, artistName);
        return {
          result,
          librarian,
          credibility,
          matchBoost,
          strongMatch,
        };
      })
      .filter(
        (item) =>
          item.strongMatch &&
          !item.librarian.blocked &&
          !this.isBlockedDiscoverySource(item.result.url) &&
          !this.isInstitutionalNoise(item.result.url)
      );

    scored.sort((a, b) => {
      if (b.librarian.boost !== a.librarian.boost) return b.librarian.boost - a.librarian.boost;
      const preferredDelta =
        this.getArtworkSourcePriority(b.result.url) - this.getArtworkSourcePriority(a.result.url);
      if (preferredDelta !== 0) return preferredDelta;
      if (b.credibility !== a.credibility) return b.credibility - a.credibility;
      if (b.matchBoost !== a.matchBoost) return b.matchBoost - a.matchBoost;
      return (b.result.score ?? 0) - (a.result.score ?? 0);
    });

    const sources: Omit<Source, 'id' | 'artist_id'>[] = [];
    const usedDomains = new Set<string>();

    for (const item of scored) {
      if (sources.length >= limit) break;

      const domain = this.safeDomain(item.result.url);
      if (domain && usedDomains.has(domain) && sources.length < 2) {
        continue;
      }

      sources.push({
        url: item.result.url,
        institution: item.librarian.institution ?? getInstitutionName(item.result.url, config.institutions) ?? (domain || 'unknown'),
        credibility_score: Math.min(1, item.credibility + item.librarian.boost * 0.04),
        content_summary: item.result.content?.substring(0, 500),
      });

      if (domain) usedDomains.add(domain);
    }

    return sources;
  }

  private enrichSources(
    sources: Omit<Source, 'id' | 'artist_id'>[],
    config: Config
  ): Omit<Source, 'id' | 'artist_id'>[] {
    return sources.map((source) => {
      const credibility = this.estimateCredibility(source.url, source.credibility_score, config);
      const institution = getInstitutionName(source.url, config.institutions) ?? source.institution;
      return {
        ...source,
        credibility_score: credibility,
        institution,
      };
    });
  }

  private estimateCredibility(url: string, score: number | undefined, config: Config): number {
    const institutional = getInstitutionCredibility(url, config.institutions);
    if (institutional > 0) return institutional;

    const domain = this.safeDomain(url);
    if (domain) {
      if (domain.includes('escritoriodearte.com')) return 0.9;
      if (domain.includes('dailyartfair.com')) return 0.58;
      if (domain.includes('mutualart.com')) return 0.55;
      if (domain.includes('artsy.net')) return 0.6;
      if (domain.includes('wikiart.org')) return 0.7;
      if (domain.endsWith('.gov.br') || domain.endsWith('.edu.br')) return 0.9;
      if (domain.endsWith('.org.br') || domain.endsWith('.org')) return 0.75;
      if (domain.endsWith('.com.br')) return 0.65;
    }

    if (typeof score === 'number') {
      if (score >= 0.9) return 0.85;
      if (score >= 0.7) return 0.7;
      if (score >= 0.5) return 0.6;
    }

    return 0.55;
  }

  private safeDomain(url: string): string | null {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return null;
    }
  }

  private isCollectionItemUrl(url: string): boolean {
    const normalized = url.toLowerCase();
    return (
      /\/obras?\//.test(normalized) ||
      /\/acervo(\/|$)/.test(normalized) ||
      /artsandculture\.google\.com\/asset\//.test(normalized)
    );
  }

  private isBlockedDiscoverySource(url: string): boolean {
    const domain = this.safeDomain(url);
    if (!domain) return false;

    return [
      'instagram.com',
      'facebook.com',
      'tiktok.com',
      'x.com',
      'twitter.com',
      'pinterest.com',
      'blogspot.com',
      'youtube.com',
      'artsy.net',
      'mutualart.com',
      'dailyartfair.com',
      'artstation.com',
      'deviantart.com',
      'behance.net',
    ].some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
  }

  private getArtworkSourcePriority(url: string): number {
    const domain = this.safeDomain(url) ?? '';

    if (domain.includes('artsandculture.google.com')) return 6;
    if (domain.includes('enciclopedia.itaucultural.org.br')) return 5;
    if (domain.includes('itaucultural.org.br')) return 4;
    if (domain.includes('wikiart.org')) return 2;
    if (domain.endsWith('.gov.br') || domain.endsWith('.edu.br') || domain.endsWith('.org.br')) return 2;
    if (domain.includes('wikipedia.org') || domain.includes('wikimedia.org')) return 1;

    return 0;
  }

  private matchScore(result: SearchResult, artistName: string): number {
    const haystack = `${result.title} ${result.content}`.toLowerCase();
    const tokens = this.normalizeName(artistName)
      .split(' ')
      .map((t) => t.trim())
      .filter((t) => t.length >= 3);

    if (tokens.length === 0) return 0;

    let hits = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) hits += 1;
    }

    return hits / tokens.length;
  }

  private isStrongArtistMatch(result: SearchResult, artistName: string): boolean {
    const normalizedArtistName = this.normalizeName(artistName);
    const normalizedHaystack = this.normalizeName(
      `${result.title} ${result.content} ${result.url}`
    );

    if (normalizedHaystack.includes(normalizedArtistName)) {
      return true;
    }

    const tokens = normalizedArtistName.split(' ').filter((token) => token.length >= 2);
    if (tokens.length === 0) {
      return false;
    }

    const surname = tokens[tokens.length - 1];
    const givenTokens = tokens.slice(0, -1).filter((token) => token.length >= 4);

    if (givenTokens.length === 0) {
      return tokens.every((token) => normalizedHaystack.includes(token));
    }

    const hasGivenName = givenTokens.some((token) => normalizedHaystack.includes(token));
    const hasSurname = surname.length >= 4 ? normalizedHaystack.includes(surname) : true;

    return hasGivenName && hasSurname;
  }

  private normalizeName(name: string): string {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Sleep helper for rate limiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async searchWithFallback(options: {
    query: string;
    maxResults?: number;
  }): Promise<{ query: string; results: SearchResult[] }> {
    if (this.exaUnavailable) {
      return this.duckDuckGoClient.search({
        query: options.query,
        maxResults: options.maxResults,
      });
    }

    try {
      const siteMatches = Array.from(options.query.matchAll(/site:([^\s]+)/gi)).map((match) =>
        match[1].replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      );
      const cleanedQuery = options.query.replace(/\s*site:[^\s]+/gi, ' ').replace(/\s+/g, ' ').trim();

      return await this.exaClient.search({
        query: cleanedQuery || options.query,
        maxResults: options.maxResults,
        includeDomains: siteMatches.length > 0 ? siteMatches : undefined,
        excludeDomains: [
          'pinterest.com',
          'instagram.com',
          'facebook.com',
          'amazon.com',
          'amazon.com.br',
          'mercadolivre.com.br',
          'shopee.com.br',
          'artsy.net',
          'mutualart.com',
          'dailyartfair.com',
        ],
        category: /noticia|news|exposicao|exhibition/i.test(cleanedQuery) ? 'news' : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/401|403|429|exa api error/i.test(message)) {
        this.exaUnavailable = true;
        console.warn(`  ⚠ Exa unavailable for "${options.query}". Falling back to DuckDuckGo HTML search.`, message);
        return this.duckDuckGoClient.search({
          query: options.query,
          maxResults: options.maxResults,
        });
      }
      console.warn(`  ⚠ Exa unavailable for "${options.query}". Falling back to DuckDuckGo HTML search.`, message);
      return this.duckDuckGoClient.search({
        query: options.query,
        maxResults: options.maxResults,
      });
    }
  }
}
