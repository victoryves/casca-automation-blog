/**
 * Discovery Module
 *
 * Main entry point for artist discovery functionality.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { TavilyClient } from './tavily-client.js';
import { DuckDuckGoClient } from './duckduckgo-client.js';
import { CandidateExtractor } from './candidate-extractor.js';
import { SEED_ARTISTS, type SeedArtist } from './seed-artists.js';
import { artistOps, draftOps, sourceOps } from '../../db/operations/index.js';
import { PublicationHistoryModule } from '../publication-history/index.js';
import { ScraperBridge } from '../scraper-bridge/index.js';
import {
  getConfig,
  getInstitutionCredibility,
  getInstitutionName,
  type Config,
} from '../../config/index.js';
import type { DiscoveryResult, Artist, Source, TavilySearchResult } from '../../types/index.js';

export class DiscoveryModule {
  private tavilyClient: TavilyClient;
  private duckDuckGoClient: DuckDuckGoClient;
  private extractor: CandidateExtractor;
  private scraperBridge: ScraperBridge;
  private tavilyUnavailable = false;
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

  constructor(tavilyApiKey: string) {
    this.tavilyClient = new TavilyClient(tavilyApiKey);
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

        const response = await this.searchWithFallback({
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

  private async filterSeedsByPublishedHistory(seeds: SeedArtist[]): Promise<SeedArtist[]> {
    if (seeds.length === 0) {
      return seeds;
    }

    const config = getConfig();
    const publicationHistory = this.ensurePublicationHistory(config);
    const haystacks = await publicationHistory.getPublishedPostHaystacks();
    if (haystacks.length === 0) {
      return seeds;
    }

    return seeds.filter((seed) => !this.isArtistPublishedInExternalBlog(seed.name, haystacks));
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
    const reservedNames = new Set<string>();
    const artists = await artistOps.findAll();
    const artistById = new Map(
      artists
        .filter((artist): artist is Artist & { id: number } => typeof artist.id === 'number')
        .map((artist) => [artist.id, artist])
    );

    for (const artist of artists) {
      reservedNames.add(this.normalizeName(artist.full_name));
    }

    const reservedDrafts = [
      ...(await draftOps.findByStatus('pending')),
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
    const guessedSources = await this.collectGuessedSeedSources(seed, config);

    if (guessedSources.length >= 2) {
      console.log(`  ✓ Using guessed fallback sources for ${seed.name}`);
      return { sources: guessedSources, queriesUsed };
    }

    if (this.tavilyUnavailable) {
      return { sources: guessedSources, queriesUsed };
    }

    for (const query of queries) {
      if (this.tavilyUnavailable) {
        break;
      }

      try {
        const response = await this.searchWithFallback({
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

    if (sources.length >= 2) {
      return { sources, queriesUsed };
    }

    const merged = this.mergeSources(sources, guessedSources, 3);

    if (merged.length > sources.length) {
      console.log(`  ✓ Added ${merged.length - sources.length} guessed fallback source(s) for ${seed.name}`);
    }

    if (merged.length >= 2) {
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
        institution:
          getInstitutionName(summary.finalUrl, config.institutions) ??
          this.safeDomain(summary.finalUrl) ??
          'unknown',
        credibility_score: this.estimateCredibility(summary.finalUrl, summary.score, config),
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
      `https://dailyartfair.com/artist/${slug}`,
      `https://en.wikipedia.org/wiki/${wikiTitle}`,
      `https://pt.wikipedia.org/wiki/${wikiTitle}`,
      `https://www.wikidata.org/wiki/${wikiTitle}`,
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
          return {
            title: fetched.title || url,
            content: fetched.content,
            score: fetched.extractor === 'firecrawl' ? 0.86 : 0.8,
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
      if (domain.includes('escritoriodearte.com')) return 0.9;
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

  private async searchWithFallback(options: {
    query: string;
    searchDepth?: 'basic' | 'advanced';
    maxResults?: number;
  }): Promise<{ query: string; results: TavilySearchResult[] }> {
    try {
      return await this.tavilyClient.search(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('status code 432')) {
        this.tavilyUnavailable = true;
        console.warn(`  ⚠ Tavily unavailable for "${options.query}". Falling back to DuckDuckGo HTML search.`, message);
        return this.duckDuckGoClient.search({
          query: options.query,
          maxResults: options.maxResults,
        });
      }
      console.warn(`  ⚠ Tavily unavailable for "${options.query}". Falling back to DuckDuckGo HTML search.`, message);
      return this.duckDuckGoClient.search({
        query: options.query,
        maxResults: options.maxResults,
      });
    }
  }
}
