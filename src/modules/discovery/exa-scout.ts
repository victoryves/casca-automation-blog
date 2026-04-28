import { ExaClient } from './exa-client.js';

export type ExaScoutImageCandidate = {
  url: string;
  source_page: string;
  caption: string;
  source_domain?: string;
  reported_width?: number;
  reported_height?: number;
  reported_file_size?: number;
};

const PRIORITY_DOMAINS = [
  'leiloesbr.com.br',
  'iam-pba.com.br',
  'catalogodasartes.com.br',
  'artsy.net',
  'mutualart.com',
  'artnet.com',
  'christies.com',
  'sothebys.com',
  'google.com',
  'artsandculture.google.com',
];

const EXA_NOISE_PATTERNS = [
  /thumbnail/i,
  /thumbs?\//i,
  /low[-_ ]?res/i,
  /social/i,
  /instagram\.com/i,
  /facebook\.com/i,
  /pinterest/i,
];

export class ExaScout {
  constructor(private readonly exa: ExaClient) {}

  async findHighResArtworkCandidates(
    artistName: string,
    maxResults = 8
  ): Promise<ExaScoutImageCandidate[]> {
    const normalizedArtist = artistName.trim().toLowerCase();
    const enforcePainterContext = process.argv.includes('--enforce-painter-context');
    const rawAssetsOnly = process.argv.includes('--raw-assets-only');
    const directFileContext =
      "Direct original image file (JPG/PNG) for paintings, high resolution (2000px+), hosted on Christie's, Sotheby's, MutualArt, Artnet, Artsy, or auction catalogs. Exclude /thumb/, /small/, /medium/, previews, and itaucultural.";
    const query =
      normalizedArtist === 'hamurabi batista'
        ? `"Hamurabi Batista" artista plástico Recife pintura artes visuais -poesia -poema -livro -rei -babilonia ${directFileContext}`
        : `${rawAssetsOnly ? `High resolution direct JPG of ${artistName} painting, 2000px+, source:leiloesbr.com.br OR source:artsy.net OR source:sothebys.com. Deprioritize .org.br and .gov domains.` : directFileContext} for ${artistName} (${enforcePainterContext ? 'Brazilian visual artist, painter, printmaker' : 'Brazilian painter/printmaker'}). Exclude thumbnails, previews, low-resolution scans, social media reposts, historical artifacts, archaeological objects, and itaucultural results.${enforcePainterContext ? ' Favor results that mention artes visuais, pintura, gravura, or artista plástico. Exclude poetry, poems, books, manuscripts, or literary pages.' : ''}`;
    const response = await this.exa.search({
      query,
      maxResults,
      includeDomains: PRIORITY_DOMAINS,
    });

    const candidates: ExaScoutImageCandidate[] = [];
    for (const result of response.results) {
      const content = `${result.title}\n${result.content}`;
      const imageUrls = Array.from(content.matchAll(/https?:\/\/[^\s)"'>]+/g))
        .map((match) => match[0])
        .filter(
          (url) =>
            !/itaucultural/i.test(url) &&
            !EXA_NOISE_PATTERNS.some((pattern) => pattern.test(url)) &&
            !/\/(?:thumb|small|medium)\//i.test(url) &&
            (/\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(url) ||
              /googleusercontent|iiif|image|artwork|full|original|large/i.test(url))
        );

      for (const imageUrl of imageUrls) {
        const lower = content.toLowerCase();
        const widthMatch = lower.match(/(?:width|w)\D{0,8}(\d{3,5})/i);
        const heightMatch = lower.match(/(?:height|h)\D{0,8}(\d{3,5})/i);
        const fileSizeMatch = lower.match(/(\d+(?:\.\d+)?)\s*(kb|mb)/i);
        const reportedFileSize = fileSizeMatch
          ? Math.round(Number(fileSizeMatch[1]) * (fileSizeMatch[2].toLowerCase() === 'mb' ? 1024 * 1024 : 1024))
          : undefined;

        candidates.push({
          url: imageUrl,
          source_page: result.url,
          caption: result.title || `Artwork by ${artistName}`,
          source_domain: (() => {
            try {
              return new URL(result.url).hostname.replace(/^www\./, '');
            } catch {
              return undefined;
            }
          })(),
          reported_width: widthMatch ? Number(widthMatch[1]) : undefined,
          reported_height: heightMatch ? Number(heightMatch[1]) : undefined,
          reported_file_size: reportedFileSize,
        });
      }
    }

    return candidates.filter(
      (candidate, index, list) =>
        !EXA_NOISE_PATTERNS.some((pattern) => pattern.test(candidate.url)) &&
        list.findIndex((entry) => entry.url === candidate.url) === index
    );
  }
}
