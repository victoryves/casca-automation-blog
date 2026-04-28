import { ExaClient } from '../discovery/exa-client.js';

export type ExaImageScoutCandidate = {
  url: string;
  source_page: string;
  caption: string;
  source_domain?: string;
  is_page_candidate?: boolean;
};

const PREFERRED_IMAGE_SOURCE_DOMAINS = [
  'wikiart.org',
  'artsy.net',
  'mutualart.com',
  'sothebys.com',
  'christies.com',
  'leiloesbr.com.br',
  'catalogodasartes.com.br',
  'iarremate.com',
  'leilaodearte.com',
  'artnet.com',
  'flexagaleria.com',
  'guiadasartes.com.br',
];

const NOISE_PATTERNS = [
  /favicon/i,
  /logo/i,
  /avatar/i,
  /icon/i,
  /sprite/i,
  /header/i,
  /footer/i,
  /gstatic/i,
  /fb-og/i,
  /twitter-card/i,
  /instagram\.com/i,
  /facebook\.com/i,
  /pinterest/i,
];

const WORK_PAGE_PATTERNS = [
  /\/(?:obra|obras|work|works|artwork|lot|lots|leilao|auction|catalogo|catalog|item|iarremate|arremate)\b/i,
  /(?:obra|artwork|lot|leilao|auction|catalogo|quadros?)/i,
];

export class ExaImageScout {
  constructor(private readonly exa: ExaClient) {}

  async searchArtworkImages(artistName: string, limit = 10): Promise<ExaImageScoutCandidate[]> {
    const normalizedArtist = artistName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    const searchQueries = [
      `"${artistName}" quadros obras pintura`,
      `"${artistName}" obra leilao pintura`,
      `"${artistName}" catalogodasartes leilao obra`,
    ];

    const candidates: ExaImageScoutCandidate[] = [];
    const seen = new Set<string>();

    for (const query of searchQueries) {
      const response = await this.exa.searchAndContents({
        query,
        maxResults: Math.min(Math.max(limit * 2, 8), 16),
        useDefaultExcludeDomains: false,
        text: true,
        html: true,
      });

      for (const result of response.results) {
        const content = `${result.title ?? ''}\n${result.content ?? ''}`;
        const html = result.html ?? '';
        const resultIdentityHaystack = `${result.title ?? ''}\n${result.url ?? ''}\n${content}`
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        if (!resultIdentityHaystack.includes(normalizedArtist)) {
          continue;
        }

        const ogMatches = Array.from(
          html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi)
        ).map((match) => match[1]);
        const twitterMatches = Array.from(
          html.matchAll(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi)
        ).map((match) => match[1]);
        const wikiartAnchorMatches = Array.from(
          html.matchAll(/<a[^>]+class=["'][^"']*image[^"']*["'][^>]+href=["']([^"']+)["']/gi)
        ).map((match) => match[1]);
        const directMatches = Array.from(
          `${content}\n${html}`.matchAll(/https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>]*)?/gi)
        ).map((match) => match[0]);
        const genericUrlMatches = Array.from(
          `${content}\n${html}`.matchAll(/https?:\/\/[^\s"'<>]+/gi)
        )
          .map((match) => match[0])
          .filter((value) => this.looksLikeArtworkPage(value));

        const urls = [
          ...(this.isDirectImageUrl(result.url) ? [result.url] : []),
          ...ogMatches,
          ...twitterMatches,
          ...wikiartAnchorMatches,
          ...directMatches,
          ...genericUrlMatches,
          ...(this.looksLikeArtworkPage(result.url) ? [result.url] : []),
        ];

        for (const rawUrl of urls) {
          let url = rawUrl.trim();
          if (!url) continue;
          try {
            url = new URL(url, result.url).toString();
          } catch {
            continue;
          }
          if (this.isNoise(url) || seen.has(url)) continue;
          seen.add(url);
          let sourceDomain: string | undefined;
          try {
            sourceDomain = new URL(result.url).hostname.replace(/^www\./, '');
          } catch {
            sourceDomain = undefined;
          }
          candidates.push({
            url,
            source_page: result.url,
            caption: result.title || `Artwork by ${artistName}`,
            source_domain: sourceDomain,
            is_page_candidate: !this.isDirectImageUrl(url),
          });
        }
      }
    }

    return candidates
      .sort((a, b) => this.domainScore(b.url || b.source_page) - this.domainScore(a.url || a.source_page))
      .slice(0, limit);
  }

  private isDirectImageUrl(url: string): boolean {
    return /\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(url);
  }

  private isNoise(url: string): boolean {
    return NOISE_PATTERNS.some((pattern) => pattern.test(url));
  }

  private looksLikeArtworkPage(url: string): boolean {
    if (this.isNoise(url)) {
      return false;
    }
    if (this.isDirectImageUrl(url)) {
      return true;
    }
    return WORK_PAGE_PATTERNS.some((pattern) => pattern.test(url));
  }

  private domainScore(url: string): number {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      const preferredIndex = PREFERRED_IMAGE_SOURCE_DOMAINS.findIndex(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      );
      if (preferredIndex >= 0) {
        return PREFERRED_IMAGE_SOURCE_DOMAINS.length - preferredIndex;
      }
      if (hostname.endsWith('.org.br') || hostname.endsWith('.com.br')) {
        return 1;
      }
      return 0;
    } catch {
      return 0;
    }
  }
}
