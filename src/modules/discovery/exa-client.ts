import axios from 'axios';
import { SearchResponseSchema, type SearchResponse } from '../../types/index.js';
import { DIAMOND_DOMAINS } from './librarian.js';

export interface ExaSearchOptions {
  query: string;
  maxResults?: number;
  category?: 'news' | 'research paper' | 'personal site';
  includeDomains?: string[];
  excludeDomains?: string[];
  useDefaultExcludeDomains?: boolean;
}

export interface ExaSearchAndContentsOptions extends ExaSearchOptions {
  text?: boolean;
  html?: boolean;
}

export interface ExaSearchAndContentsResult {
  title: string;
  url: string;
  content: string;
  html?: string;
  score?: number;
  published_date?: string;
}

export interface ExaSearchAndContentsResponse {
  query: string;
  results: ExaSearchAndContentsResult[];
}

export const EXA_DEFAULT_EXCLUDE_DOMAINS = [
  'pinterest.com',
  'instagram.com',
  'facebook.com',
  'amazon.com',
  'amazon.com.br',
  'mercadolivre.com.br',
  'shopee.com.br',
  'dailyartfair.com',
];

export class ExaClient {
  private readonly baseUrl = 'https://api.exa.ai';
  private readonly timeoutMs = 30_000;

  constructor(private readonly apiKey: string) {}

  async search(options: ExaSearchOptions): Promise<SearchResponse> {
    const excludeDomains = Array.from(
      new Set([
        ...(options.excludeDomains ?? []),
        ...(options.useDefaultExcludeDomains === false ? [] : EXA_DEFAULT_EXCLUDE_DOMAINS),
      ])
    );

    const body: Record<string, unknown> = {
      query: options.query,
      type: 'auto',
      numResults: options.maxResults ?? 10,
      contents: {
        highlights: {
          maxCharacters: 1600,
        },
        text: {
          maxCharacters: 2200,
        },
      },
      excludeDomains,
      includeDomains: options.includeDomains,
      moderation: true,
    };

    if (options.category) {
      body.category = options.category;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await axios.post(`${this.baseUrl}/search`, body, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
          },
          timeout: this.timeoutMs,
        });

        const rawResults = Array.isArray(response.data?.results) ? response.data.results : [];
        const results = rawResults.map((item: Record<string, unknown>) => {
          const contentParts: string[] = [];
          const text = typeof item.text === 'string' ? item.text : '';
          const highlights = Array.isArray(item.highlights)
            ? item.highlights.filter((value): value is string => typeof value === 'string')
            : [];

          if (highlights.length > 0) contentParts.push(highlights.join('\n'));
          if (text) contentParts.push(text);

          return {
            title: typeof item.title === 'string' ? item.title : '',
            url: typeof item.url === 'string' ? item.url : '',
            content: contentParts.join('\n\n').trim(),
            score: typeof item.score === 'number' ? item.score : undefined,
            published_date:
              typeof item.publishedDate === 'string'
                ? item.publishedDate
                : typeof item.published_date === 'string'
                  ? item.published_date
                  : undefined,
          };
        }).sort((a: SearchResponse['results'][number], b: SearchResponse['results'][number]) =>
          this.domainPriorityScore(b.url) - this.domainPriorityScore(a.url)
        );

        return SearchResponseSchema.parse({
          query: options.query,
          results,
        });
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryableError(error);
        console.warn(
          `Exa search failed (attempt ${attempt + 1}/3): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (!retryable || attempt === 2) {
          break;
        }
        const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    if (axios.isAxiosError(lastError)) {
      throw new Error(`Exa API error: ${lastError.response?.data?.error ?? lastError.message}`);
    }

    throw lastError;
  }

  async searchAndContents(
    options: ExaSearchAndContentsOptions
  ): Promise<ExaSearchAndContentsResponse> {
    const excludeDomains = Array.from(
      new Set([
        ...(options.excludeDomains ?? []),
        ...(options.useDefaultExcludeDomains === false ? [] : EXA_DEFAULT_EXCLUDE_DOMAINS),
      ])
    );

    const body: Record<string, unknown> = {
      query: options.query,
      type: 'auto',
      numResults: options.maxResults ?? 10,
      contents: {
        text: options.text ? { maxCharacters: 5000 } : undefined,
        html: options.html ? true : undefined,
      },
      excludeDomains,
      includeDomains: options.includeDomains,
      moderation: true,
    };

    const response = await axios.post(`${this.baseUrl}/search`, body, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      timeout: this.timeoutMs,
    });

    const rawResults = Array.isArray(response.data?.results) ? response.data.results : [];
    const results = rawResults.map((item: Record<string, unknown>) => ({
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.url === 'string' ? item.url : '',
      content: typeof item.text === 'string' ? item.text : '',
      html: typeof item.html === 'string' ? item.html : undefined,
      score: typeof item.score === 'number' ? item.score : undefined,
      published_date:
        typeof item.publishedDate === 'string'
          ? item.publishedDate
          : typeof item.published_date === 'string'
            ? item.published_date
            : undefined,
    }));

    return {
      query: options.query,
      results,
    };
  }

  private isRetryableError(error: unknown): boolean {
    const message = axios.isAxiosError(error)
      ? `${error.code ?? ''} ${error.message} ${error.response?.status ?? ''}`
      : error instanceof Error
        ? error.message
        : String(error);

    return /403|408|409|429|500|502|503|504|timeout|econnreset|socket|network/i.test(message);
  }

  private domainPriorityScore(url: string): number {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      if (DIAMOND_DOMAINS.some((item) => domain === item || domain.endsWith(`.${item}`))) {
        return 100;
      }
      if (domain.endsWith('.gov.br') || domain.endsWith('.edu.br') || domain.endsWith('.org.br')) {
        return 50;
      }
      return 0;
    } catch {
      return 0;
    }
  }
}
