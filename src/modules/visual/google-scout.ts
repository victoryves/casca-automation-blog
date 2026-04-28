import axios from 'axios';
import { getConfig } from '../../config/index.js';

export type GoogleScoutCandidate = {
  url: string;
  source_page: string;
  caption: string;
  source_domain?: string;
};

export class GoogleScout {
  private readonly apiKey = getConfig().env.googleSearchApiKey;
  private readonly searchEngineId = getConfig().env.googleSearchEngineId;

  async searchArtworkImages(artistName: string, limit = 10): Promise<GoogleScoutCandidate[]> {
    if (!this.apiKey || !this.searchEngineId) {
      return [];
    }

    try {
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
        timeout: 20000,
        params: {
          key: this.apiKey,
          cx: this.searchEngineId,
          q: `${artistName} obras de arte quadros`,
          searchType: 'image',
          imgSize: 'medium',
          num: Math.min(Math.max(limit, 1), 10),
          safe: 'off',
          hl: 'pt-BR',
          gl: 'br',
        },
        headers: {
          'User-Agent':
            'CascaArchiveBot/1.0 (https://blog.casca-archive.org; contact@casca-archive.org) Node.js',
        },
      });

      const items = Array.isArray(response.data?.items) ? response.data.items : [];
      return items
        .map((item: any) => {
          const url = String(item.link ?? '').trim();
          if (!url) return null;
          const sourcePage = String(item.image?.contextLink ?? item.displayLink ?? url).trim();
          let sourceDomain: string | undefined;
          try {
            sourceDomain = new URL(sourcePage).hostname.replace(/^www\./, '');
          } catch {
            sourceDomain = undefined;
          }
          return {
            url,
            source_page: sourcePage,
            caption: String(item.title ?? item.snippet ?? `Artwork by ${artistName}`).trim(),
            source_domain: sourceDomain,
          } satisfies GoogleScoutCandidate;
        })
        .filter((item: GoogleScoutCandidate | null): item is GoogleScoutCandidate => Boolean(item));
    } catch (error) {
      console.warn('GoogleScout search failed:', error);
      return [];
    }
  }
}
