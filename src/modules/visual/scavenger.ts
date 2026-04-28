import type { Image } from '../../types/index.js';
import { VisualModule, type VisualArtistInfo } from './index.js';

const UI_NOISE_PATTERNS = [
  'favicon',
  'logo',
  'avatar',
  'icon',
  'sprite',
  'header',
  'footer',
  'gstatic',
  'fb-og',
  'twitter-card',
];

const HIGH_RES_AUCTION_DOMAINS = ['leiloesbr.com.br', 'catagano.com.br', 'iam-pba.com.br'];
const HIGH_RES_CONTENT_LENGTH_FLOOR = 500 * 1024;

export function isUINoise(url: string): boolean {
  const normalized = url.toLowerCase();
  return UI_NOISE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function isQuarantined(url: string, artistName: string): boolean {
  const normalizedUrl = url.toLowerCase();
  const normalizedArtist = artistName.trim().toLowerCase();

  if (normalizedArtist === 'gilvan samico' && normalizedUrl.includes('itaucultural.org.br')) {
    return true;
  }

  return false;
}

export function forceHighResUrl(url: string): string {
  let normalized = url.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/');

  if (/^https:\/\/lh3\.googleusercontent\.com\//i.test(normalized)) {
    if (/=(?:s\d+|s0)$/i.test(normalized)) {
      normalized = normalized.replace(/=(?:s\d+|s0)$/i, '=s4000');
    } else {
      normalized = `${normalized}=s4000`;
    }
  }

  normalized = normalized
    .replace(/\/thumbnails\//gi, '/original/')
    .replace(/\/thumbs\//gi, '/original/')
    .replace(/\/thumb\//gi, '/original/')
    .replace(/\/miniaturas\//gi, '/original/')
    .replace(/\/medium\//gi, '/large/')
    .replace(/\/small\//gi, '/large/')
    .replace(/\/preview\//gi, '/full/')
    .replace(/-t(\.(?:jpg|jpeg|png|webp))/gi, '-o$1')
    .replace(/_thumb(?=\.)/gi, '')
    .replace(/_thumbnail(?=\.)/gi, '')
    .replace(/\/fundo_/gi, '/original/')
    .replace(/[?&]size=small\b/gi, (match) => match.replace(/small/gi, 'large'))
    .replace(/[?&]w=(?:300|400|480|600|800)\b/gi, (match) => match.replace(/\d+/g, '1600'))
    .replace(/[?&]h=(?:300|400|480|600|800)\b/gi, (match) => match.replace(/\d+/g, '1600'));

  if (/itaucultural\.org\.br/i.test(normalized) && !/\/(obras|acervo)\b/i.test(normalized) && /\/pessoas?\//i.test(normalized)) {
    normalized = normalized.replace(/(\/pessoas?\/[^/?#]+(?:-[^/?#]+)*)(?:[/?#].*)?$/i, '$1/obras');
  }

  return normalized;
}

function buildHighResGuessUrls(url: string): string[] {
  const normalized = forceHighResUrl(url);
  const variants = new Set<string>([normalized]);

  const replacements: Array<[RegExp, string]> = [
    [/\/thumb\//gi, '/original/'],
    [/\/thumb\//gi, '/full/'],
    [/\/small\//gi, '/large/'],
    [/\/small\//gi, '/full/'],
    [/\/preview\//gi, '/full/'],
    [/\/preview\//gi, '/original/'],
    [/\/medium\//gi, '/large/'],
    [/\/medium\//gi, '/full/'],
    [/_thumb(?=\.)/gi, ''],
    [/_thumbnail(?=\.)/gi, ''],
    [/-t(?=\.(?:jpg|jpeg|png|webp))/gi, '-o'],
    [/([?&])size=small\b/gi, '$1size=large'],
    [/([?&])w=(?:300|400|480|600|800)\b/gi, '$1w=1600'],
    [/([?&])h=(?:300|400|480|600|800)\b/gi, '$1h=1600'],
  ];

  for (const [pattern, replacement] of replacements) {
    if (pattern.test(normalized)) {
      variants.add(normalized.replace(pattern, replacement));
    }
  }

  if (/^https:\/\/lh3\.googleusercontent\.com\//i.test(normalized)) {
    variants.add(/=(?:s\d+|s0)$/i.test(normalized) ? normalized.replace(/=(?:s\d+|s0)$/i, '=s4000') : `${normalized}=s4000`);
    variants.add(/=(?:s\d+|s0)$/i.test(normalized) ? normalized.replace(/=(?:s\d+|s0)$/i, '=s0') : `${normalized}=s0`);
  }

  return [...variants];
}

async function probeCandidateHead(url: string): Promise<{ ok: boolean; contentLength: number }> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(4000),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; CascaAssetProbe/1.0)',
      },
    });

    if (!response.ok) {
      return { ok: false, contentLength: 0 };
    }

    const contentLength = Number(response.headers.get('content-length') || '0');
    return { ok: true, contentLength: Number.isFinite(contentLength) ? contentLength : 0 };
  } catch {
    return { ok: false, contentLength: 0 };
  }
}

export async function resolveHighResGuess(
  url: string
): Promise<{ url: string; verifiedLarge: boolean; contentLength: number }> {
  const variants = buildHighResGuessUrls(url);
  let fallback = forceHighResUrl(url);

  for (const candidate of variants) {
    const probe = await probeCandidateHead(candidate);
    if (probe.ok && probe.contentLength > 0 && candidate !== url) {
      fallback = candidate;
    }
    if (probe.ok && probe.contentLength >= HIGH_RES_CONTENT_LENGTH_FLOOR) {
      return {
        url: candidate,
        verifiedLarge: true,
        contentLength: probe.contentLength,
      };
    }
  }

  return {
    url: fallback,
    verifiedLarge: false,
    contentLength: 0,
  };
}

export class VisualScavenger {
  constructor(private readonly visual: VisualModule) {}

  tryExpandUrl(url: string): string[] {
    const normalized = forceHighResUrl(url);
    const expanded = new Set<string>([normalized]);

    if (/^https:\/\/lh3\.googleusercontent\.com\//i.test(normalized)) {
      if (/=(?:s\d+|s0)$/i.test(normalized)) {
        expanded.add(normalized.replace(/=(?:s\d+|s0)$/i, '=s4000'));
        expanded.add(normalized.replace(/=(?:s\d+|s0)$/i, '=s0'));
      } else {
        expanded.add(`${normalized}=s4000`);
        expanded.add(`${normalized}=s0`);
      }
    }

    if (normalized.includes('/thumbnails/')) {
      expanded.add(normalized.replace('/thumbnails/', '/original/'));
      expanded.add(normalized.replace('/thumbnails/', '/expanded/'));
      expanded.add(normalized.replace('/thumbnails/', '/'));
    }

    if (normalized.includes('/fundo_')) {
      expanded.add(normalized.replace('/fundo_', '/original/'));
      expanded.add(normalized.replace('/fundo_', '/expanded/'));
    }

    if (normalized.includes('/thumb/')) {
      expanded.add(normalized.replace('/thumb/', '/original/'));
      expanded.add(normalized.replace('/thumb/', '/expanded/'));
    }

    if (normalized.includes('/small/')) {
      expanded.add(normalized.replace('/small/', '/original/'));
      expanded.add(normalized.replace('/small/', '/expanded/'));
      expanded.add(normalized.replace('/small/', '/zoom/'));
    }

    if (normalized.includes('/preview/')) {
      expanded.add(normalized.replace('/preview/', '/original/'));
      expanded.add(normalized.replace('/preview/', '/expanded/'));
      expanded.add(normalized.replace('/preview/', '/zoom/'));
    }

    return [...expanded];
  }

  extractFullViewAnchors(html: string, baseUrl: string): string[] {
    const matches = new Set<string>();
    const anchorPattern = /<(a|button)[^>]+(?:href|data-href|data-zoom|data-full|data-original)=["']([^"']+)["'][^>]*>/gi;
    const assetPattern = /(?:data-full-res|data-fullres|data-original|data-zoom|data-full|src)=["']([^"']+)["']/gi;

    for (const match of html.matchAll(anchorPattern)) {
      const rawUrl = match[2]?.trim();
      if (!rawUrl) continue;
      const tag = match[0]?.toLowerCase() ?? '';
      if (!/(zoom|full|original|expanded|ampliar|ampliado|detalhe)/i.test(tag) && !/(zoom|full|original|expanded)/i.test(rawUrl)) {
        continue;
      }

      try {
        const absolute = new URL(rawUrl, baseUrl).toString();
        if (!isUINoise(absolute)) {
          matches.add(absolute);
        }
      } catch {
        continue;
      }
    }

    for (const match of html.matchAll(assetPattern)) {
      const rawUrl = match[1]?.trim();
      if (!rawUrl) continue;
      try {
        const absolute = new URL(rawUrl, baseUrl).toString();
        if (!isUINoise(absolute)) {
          matches.add(absolute);
        }
      } catch {
        continue;
      }
    }

    if (/enciclopedia\.itaucultural\.org\.br\/pessoas?\//i.test(baseUrl)) {
      try {
        matches.add(new URL('./obras', baseUrl).toString());
      } catch {
        // ignore malformed base URL
      }
      const obraLinkPattern = /<a[^>]+href=["']([^"']*\/obras(?:\?[^"']*)?)["'][^>]*>/gi;
      for (const match of html.matchAll(obraLinkPattern)) {
        const rawUrl = match[1]?.trim();
        if (!rawUrl) continue;
        try {
          const absolute = new URL(rawUrl, baseUrl).toString();
          if (!isUINoise(absolute)) {
            matches.add(absolute);
          }
        } catch {
          continue;
        }
      }
    }

    return [...matches];
  }

  async recoverMissingImages(
    artist: VisualArtistInfo,
    approvedImages: Image[],
    missingSlots: number,
    options: { institutionalOnly?: boolean } = {}
  ): Promise<{
    approved: Image[];
    rejected: Array<{ image: Image; reason: string }>;
  }> {
    return this.visual.scavengeMissingArtworkImages(artist, approvedImages, missingSlots, options);
  }

  async recoverHighResInstitutionalImages(
    artist: VisualArtistInfo,
    approvedImages: Image[],
    missingSlots: number
  ): Promise<{
    approved: Image[];
    rejected: Array<{ image: Image; reason: string }>;
  }> {
    return this.visual.scavengeMissingArtworkImages(artist, approvedImages, missingSlots, {
      institutionalOnly: true,
    });
  }

  async recoverDeepInstitutionalImages(
    artist: VisualArtistInfo,
    approvedImages: Image[],
    missingSlots: number
  ): Promise<{
    approved: Image[];
    rejected: Array<{ image: Image; reason: string }>;
  }> {
    return this.visual.scavengeMissingArtworkImages(artist, approvedImages, missingSlots, {
      institutionalOnly: true,
    });
  }
}

export function isHighResAuctionSource(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return (
      HIGH_RES_AUCTION_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)) ||
      hostname === 'artsy.net' ||
      hostname.endsWith('.artsy.net')
    );
  } catch {
    return false;
  }
}
