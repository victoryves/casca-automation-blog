/**
 * DuckDuckGo HTML Search Client
 *
 * Fallback search provider used when Exa is unavailable or rate limited.
 * Returns results in the same shape expected by the discovery pipeline.
 */

import axios from 'axios';
import type { SearchResponse, SearchResult } from '../../types/index.js';

export interface DuckDuckGoSearchOptions {
  query: string;
  maxResults?: number;
}

export class DuckDuckGoClient {
  private readonly baseUrl = 'https://html.duckduckgo.com/html/';

  async search(options: DuckDuckGoSearchOptions): Promise<SearchResponse> {
    const response = await axios.get<string>(this.baseUrl, {
      params: {
        q: options.query,
      },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
      timeout: 30000,
      responseType: 'text',
    });

    const results = this.parseResults(response.data, options.maxResults ?? 10);

    return {
      query: options.query,
      results,
    };
  }

  private parseResults(html: string, maxResults: number): SearchResult[] {
    const blocks = html.match(/<div class="result results_links(?:_deep)?[\s\S]*?<\/div>\s*<\/div>/gi) ?? [];
    const results: SearchResult[] = [];

    for (const block of blocks) {
      if (results.length >= maxResults) {
        break;
      }

      const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      const hrefMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/i);
      const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

      const title = this.cleanText(titleMatch?.[1]);
      const url = this.normalizeResultUrl(hrefMatch?.[1]);
      const content = this.cleanText(snippetMatch?.[1] ?? snippetMatch?.[2]);

      if (!title || !url || !content) {
        continue;
      }

      results.push({
        title,
        url,
        content,
        score: 0.55,
      });
    }

    return results;
  }

  private normalizeResultUrl(rawHref?: string): string | null {
    if (!rawHref) {
      return null;
    }

    const decodedHref = this.decodeHtmlEntities(rawHref);

    try {
      const url = new URL(decodedHref, this.baseUrl);
      const uddg = url.searchParams.get('uddg');
      if (uddg) {
        return decodeURIComponent(uddg);
      }

      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString();
      }
    } catch {
      if (/^https?:\/\//i.test(decodedHref)) {
        return decodedHref;
      }
    }

    return null;
  }

  private cleanText(value?: string): string {
    if (!value) {
      return '';
    }

    return this.decodeHtmlEntities(value)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
}
