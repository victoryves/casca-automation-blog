/**
 * Tavily API Client
 *
 * Handles artist discovery search using Tavily API.
 */

import axios from 'axios';
import { TavilyResponseSchema, type TavilyResponse, type TavilySearchResult } from '../../types/index.js';

export interface TavilySearchOptions {
  apiKey: string;
  query: string;
  searchDepth?: 'basic' | 'advanced';
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export class TavilyClient {
  private apiKey: string;
  private baseUrl = 'https://api.tavily.com';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Search for artists using Tavily
   */
  async search(options: Omit<TavilySearchOptions, 'apiKey'>): Promise<TavilyResponse> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/search`,
        {
          api_key: this.apiKey,
          query: options.query,
          search_depth: options.searchDepth ?? 'advanced',
          max_results: options.maxResults ?? 10,
          include_domains: options.includeDomains,
          exclude_domains: options.excludeDomains,
          include_answer: false,
          include_raw_content: false,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      // Validate response
      return TavilyResponseSchema.parse(response.data);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Tavily API error: ${error.response?.data?.message ?? error.message}`
        );
      }
      throw error;
    }
  }

  /**
   * Filter results by score threshold
   */
  filterByScore(results: TavilySearchResult[], minScore: number): TavilySearchResult[] {
    return results.filter((result) => (result.score ?? 0) >= minScore);
  }

  /**
   * Extract unique domains from results
   */
  extractDomains(results: TavilySearchResult[]): string[] {
    const domains = new Set<string>();
    for (const result of results) {
      try {
        const url = new URL(result.url);
        domains.add(url.hostname);
      } catch {
        // Skip invalid URLs
      }
    }
    return Array.from(domains);
  }
}
