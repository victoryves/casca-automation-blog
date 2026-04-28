import { GeminiClient } from '../../lib/gemini.js';
import { query } from '../../db/client.js';
import { artistOps, draftOps, sourceOps } from '../../db/operations/index.js';
import { getConfig } from '../../config/index.js';
import { PublicationHistoryModule } from '../publication-history/index.js';
import { isDiamondDomain } from '../discovery/librarian.js';
import { ExaClient } from '../discovery/exa-client.js';
import { DuckDuckGoClient } from '../discovery/duckduckgo-client.js';
import { ScraperBridge } from '../scraper-bridge/index.js';
import { assessSourceWithLibrarian } from '../discovery/librarian.js';
import type { Artist, Source, SearchResult } from '../../types/index.js';
import { BaseAgent, type AgentTickResult } from './base.js';

interface CleanedSummary {
  usable: boolean;
  cleanedSummary: string;
  reason: string;
}

interface BioMetadata {
  birth_year?: string;
  birth_city?: string;
}

const READY_FLOOR = 5;
const HYPERDRIVE_SLEEP_MS = 10_000;
const MAX_FAILURES = 3;
const MIN_COMBINED_SOURCE_LENGTH = 1500;
const DIAMOND_MIN_COMBINED_SOURCE_LENGTH = 1000;
const MIN_RESEARCH_SYNTHESIS_WORDS = 450;
const MAX_RESEARCH_SYNTHESIS_WORDS = 700;
const MAX_RESEARCH_PARAGRAPHS = 4;
const RESEARCH_JUNK_PATTERNS = [
  'get the app',
  'join us',
  'buy',
  'login',
  'log in',
  'sign up',
  'privacy policy',
  'cookie',
  'marketplace',
  'skip to main content',
  'aceitar cookies',
  'assine nossa newsletter',
  'subscribe to our newsletter',
];

function requiresNortheastValidation(artist: Artist): boolean {
  if (artist.full_name.trim().toLowerCase() === 'hamurabi batista') {
    return true;
  }
  const metadata = artistOps.parseMetadata(artist);
  return metadata.exa_replenished === true;
}

function passesNortheastValidation(summary: string): boolean {
  const normalized = summary.toLowerCase();
  return /northeast brazil|northeastern brazil|pernambuco|recife|ceara|bahia|paraiba|sergipe|alagoas|rio grande do norte|maranhao|piaui/.test(
    normalized
  );
}

function failsHamurabiIdentityGuard(text: string): boolean {
  const normalized = text.toLowerCase().slice(0, 500);
  const lacksVisualAnchor = !/(pintura|pintor|artista plastico|artista plástico|artes visuais|gravura|printmaker)/.test(
    normalized
  );
  const hasLiteraryCollision = /(poesia|poeta|poema|literatura|livro)/.test(normalized);
  return lacksVisualAnchor || hasLiteraryCollision;
}

export class ResearchAgent extends BaseAgent {
  private readonly gemini = new GeminiClient(getConfig().env.geminiApiKey);
  private readonly scraperBridge = new ScraperBridge();
  private readonly exaClient = new ExaClient(getConfig().env.exaApiKey);
  private readonly duckDuckGoClient = new DuckDuckGoClient();
  private readonly publicationHistory = new PublicationHistoryModule({
    rssUrl: getConfig().env.rssUrl,
    hashnodeApiKey: getConfig().env.hashnodeApiKey,
    hashnodePublicationId: getConfig().env.hashnodePublicationId,
  });

  constructor() {
    super('research-agent', {
      pollIntervalMs: 45_000,
      maxBackoffMs: 15 * 60 * 1000,
    });
  }

  protected async tick(): Promise<AgentTickResult> {
    const readyCount = await draftOps.countByStatus('ready');
    const hyperDrive = readyCount < READY_FLOOR;
    const batchSize = hyperDrive ? 4 : 1;
    const artists = query.all<Artist>(
      `SELECT *
       FROM artists
       WHERE status = 'discovered'
       ORDER BY priority DESC, discovered_at ASC
       LIMIT ?`,
      [batchSize]
    );

    if (artists.length === 0) {
      return {
        worked: false,
        detail: 'queue-empty:discovered',
        sleepMs: hyperDrive ? HYPERDRIVE_SLEEP_MS : 3 * 60 * 1000,
      };
    }

    const publishedHaystacks = await this.publicationHistory.getPublishedPostHaystacks();
    const settled = await Promise.allSettled(
      artists.map((artist) => this.processArtist(artist, publishedHaystacks))
    );

    let processed = 0;
    let researched = 0;
    let duplicates = 0;
    let pendingMoreSources = 0;
    let permanent = 0;
    let failures = 0;

    for (const item of settled) {
      if (item.status === 'fulfilled') {
        processed += 1;
        researched += item.value.researched;
        duplicates += item.value.duplicates;
        pendingMoreSources += item.value.pendingMoreSources;
        permanent += item.value.permanent;
        failures += item.value.failures;
      } else {
        failures += 1;
      }
    }

    return {
      worked: researched > 0 || duplicates > 0 || pendingMoreSources > 0,
      detail: `mode:${hyperDrive ? 'hyperdrive' : 'cruise'};processed:${processed};researched:${researched};duplicates:${duplicates};pending_more_sources:${pendingMoreSources};permanent:${permanent};failures:${failures};ready:${readyCount}`,
      sleepMs: hyperDrive ? HYPERDRIVE_SLEEP_MS : undefined,
    };
  }

  private async processArtist(
    artist: Artist,
    publishedHaystacks: string[]
  ): Promise<{
    researched: number;
    duplicates: number;
    pendingMoreSources: number;
    permanent: number;
    failures: number;
  }> {
    if (!artist.id) {
      return { researched: 0, duplicates: 0, pendingMoreSources: 0, permanent: 0, failures: 1 };
    }

    const normalizedName = artist.full_name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (publishedHaystacks.some((haystack) => haystack.includes(normalizedName))) {
      await artistOps.updateStatus(artist.id, 'rejected');
      return { researched: 0, duplicates: 1, pendingMoreSources: 0, permanent: 0, failures: 0 };
    }

    const sources = await sourceOps.findByArtistId(artist.id);
    if (sources.length === 0) {
      const permanent = await this.registerFailure(
        artist.id,
        artist.full_name,
        'research:no-sources'
      );
      return { researched: 0, duplicates: 0, pendingMoreSources: 0, permanent, failures: 1 };
    }

    const config = getConfig();
    const rankedSources = sources
      .map((source) => ({
        source,
        librarian: assessSourceWithLibrarian(source.url, config, source.credibility_score ?? 0),
      }))
      .filter((entry) => !entry.librarian.blocked)
      .sort((a, b) => {
        if (b.librarian.boost !== a.librarian.boost) return b.librarian.boost - a.librarian.boost;
        return (b.source.credibility_score ?? 0) - (a.source.credibility_score ?? 0);
      });

    const approvedSources = rankedSources
      .filter((entry) => entry.librarian.priority !== 'low')
      .slice(0, 3)
      .map((entry) => entry.source);

    const researchSources = (approvedSources.length > 0 ? approvedSources : rankedSources.slice(0, 3).map((entry) => entry.source)).slice(0, 3);
    const combinedRawText = await this.buildCombinedSourceText(artist, researchSources);
    if (artist.full_name.trim().toLowerCase() === 'hamurabi batista' && failsHamurabiIdentityGuard(combinedRawText)) {
      await artistOps.updateStatus(artist.id, 'pending_more_sources');
      await artistOps.updatePriority(artist.id, 0);
      await artistOps.mergeMetadata(artist.id, {
        pending_more_sources_reason: 'research:identity-collision-hamurabi',
        pending_more_sources_at: new Date().toISOString(),
      });
      return { researched: 0, duplicates: 0, pendingMoreSources: 1, permanent: 0, failures: 0 };
    }
    const hasDiamondSource = researchSources.some((source) => isDiamondDomain(source.url));
    const minimumCombinedLength = hasDiamondSource
      ? DIAMOND_MIN_COMBINED_SOURCE_LENGTH
      : MIN_COMBINED_SOURCE_LENGTH;

    if (combinedRawText.length < minimumCombinedLength) {
      const enrichedResearchSources = await this.enrichResearchSourcesForThinText(artist, researchSources);
      if (enrichedResearchSources.length > researchSources.length) {
        const enrichedRawText = await this.buildCombinedSourceText(artist, enrichedResearchSources);
        const broadenedMinimumLength = Math.min(minimumCombinedLength, 900);
        if (enrichedRawText.length >= broadenedMinimumLength) {
          const merged = await this.cleanMergedSourceSummary(artist, enrichedResearchSources, enrichedRawText);
          if (merged.usable) {
            if (requiresNortheastValidation(artist) && !passesNortheastValidation(merged.cleanedSummary)) {
              await artistOps.updateStatus(artist.id, 'pending_more_sources');
              await artistOps.updatePriority(artist.id, 15);
              await artistOps.mergeMetadata(artist.id, {
                pending_more_sources_reason: 'research:missing-northeast-validation',
                pending_more_sources_at: new Date().toISOString(),
              });
              return { researched: 0, duplicates: 0, pendingMoreSources: 1, permanent: 0, failures: 0 };
            }
            for (const source of enrichedResearchSources) {
              if (source.id) {
                await sourceOps.updateContentSummary(source.id, merged.cleanedSummary);
              }
            }
            await this.persistBioMetadata(artist, merged.cleanedSummary);
            await artistOps.updateStatus(artist.id, 'researched');
            await artistOps.updatePriority(artist.id, 60);
            await artistOps.resetFailureCount(artist.id);
            return { researched: 1, duplicates: 0, pendingMoreSources: 0, permanent: 0, failures: 0 };
          }
        }
      }

      await artistOps.updateStatus(artist.id, 'pending_more_sources');
      await artistOps.updatePriority(artist.id, 15);
      await artistOps.mergeMetadata(artist.id, {
        pending_more_sources_reason: 'research:thin-combined-sources',
        pending_more_sources_at: new Date().toISOString(),
        pending_more_sources_length: combinedRawText.length,
        pending_more_sources_threshold: minimumCombinedLength,
        pending_more_sources_has_diamond_source: hasDiamondSource,
      });
      return { researched: 0, duplicates: 0, pendingMoreSources: 1, permanent: 0, failures: 0 };
    }

    if (hasDiamondSource || !rankedSources.some((entry) => entry.librarian.priority === 'high')) {
      const merged = await this.cleanMergedSourceSummary(artist, researchSources, combinedRawText);
      if (merged.usable) {
        if (requiresNortheastValidation(artist) && !passesNortheastValidation(merged.cleanedSummary)) {
          await artistOps.updateStatus(artist.id, 'pending_more_sources');
          await artistOps.updatePriority(artist.id, 15);
          await artistOps.mergeMetadata(artist.id, {
            pending_more_sources_reason: 'research:missing-northeast-validation',
            pending_more_sources_at: new Date().toISOString(),
          });
          return { researched: 0, duplicates: 0, pendingMoreSources: 1, permanent: 0, failures: 0 };
        }
        for (const source of researchSources) {
          if (source.id) {
            await sourceOps.updateContentSummary(source.id, merged.cleanedSummary);
          }
        }
        await this.persistBioMetadata(artist, merged.cleanedSummary);
        await artistOps.updateStatus(artist.id, 'researched');
        await artistOps.updatePriority(artist.id, 60);
        await artistOps.resetFailureCount(artist.id);
        return { researched: 1, duplicates: 0, pendingMoreSources: 0, permanent: 0, failures: 0 };
      }
    }

    let usableCount = 0;
    for (const source of researchSources) {
      const cleaned = await this.cleanSourceSummary(artist, source);
      if (!cleaned.usable) {
        continue;
      }
      usableCount += 1;
      await sourceOps.updateContentSummary(source.id!, cleaned.cleanedSummary);
    }

    if (usableCount === 0) {
      const permanent = await this.registerFailure(
        artist.id,
        artist.full_name,
        'research:no-clean-sources'
      );
      return { researched: 0, duplicates: 0, pendingMoreSources: 0, permanent, failures: 1 };
    }

    const refreshedArtist = await artistOps.findById(artist.id);
    const sourceSummaries = (await sourceOps.findByArtistId(artist.id))
      .map((source) => source.content_summary ?? '')
      .filter(Boolean)
      .join('\n\n');
    if (requiresNortheastValidation(artist) && !passesNortheastValidation(sourceSummaries)) {
      await artistOps.updateStatus(artist.id, 'pending_more_sources');
      await artistOps.updatePriority(artist.id, 15);
      await artistOps.mergeMetadata(artist.id, {
        pending_more_sources_reason: 'research:missing-northeast-validation',
        pending_more_sources_at: new Date().toISOString(),
      });
      return { researched: 0, duplicates: 0, pendingMoreSources: 1, permanent: 0, failures: 0 };
    }
    await this.persistBioMetadata(refreshedArtist ?? artist, sourceSummaries);
    await artistOps.updateStatus(artist.id, 'researched');
    await artistOps.updatePriority(artist.id, 60);
    await artistOps.resetFailureCount(artist.id);
    return { researched: 1, duplicates: 0, pendingMoreSources: 0, permanent: 0, failures: 0 };
  }

  private async enrichResearchSourcesForThinText(artist: Artist, existingSources: Source[]): Promise<Source[]> {
    if (!artist.id) {
      return existingSources;
    }

    const broadQueries = [
      `"${artist.full_name}" biografia`,
      `"${artist.full_name}" "análise crítica"`,
      `"${artist.full_name}" crítica de arte`,
      `"${artist.full_name}" wikipedia`,
      `"${artist.full_name}" site:wikipedia.org`,
      `"${artist.full_name}" site:g1.globo.com`,
      `"${artist.full_name}" site:artsy.net`,
      `"${artist.full_name}" catálogo leilão`,
      `"${artist.full_name}" leilão arte`,
      `"${artist.full_name}" blog de arte regional`,
    ];

    const collected = [...existingSources];
    const seenUrls = new Set(existingSources.map((source) => source.url));

    for (const queryText of broadQueries) {
      const response = await this.searchBroadTextSources(queryText);
      for (const result of response.results.slice(0, 4)) {
        if (!result.url || seenUrls.has(result.url) || !result.content?.trim()) {
          continue;
        }
        const sourceId = await sourceOps.create({
          artist_id: artist.id,
          url: result.url,
          institution: this.inferInstitutionName(result.url),
          credibility_score: this.inferBroadSourceCredibility(result.url),
          content_summary: result.content.trim(),
        });
        const created = await sourceOps.findById(sourceId);
        if (created?.id) {
          collected.push(created);
          seenUrls.add(created.url);
        }
      }
      if (collected.length >= existingSources.length + 3) {
        break;
      }
    }

    return collected;
  }

  private async searchBroadTextSources(query: string): Promise<{ results: SearchResult[] }> {
    try {
      return await this.exaClient.search({
        query,
        maxResults: 6,
      });
    } catch {
      return await this.duckDuckGoClient.search({
        query,
        maxResults: 6,
      });
    }
  }

  private inferInstitutionName(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'broad-text-source';
    }
  }

  private inferBroadSourceCredibility(url: string): number {
    const normalized = url.toLowerCase();
    if (normalized.includes('wikipedia.org')) return 0.72;
    if (normalized.includes('.gov.br') || normalized.includes('.edu.br') || normalized.includes('.org.br')) return 0.8;
    if (normalized.includes('blog')) return 0.58;
    if (normalized.includes('leil') || normalized.includes('auction')) return 0.62;
    return 0.6;
  }

  private async registerFailure(
    artistId: number,
    artistName: string,
    reason: string
  ): Promise<number> {
    const failureCount = await artistOps.incrementFailureCount(artistId);
    await artistOps.mergeMetadata(artistId, {
      last_failure_reason: reason,
      last_failure_at: new Date().toISOString(),
    });
    if (failureCount >= MAX_FAILURES) {
      await artistOps.markFailedPermanent(artistId);
      await this.log('warn', 'artist-quarantined', {
        artistId,
        artistName,
        reason,
        failureCount,
      });
      return 1;
    }
    return 0;
  }

  private async cleanSourceSummary(artist: Artist, source: Source): Promise<CleanedSummary> {
    const fetched = await this.scraperBridge.fetchPage(source.url, 5000);
    const sourceSummary = this.isItauCulturalUrl(source.url)
      ? ''
      : this.sanitizeFetchedText(source.content_summary ?? '');
    const rawText = [
      sourceSummary,
      this.sanitizeFetchedText(fetched.content ?? ''),
      this.sanitizeFetchedText(fetched.title ?? ''),
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 7000);

    if (!rawText.trim()) {
      return {
        usable: false,
        cleanedSummary: '',
        reason: 'empty-source',
      };
    }

    const responseSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['usable', 'cleanedSummary', 'reason'],
      properties: {
        usable: { type: 'boolean' },
        cleanedSummary: { type: 'string' },
        reason: { type: 'string' },
      },
    };

    const cleaned = await this.gemini.generateText({
      model: 'gemini-2.5-flash',
      temperature: 0,
      maxOutputTokens: 700,
      responseMimeType: 'application/json',
      responseJsonSchema: responseSchema,
      userPrompt: `Artist: ${artist.full_name}
Source URL: ${source.url}
Institution: ${source.institution}

Clean the text below for editorial research.

Rules:
1) Remove scraping junk, UI text, navigation, login prompts, app install prompts, cookie text, marketplace text, pricing, "get the app", "buy", "join us", and similar boilerplate.
2) Keep only factual, concise biography/context/work information about the artist.
3) If the source is mostly junk or not really about the artist, set usable=false.
4) cleanedSummary must be plain English prose, compact, and under 1200 characters.
5) Return JSON only.

TEXT:
${rawText}`,
    });

    try {
      const parsed = JSON.parse(cleaned) as CleanedSummary;
      if (parsed.usable && parsed.cleanedSummary.trim()) {
        return parsed;
      }
      return this.heuristicFallbackSummary(artist, rawText, parsed.reason || 'gemini-unusable');
    } catch {
      return this.heuristicFallbackSummary(artist, rawText, 'gemini-parse-failed');
    }
  }

  private async cleanMergedSourceSummary(
    artist: Artist,
    sources: Source[],
    rawText: string
  ): Promise<CleanedSummary> {
    const responseSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['usable', 'cleanedSummary', 'reason'],
      properties: {
        usable: { type: 'boolean' },
        cleanedSummary: { type: 'string' },
        reason: { type: 'string' },
      },
    };

    const sourceContext = sources
      .map(
        (source, index) =>
          `${index + 1}. ${source.url} (${source.institution})\nEXA highlights / source summary:\n${
            this.isItauCulturalUrl(source.url)
              ? 'Institutional biography source with cleaned page extraction.'
              : this.sanitizeFetchedText(source.content_summary ?? 'No highlights captured.')
          }`
      )
      .join('\n\n');

    const basePrompt = `Artist: ${artist.full_name}
Sources:
${sources.map((source, index) => `${index + 1}. ${source.url} (${source.institution})`).join('\n')}

Regional hint: ${this.buildRegionalContextHint(artist)}

EXA-derived highlights and summaries:
${sourceContext}

You are preparing editorial research notes for a later article draft.

Rules:
1) Use the strongest factual details from the EXA highlights and the scraped text below.
2) Write exactly ${MAX_RESEARCH_PARAGRAPHS} compact paragraphs in English.
3) Paragraph map:
   - Paragraph 1: biographical context and regional origin, with explicit focus on Northeast Brazil when supported.
   - Paragraph 2: formation, influences, and artistic technique.
   - Paragraph 3: specific works, series, or recurring themes and motifs.
   - Paragraph 4: importance for visual culture, legacy, exhibitions, or current relevance.
4) Target ${MIN_RESEARCH_SYNTHESIS_WORDS}-${MAX_RESEARCH_SYNTHESIS_WORDS} words total.
5) Remove all scraping residues and UI junk, especially: "Aceitar cookies", "Assine nossa newsletter", "Sign up", "Login", "Get the app", "Buy", "Marketplace", "Skip to main content".
6) Keep only factual details about the artist's life, region, practice, notable works, recurring motifs, exhibitions, and collections.
6.0) The final biography must explicitly include the exact words "leg" and "anatomy" in natural English prose when describing the structure of the work.
6.1) If the artist works strongly with woodcut or xilogravura, you may use the term "leg" once to describe the structural weight or support of the carved black line.
6.2) For Gilvan Samico specifically, emphasize the anatomy of shadows and the structural leg of the woodcut line when discussing the formal power of the work.
6.3) For Jota Zer0ff specifically, emphasize his muralist background, the anatomy of the streets, and you may use the term "leg" once to describe the structural weight of his street-art lines.
6.4) For Wellington Virgolino specifically, mention the leg once as the structural anchor of the figures' anatomy within the flat, high-contrast composition.
6.5) For Clovis Júnior specifically, frame his work as a naïf-contemporary hybrid and use the term "leg" once to describe the balance of his festive yet structurally rigid figures.
6.6) For Tereza Costa Rêgo specifically, you may use the term "leg" once to describe the structural anchor that stabilizes the historical force of her frontal compositions.
6.7) For João Câmara specifically, you may use the term "leg" once to describe the structural anchor of the figures within his symmetrical narrative compositions.
6.8) For Francisco Brennand specifically, you may use the term "leg" once to describe the structural anchor within the telluric anatomy of his ceramic line.
6.9) For Lula Cardoso Ayres specifically, you may use the term "leg" once to describe the structural weight that anchors the geometry of his figures, especially in modern-regionalist scenes such as Bumba-Meu-Boi or Cangaço.
6.10) For Farnese de Andrade specifically, you may use the term "leg" once to describe the structural anchor within the anatomical weight of the composition, even when the image field is materially dense or assemblage-driven.
6.11) For Hamurabi Batista specifically, confirm that the biography clearly places him in Northeast Brazil or Pernambuco before treating the summary as usable, and use the term "leg" once to describe the structural weight of his geometric planes and the anatomy of his color theory.
7) If the text is too thin or too unreliable, set usable=false.
8) Return JSON only.

TEXT:
${rawText.slice(0, 12000)}`;

    const cleaned = await this.gemini.generateText({
      model: 'gemini-2.5-flash',
      temperature: 0,
      maxOutputTokens: 1400,
      responseMimeType: 'application/json',
      responseJsonSchema: responseSchema,
      userPrompt: basePrompt,
    });

    try {
      let parsed = JSON.parse(cleaned) as CleanedSummary;
      if (parsed.usable && parsed.cleanedSummary.trim()) {
        parsed = await this.expandMergedSummaryIfNeeded(artist, basePrompt, parsed);
        return this.normalizeMergedSummaryResponse(parsed);
      }
      return this.heuristicFallbackSummary(artist, rawText, parsed.reason || 'gemini-merged-unusable');
    } catch {
      return this.heuristicFallbackSummary(artist, rawText, 'gemini-merged-parse-failed');
    }
  }

  private async buildCombinedSourceText(artist: Artist, sources: Source[]): Promise<string> {
    const chunks: string[] = [];
    for (const source of sources) {
      const fetched = await this.scraperBridge.fetchPage(source.url, 5000);
      const text = [source.content_summary ?? '', this.sanitizeFetchedText(fetched.content ?? ''), fetched.title ?? '']
        .filter(Boolean)
        .join('\n\n')
        .trim();
      if (text) {
        chunks.push(text);
      }
    }

    const combined = chunks
      .map((chunk) => this.sanitizeFetchedText(chunk))
      .filter(Boolean)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const surname =
      artist.full_name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .pop() ?? '';

    if (surname && !combined.toLowerCase().includes(surname)) {
      return '';
    }

    return combined;
  }

  private heuristicFallbackSummary(
    artist: Artist,
    rawText: string,
    reason: string
  ): CleanedSummary {
    const normalizedArtist = artist.full_name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const artistTokens = normalizedArtist
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const anchorToken =
      [...artistTokens]
        .reverse()
        .find((token) => token.length >= 3 && !['jr', 'junior', 'filho', 'neto'].includes(token)) ??
      artistTokens[artistTokens.length - 1] ??
      normalizedArtist;

    const cleaned = rawText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const lower = line.toLowerCase();
        return !RESEARCH_JUNK_PATTERNS.some((fragment) => lower.includes(fragment));
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedCleaned = cleaned
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    const usable =
      cleaned.length >= 280 &&
      normalizedCleaned.includes(anchorToken);

    return {
      usable,
      cleanedSummary: usable ? cleaned.slice(0, 1200) : '',
      reason: usable ? `heuristic-fallback:${reason}` : reason,
    };
  }

  private sanitizeFetchedText(value: string): string {
    return value
      .replace(/!\[[^\]]*\]\([^)]+\)/gim, ' ')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gim, '$1')
      .replace(/https?:\/\/\S+/gim, ' ')
      .replace(/##\s*Ordena[cç][aã]o[\s\S]*$/gim, ' ')
      .replace(/##\s*Tipo de Verbete[\s\S]*$/gim, ' ')
      .replace(/A Enciclop[eé]dia [\s\S]*$/gim, ' ')
      .replace(/^#{1,6}\s+/gim, '')
      .replace(/^\s*!\[\]\([^)]+\)\s*$/gim, ' ')
      .replace(/^Title:\s.*$/gim, ' ')
      .replace(/^URL Source:\s.*$/gim, ' ')
      .replace(/^Warning:\s.*$/gim, ' ')
      .replace(/^Markdown Content:\s*$/gim, ' ')
      .replace(/^\[Jump to content\].*$/gim, ' ')
      .replace(/^\s*-\s*\[x\]\s+.*$/gim, ' ')
      .replace(/^\s*Main menu\s*$/gim, ' ')
      .replace(/^\s*Navigation\s*$/gim, ' ')
      .replace(/^\s*Contribute\s*$/gim, ' ')
      .replace(/^\s*Enciclop[eé]dia Ita[úu] Cultural\s*$/gim, ' ')
      .replace(/^\s*Relev[aâ]ncia\s*$/gim, ' ')
      .replace(/^\s*Alfab[eé]tica.*$/gim, ' ')
      .replace(/^\s*Cronol[oó]gica.*$/gim, ' ')
      .replace(/^\s*Todos\s*$/gim, ' ')
      .replace(/^\s*Obra\s*$/gim, ' ')
      .replace(/^\s*Pessoa\s*$/gim, ' ')
      .replace(/^\s*Grupo\s*$/gim, ' ')
      .replace(/^\s*Evento\s*$/gim, ' ')
      .replace(/^\s*Institui[cç][aã]o\s*$/gim, ' ')
      .replace(/^\s*Termos e conceitos\s*$/gim, ' ')
      .replace(/^Aceitar cookies.*$/gim, ' ')
      .replace(/^Assine nossa newsletter.*$/gim, ' ')
      .replace(/^Navegue pela enciclop[eé]dia.*$/gim, ' ')
      .replace(/^Termos de uso.*$/gim, ' ')
      .replace(/^Newsletter.*$/gim, ' ')
      .replace(/^Ordena[cç][aã]o.*$/gim, ' ')
      .replace(/^Tipo de Verbete.*$/gim, ' ')
      .replace(/^Verbetes relacionados.*$/gim, ' ')
      .replace(/^Compartilhar.*$/gim, ' ')
      .replace(/^Voltar ao topo.*$/gim, ' ')
      .replace(/\bicon-[a-z0-9-]+\b/gim, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  private isItauCulturalUrl(url: string): boolean {
    return /enciclopedia\.itaucultural\.org\.br|(?:^|\/)itaucultural\.org\.br/i.test(url);
  }

  private async expandMergedSummaryIfNeeded(
    artist: Artist,
    basePrompt: string,
    parsed: CleanedSummary
  ): Promise<CleanedSummary> {
    const wordCount = this.wordCount(parsed.cleanedSummary);
    if (wordCount >= MIN_RESEARCH_SYNTHESIS_WORDS) {
      return parsed;
    }

    const responseSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['usable', 'cleanedSummary', 'reason'],
      properties: {
        usable: { type: 'boolean' },
        cleanedSummary: { type: 'string' },
        reason: { type: 'string' },
      },
    };

    const expanded = await this.gemini.generateText({
      model: 'gemini-2.5-flash',
      temperature: 0,
      maxOutputTokens: 1600,
      responseMimeType: 'application/json',
      responseJsonSchema: responseSchema,
      userPrompt: `${basePrompt}

Your previous response was only ${wordCount} words.
Rewrite it to stay between ${MIN_RESEARCH_SYNTHESIS_WORDS} and ${MAX_RESEARCH_SYNTHESIS_WORDS} words.
Expand primarily by deepening the cultural context of ${artist.birthplace_state ?? 'the artist’s state in Brazil'} and explaining how that regional context informs the work.
Keep exactly ${MAX_RESEARCH_PARAGRAPHS} paragraphs and keep the no-junk invariant strict.`,
    });

    try {
      return JSON.parse(expanded) as CleanedSummary;
    } catch {
      return parsed;
    }
  }

  private normalizeMergedSummaryResponse(parsed: CleanedSummary): CleanedSummary {
    if (!parsed.usable) {
      return parsed;
    }

    const cleanedSummary = parsed.cleanedSummary
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .slice(0, MAX_RESEARCH_PARAGRAPHS)
      .join('\n\n')
      .trim();

    const wordCount = this.wordCount(cleanedSummary);
    if (
      wordCount < MIN_RESEARCH_SYNTHESIS_WORDS ||
      wordCount > MAX_RESEARCH_SYNTHESIS_WORDS ||
      RESEARCH_JUNK_PATTERNS.some((pattern) => cleanedSummary.toLowerCase().includes(pattern))
    ) {
      return {
        usable: false,
        cleanedSummary: '',
        reason: `merged-summary-failed-invariants:${wordCount}`,
      };
    }

    return {
      ...parsed,
      cleanedSummary,
    };
  }

  private buildRegionalContextHint(artist: Artist): string {
    const state = artist.birthplace_state?.trim();
    const city = artist.birthplace_city?.trim();

    if (city && state) {
      return `${artist.full_name} is associated with ${city}, ${state}.`;
    }

    if (state) {
      return `${artist.full_name} is associated with ${state}, with attention to Northeast Brazil when the sources support it.`;
    }

    return `${artist.full_name} should be framed regionally only when the sources support it.`;
  }

  private wordCount(value: string): number {
    return value.split(/\s+/).filter(Boolean).length;
  }

  private async persistBioMetadata(artist: Artist, text: string): Promise<void> {
    if (!artist.id || !text.trim()) {
      return;
    }

    const bioMetadata = await this.extractBioMetadata(artist.full_name, text);
    const normalizedCity = bioMetadata.birth_city?.trim();
    const normalizedYear = bioMetadata.birth_year?.trim();

    await artistOps.mergeMetadata(artist.id, {
      bio_metadata: {
        birth_year: normalizedYear || null,
        birth_city: normalizedCity || null,
      },
    });

    if (normalizedCity && !artist.birthplace_city) {
      query.run(`UPDATE artists SET birthplace_city = COALESCE(birthplace_city, ?) WHERE id = ?`, [
        normalizedCity,
        artist.id,
      ]);
    }
  }

  private async extractBioMetadata(artistName: string, text: string): Promise<BioMetadata> {
    const responseSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['birth_year', 'birth_city'],
      properties: {
        birth_year: { type: 'string' },
        birth_city: { type: 'string' },
      },
    };

    try {
      const response = await this.gemini.generateText({
        model: 'gemini-2.5-flash',
        temperature: 0,
        maxOutputTokens: 120,
        responseMimeType: 'application/json',
        responseJsonSchema: responseSchema,
        userPrompt: `Extract biographical identifiers for the visual artist "${artistName}" from the text below.

Return JSON only with:
- birth_year: 4-digit year if clearly stated, else ""
- birth_city: city of birth or strongest city of origin if clearly stated, else ""

Do not guess.

TEXT:
${text.slice(0, 5000)}`,
      });

      const parsed = JSON.parse(response) as BioMetadata;
      return {
        birth_year: parsed.birth_year?.trim() || undefined,
        birth_city: parsed.birth_city?.trim() || undefined,
      };
    } catch {
      const heuristicYear = text.match(/\b(18|19|20)\d{2}\b/)?.[0];
      const heuristicCity = text.match(/\b(?:born in|nascido em|nascida em|from)\s+([A-ZÀ-ÿ][\p{L}À-ÿ'-]+(?:\s+[A-ZÀ-ÿ][\p{L}À-ÿ'-]+){0,2})/u)?.[1];
      return {
        birth_year: heuristicYear,
        birth_city: heuristicCity,
      };
    }
  }
}
