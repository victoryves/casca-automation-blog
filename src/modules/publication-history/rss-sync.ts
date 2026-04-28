import { librarianPendingReviewOps, publicationHistoryOps } from '../../db/operations/index.js';
import { GeminiClient } from '../../lib/gemini.js';
import { getConfig } from '../../config/index.js';

export interface RssPublicationEntry {
  artistName: string;
  normalizedArtistName: string;
  title: string;
  url: string;
  description?: string;
  content?: string;
  publishedAt?: string;
  source: 'rss_feed';
}

export interface RssPendingReviewEntry {
  originalTitle: string;
  resolvedName: string;
  normalizedResolvedName: string;
  confidence: number;
  reasoning: string;
  url: string;
  description?: string;
  content?: string;
}

export interface RssSyncResult {
  synced: RssPublicationEntry[];
  pendingReview: RssPendingReviewEntry[];
}

const GENERIC_EDITORIAL_PREFIXES = [
  'the master',
  'the mystical',
  'the poetry',
  'the visionary',
  'the sacred',
  'the woodcut',
  'the cangaco',
  'the satirical',
  'the adopted',
  'the mythmaker',
  'the enduring',
  'he turned',
  'why ',
  'por que ',
  'decoding ',
];

function extractContentEncoded(block: string): string {
  const match = block.match(/<content:encoded\b[^>]*>([\s\S]*?)<\/content:encoded>/i);
  return match?.[1]?.trim() ?? '';
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

export function normalizeArtistNameFromTitle(title: string): string {
  const cleanedTitle = decodeXml(title).trim();
  if (!cleanedTitle) {
    return '';
  }

  const colonSplit = cleanedTitle.split(/\s*:\s*/);
  const leadingChunk = colonSplit[0]?.trim() ?? cleanedTitle;
  const collapsed = leadingChunk.replace(/[’']/g, "'");

  const directPatterns = [
    /^Decoding\s+(.+)$/i,
    /^Why\s+(.+?)\s+Is Worth Watching$/i,
    /^The Enduring Light in\s+(.+?)'s\s+World$/i,
    /^(.+?)'s\s+Lens$/i,
    /^(.+?)'s\s+Quadrinhos$/i,
    /^(.+?)'s\s+World$/i,
    /^(.+?)\s+and\s+the\s+.+$/i,
    /^(.+?)\s+where\s+.+$/i,
  ];

  for (const pattern of directPatterns) {
    const match = collapsed.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return collapsed.trim();
}

function shouldUseLlmExtraction(title: string, extractedName: string): boolean {
  const normalizedTitle = publicationHistoryOps.normalizeArtistName(title);
  const normalizedExtracted = publicationHistoryOps.normalizeArtistName(extractedName);
  if (!normalizedExtracted) {
    return true;
  }

  if (GENERIC_EDITORIAL_PREFIXES.some((prefix) => normalizedTitle.startsWith(prefix))) {
    return true;
  }

  if (normalizedExtracted.length > 60) {
    return true;
  }

  if (/\(|\)/.test(extractedName) && extractedName.split(/\s+/).length > 6) {
    return true;
  }

  return false;
}

function isTitleEditorialOrAbstract(title: string): boolean {
  const normalizedTitle = publicationHistoryOps.normalizeArtistName(title);
  return GENERIC_EDITORIAL_PREFIXES.some((prefix) => normalizedTitle.startsWith(prefix));
}

function looksLikeArtistName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.length > 80) {
    return false;
  }

  const normalized = publicationHistoryOps.normalizeArtistName(trimmed);
  if (!normalized) {
    return false;
  }

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 7) {
    return false;
  }

  const bannedTokens = new Set([
    'the',
    'he',
    'she',
    'turned',
    'into',
    'brazilian',
    'masterpieces',
    'why',
    'worth',
    'watching',
    'por',
    'que',
    'este',
    'acervo',
    'ingles',
    'legacy',
    'soul',
    'hidden',
    'roots',
  ]);

  const bannedOverlap = tokens.filter((token) => bannedTokens.has(token)).length;
  return bannedOverlap <= 1;
}

function appearsExplicitlyInContext(artistName: string, ...haystacks: Array<string | undefined>): boolean {
  const normalizedArtistName = publicationHistoryOps.normalizeArtistName(artistName);
  if (!normalizedArtistName) {
    return false;
  }

  return haystacks.some((haystack) => {
    const normalizedHaystack = publicationHistoryOps.normalizeArtistName(haystack ?? '');
    return normalizedHaystack.includes(normalizedArtistName);
  });
}

async function extractArtistNameWithGemini(
  title: string,
  description = '',
  content = ''
): Promise<{ artistName: string; confidence: number; reasoning: string }> {
  const config = getConfig();
  const models = ['gemini-1.5-flash', 'gemini-2.5-flash'];
  const contextSummary = [description, content]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\s+/g, ' ')
    .slice(0, 1400);
  for (const model of models) {
    try {
      const gemini = new GeminiClient(config.env.geminiApiKey, model);
      const response = await gemini.generateText({
        model,
        temperature: 0,
        maxOutputTokens: 180,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['artistName', 'confidence', 'reasoning'],
          properties: {
            artistName: { type: 'string' },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
          },
        },
        systemInstruction:
          'Identify the primary visual artist from editorial article metadata. Return strict JSON only.',
        userPrompt: `Based on the article title "${title}" and this summary "${contextSummary}", identify the full name of the primary visual artist. Return JSON in the format {"artistName":"", "confidence":0-1, "reasoning":""}. Confidence must be high only when the artist is explicitly named in the title or summary, or when the identity is unambiguous from concrete context. If you are deducing from poetic or abstract clues, lower the confidence. Return only the artist name, never the article title.`,
      });

      try {
        const parsed = JSON.parse(response) as {
          artistName?: string;
          confidence?: number;
          reasoning?: string;
        };
        return {
          artistName: parsed.artistName?.trim() ?? '',
          confidence:
            typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
              ? Math.max(0, Math.min(1, parsed.confidence))
              : 0,
          reasoning: parsed.reasoning?.trim() ?? '',
        };
      } catch {
        return { artistName: '', confidence: 0, reasoning: 'invalid-json' };
      }
    } catch (error) {
      continue;
    }
  }

  return { artistName: '', confidence: 0, reasoning: 'no-model-available' };
}

export async function fetchRssArtistNames(
  rssUrl = 'https://blog.casca-archive.org/rss.xml'
): Promise<RssSyncResult> {
  const config = getConfig();
  const epithetMappings = new Map(
    config.epithets.mappings.map((entry) => [
      publicationHistoryOps.normalizeArtistName(entry.epithet),
      entry.artist_name,
    ])
  );
  const response = await fetch(rssUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  });

  const text = await response.text();
  if (!response.ok || !/<rss[\s>]|<feed[\s>]/i.test(text)) {
    throw new Error(`RSS fetch failed for ${rssUrl}: ${response.status}`);
  }

  const items = [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  const entries: RssPublicationEntry[] = [];
  const pendingReview: RssPendingReviewEntry[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const block = item[0];
    const title = decodeXml(extractTag(block, 'title'));
    const url = decodeXml(extractTag(block, 'link'));
    const description = decodeXml(extractTag(block, 'description'));
    const content = decodeXml(extractContentEncoded(block));
    const publishedAt = decodeXml(extractTag(block, 'pubDate'));
    let artistName = normalizeArtistNameFromTitle(title);
    let confidence = 0.9;
    let reasoning = 'regex-match';
    let fromEpithetMap = false;
    const mappedByEpithet = epithetMappings.get(publicationHistoryOps.normalizeArtistName(artistName));
    if (mappedByEpithet) {
      artistName = mappedByEpithet;
      confidence = 1;
      reasoning = 'epithet-map';
      fromEpithetMap = true;
    } else if (shouldUseLlmExtraction(title, artistName)) {
      const existing = await publicationHistoryOps.findByPostUrl(url);
      if (
        existing?.artist_name?.trim() &&
        !shouldUseLlmExtraction(title, existing.artist_name.trim())
      ) {
        artistName = existing.artist_name.trim();
        confidence = 1;
        reasoning = 'existing-post-url-match';
      } else {
        const llmResult = await extractArtistNameWithGemini(title, description, content);
        if (llmResult.artistName) {
          artistName = llmResult.artistName;
          confidence = llmResult.confidence;
          reasoning = llmResult.reasoning || 'llm-contextual';
        }
      }
    }
    const normalizedArtistName = publicationHistoryOps.normalizeArtistName(artistName);

    if (!looksLikeArtistName(artistName)) {
      confidence = Math.min(confidence, 0.35);
      reasoning = reasoning ? `${reasoning};implausible-name-shape` : 'implausible-name-shape';
    }

    const editorialAbstractTitle = isTitleEditorialOrAbstract(title);
    const explicitInTitle = appearsExplicitlyInContext(artistName, title);
    const explicitInBody = appearsExplicitlyInContext(artistName, description, content);

    if (artistName && !fromEpithetMap && editorialAbstractTitle && !explicitInTitle) {
      confidence = Math.min(confidence, explicitInBody ? 0.84 : 0.6);
      reasoning = reasoning
        ? `${reasoning};editorial-title-without-explicit-name`
        : 'editorial-title-without-explicit-name';
    } else if (
      artistName &&
      !fromEpithetMap &&
      editorialAbstractTitle &&
      !explicitInBody
    ) {
      confidence = Math.min(confidence, 0.6);
      reasoning = reasoning ? `${reasoning};name-not-explicit` : 'name-not-explicit';
    }

    if (!artistName || !normalizedArtistName || !url) {
      continue;
    }

    const key = `${normalizedArtistName}|${url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (confidence >= 0.85) {
      entries.push({
        artistName,
        normalizedArtistName,
        title,
        url,
        description: description || undefined,
        content: content || undefined,
        publishedAt: publishedAt || undefined,
        source: 'rss_feed',
      });
    } else {
      await publicationHistoryOps.deleteByPostUrl(url);
      pendingReview.push({
        originalTitle: title,
        resolvedName: artistName,
        normalizedResolvedName: normalizedArtistName,
        confidence,
        reasoning,
        url,
        description: description || undefined,
        content: content || undefined,
      });
    }
  }

  return {
    synced: entries,
    pendingReview,
  };
}

export async function syncRssFeedToPublicationHistory(
  rssUrl = 'https://blog.casca-archive.org/rss.xml'
): Promise<RssSyncResult> {
  const { synced, pendingReview } = await fetchRssArtistNames(rssUrl);
  const syncedAt = new Date().toISOString();

  for (const entry of synced) {
    await publicationHistoryOps.upsert({
      artist_name: entry.artistName,
      normalized_artist_name: entry.normalizedArtistName,
      post_title: entry.title,
      post_url: entry.url,
      source: entry.source,
      published_at: entry.publishedAt ?? null,
      synced_at: syncedAt,
    });
  }

  for (const entry of pendingReview) {
    await librarianPendingReviewOps.upsert({
      original_title: entry.originalTitle,
      resolved_name: entry.resolvedName,
      normalized_resolved_name: entry.normalizedResolvedName,
      confidence: entry.confidence,
      reasoning: entry.reasoning,
      url: entry.url,
      description: entry.description ?? null,
      content: entry.content ?? null,
    });
  }

  return {
    synced,
    pendingReview,
  };
}
