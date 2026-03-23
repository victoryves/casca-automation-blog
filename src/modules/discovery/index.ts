/**
 * Discovery Module
 *
 * Main entry point for artist discovery functionality.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { TavilyClient } from './tavily-client.js';
import { CandidateExtractor } from './candidate-extractor.js';
import { SEED_ARTISTS, type SeedArtist } from './seed-artists.js';
import { artistOps, sourceOps } from '../../db/operations/index.js';
import {
  getConfig,
  getInstitutionCredibility,
  getInstitutionName,
  type Config,
} from '../../config/index.js';
import type { DiscoveryResult, Artist, Source, TavilySearchResult } from '../../types/index.js';

export class DiscoveryModule {
  private tavilyClient: TavilyClient;
  private extractor: CandidateExtractor;
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

  constructor(tavilyApiKey: string) {
    this.tavilyClient = new TavilyClient(tavilyApiKey);
    this.extractor = new CandidateExtractor();
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
    const failedTodayNames = await this.loadFailedArtistNamesForToday(config.env.appTimezone);
    for (const failedName of failedTodayNames) {
      existingNames.add(failedName);
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

        const response = await this.tavilyClient.search({
          query: searchQuery.query,
          searchDepth: 'advanced',
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

  private async discoverFromSeedList(params: {
    config: Config;
    maxCandidates?: number;
    candidates: Artist[];
    sourcesMap: Map<number, Source[]>;
    errors: string[];
    existingNames: Set<string>;
  }): Promise<void> {
    const { config, maxCandidates, candidates, sourcesMap, errors, existingNames } = params;

    const remainingSeeds = this.balanceSeedsAcrossCategories(SEED_ARTISTS).filter(
      (seed) => !existingNames.has(this.normalizeName(seed.name))
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

        if (sources.length < 2) {
          errors.push(
            `Seed search produced insufficient sources for ${seed.name} (${sources.length})`
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
    const existing = await artistOps.findAll();
    return new Set(existing.map((artist) => this.normalizeName(artist.full_name)));
  }

  private async loadFailedArtistNamesForToday(appTimezone?: string): Promise<Set<string>> {
    try {
      const workflowDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: appTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const filePath = path.join(process.cwd(), 'logs', 'daily', `failed-artists-${workflowDate}.json`);
      const content = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        return new Set<string>();
      }

      return new Set(
        parsed
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => this.normalizeName(value))
      );
    } catch {
      return new Set<string>();
    }
  }

  private resolveStates(stateCodes?: string): string[] {
    if (!stateCodes) return [];
    const codes = stateCodes
      .split('/')
      .map((code) => code.trim())
      .filter(Boolean);

    return codes.map((code) => this.STATE_MAP[code] ?? code);
  }

  private balanceSeedsAcrossCategories(seeds: SeedArtist[]): SeedArtist[] {
    const grouped = new Map<string, SeedArtist[]>();

    for (const seed of seeds) {
      const current = grouped.get(seed.category) ?? [];
      current.push(seed);
      grouped.set(seed.category, current);
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

  private buildSeedQueries(seed: SeedArtist, states: string[]): string[] {
    const base = `"${seed.name}"`;
    const primaryState = states[0];
    const practiceHints = this.getPracticeHints(seed.practice);

    const queries = [
      this.buildQuery(base, practiceHints[0], primaryState, 'artista visual'),
      this.buildQuery(base, 'biografia', primaryState),
      this.buildQuery(base, 'artista visual', 'Nordeste'),
      this.buildQuery(base, practiceHints[1] ?? practiceHints[0], primaryState),
      this.buildQuery(base, practiceHints[0], 'obra', `site:dailyartfair.com`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:mutualart.com`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:artsy.net`),
      this.buildQuery(base, practiceHints[0], 'obra', `site:wikiart.org`),
      this.buildQuery(base, 'site:enciclopedia.itaucultural.org.br'),
      this.buildQuery(base, 'site:wikipedia.org'),
      this.buildQuery(base, 'site:wikidata.org'),
      this.buildQuery(base, 'site:fundaj.gov.br'),
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
    const resultsByUrl = new Map<string, TavilySearchResult>();
    const queriesUsed: string[] = [];

    for (const query of queries) {
      try {
        const response = await this.tavilyClient.search({
          query,
          searchDepth: 'advanced',
          maxResults: 6,
        });

        queriesUsed.push(query);
        for (const result of response.results) {
          if (!result.url || resultsByUrl.has(result.url)) continue;
          resultsByUrl.set(result.url, result);
        }

        const interimSources = this.buildSourcesFromResults(
          Array.from(resultsByUrl.values()),
          seed.name,
          config,
          3
        );

        if (interimSources.length >= 2) {
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

    return { sources, queriesUsed };
  }

  private buildSourcesFromResults(
    results: TavilySearchResult[],
    artistName: string,
    config: Config,
    limit: number
  ): Omit<Source, 'id' | 'artist_id'>[] {
    const scored = results
      .map((result) => {
        const credibility = this.estimateCredibility(result.url, result.score, config);
        const matchBoost = this.matchScore(result, artistName);
        const strongMatch = this.isStrongArtistMatch(result, artistName);
        return {
          result,
          credibility,
          matchBoost,
          strongMatch,
        };
      })
      .filter((item) => item.strongMatch && !this.isBlockedDiscoverySource(item.result.url));

    scored.sort((a, b) => {
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
        institution: getInstitutionName(item.result.url, config.institutions) ?? (domain || 'unknown'),
        credibility_score: item.credibility,
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
      if (domain.includes('dailyartfair.com')) return 0.86;
      if (domain.includes('mutualart.com')) return 0.82;
      if (domain.includes('wikiart.org')) return 0.8;
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
    ].some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
  }

  private getArtworkSourcePriority(url: string): number {
    const domain = this.safeDomain(url) ?? '';

    if (domain.includes('dailyartfair.com')) return 5;
    if (domain.includes('enciclopedia.itaucultural.org.br')) return 4;
    if (domain.includes('mutualart.com')) return 3;
    if (domain.includes('wikiart.org')) return 3;
    if (domain.endsWith('.gov.br') || domain.endsWith('.edu.br') || domain.endsWith('.org.br')) return 2;
    if (domain.includes('wikipedia.org') || domain.includes('wikimedia.org')) return 1;

    return 0;
  }

  private matchScore(result: TavilySearchResult, artistName: string): number {
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

  private isStrongArtistMatch(result: TavilySearchResult, artistName: string): boolean {
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
}
