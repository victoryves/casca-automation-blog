/**
 * Discovery Module
 *
 * Main entry point for artist discovery functionality.
 */

import { TavilyClient } from './tavily-client.js';
import { CandidateExtractor } from './candidate-extractor.js';
import { artistOps, sourceOps } from '../../db/operations/index.js';
import {
  getConfig,
  isInstitutionalDomain,
  getInstitutionCredibility,
  getInstitutionName,
} from '../../config/index.js';
import type { DiscoveryResult, Artist, Source } from '../../types/index.js';

export class DiscoveryModule {
  private tavilyClient: TavilyClient;
  private extractor: CandidateExtractor;

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

    // Execute searches from config
    for (const searchQuery of config.searchQueries.queries) {
      try {
        console.log(`  Searching: ${searchQuery.description}`);

        // Execute search
        const response = await this.tavilyClient.search({
          query: searchQuery.query,
          searchDepth: 'advanced',
          maxResults: 10,
        });

        console.log(`  Found ${response.results.length} results`);

        // Filter by institutional domains
        const institutionalResults = response.results.filter((result) =>
          isInstitutionalDomain(result.url, config.institutions)
        );

        console.log(`  ${institutionalResults.length} from trusted institutions`);

        // Extract candidates
        const extracted = this.extractor.extract(institutionalResults);

        // Process each candidate
        for (const { artist, sources } of extracted) {
          // Check for duplicates
          const existing = await artistOps.findByNameAndCity(
            artist.full_name,
            artist.birthplace_city
          );

          if (existing) {
            console.log(`  ⊘ Duplicate: ${artist.full_name}`);
            continue;
          }

          // Create artist
          const artistId = await artistOps.create(artist);
          const createdArtist = await artistOps.findById(artistId);

          if (!createdArtist) {
            errors.push(`Failed to create artist: ${artist.full_name}`);
            continue;
          }

          candidates.push(createdArtist);

          // Create sources with enhanced credibility
          const artistSources: Source[] = [];
          for (const source of sources) {
            const credibility = getInstitutionCredibility(source.url, config.institutions);
            const institutionName = getInstitutionName(source.url, config.institutions);

            const sourceId = await sourceOps.create({
              artist_id: artistId,
              url: source.url,
              institution: institutionName ?? source.institution,
              credibility_score: credibility,
              content_summary: source.content_summary,
            });

            const createdSource = await sourceOps.findById(sourceId);
            if (createdSource) {
              artistSources.push(createdSource);
            }
          }

          sourcesMap.set(artistId, artistSources);
          console.log(`  ✓ Added: ${artist.full_name} (${artistSources.length} sources)`);

          // Check if we've reached the maximum number of candidates
          if (maxCandidates && candidates.length >= maxCandidates) {
            console.log(`  ✓ Reached target of ${maxCandidates} candidate(s), stopping search`);
            return {
              candidates,
              sources: sourcesMap,
              errors,
            };
          }
        }

        // Rate limiting
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

  /**
   * Sleep helper for rate limiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
