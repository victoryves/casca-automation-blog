/**
 * Synthesis Module
 *
 * Generates Medium-style articles using Gemini.
 */

import { marked } from 'marked';
import { artistOps, sourceOps, draftOps } from '../../db/operations/index.js';
import { getConfig } from '../../config/index.js';
import { GeminiClient } from '../../lib/gemini.js';
import type { SynthesisResult, Artist, Source } from '../../types/index.js';

export interface ArticleStructure {
  title: string;
  subtitle: string;
  content: string;
  keywords: string[];
}

export class SynthesisModule {
  private client: GeminiClient;

  constructor(apiKey: string) {
    this.client = new GeminiClient(apiKey);
  }

  /**
   * Synthesize article for a verified artist
   */
  async synthesize(artistId: number): Promise<SynthesisResult> {
    const startTime = Date.now();

    console.log(`\n✍️  Synthesizing article for artist ${artistId}...`);

    // Get artist and sources
    const artist = await artistOps.findById(artistId);
    if (!artist || artist.status !== 'verified') {
      throw new Error(`Artist ${artistId} not found or not verified`);
    }

    const sources = this.filterSourcesForArtist(
      artist,
      await sourceOps.findByArtistId(artistId)
    );
    if (sources.length === 0) {
      throw new Error(`No sources found for artist ${artistId}`);
    }

    console.log(`  Artist: ${artist.full_name}`);
    console.log(`  Sources: ${sources.length}`);

    // Generate article
    const article = await this.generateArticle(artist, sources);
    console.log(`  ✓ Article generated (${article.content.split(/\s+/).length} words)`);

    // Create draft
    const draftId = await draftOps.create(
      {
        artist_id: artistId,
        title: article.title,
        subtitle: article.subtitle,
        content: article.content,
        status: 'pending',
      },
      [] // Images will be added by visual module
    );

    console.log(`  ✓ Draft created: ${draftId}`);

    const draft = await draftOps.findById(draftId);
    if (!draft) {
      throw new Error('Failed to create draft');
    }

    const generationTime = Date.now() - startTime;

    return {
      draft,
      images: [],
      metadata: {
        sources_used: sources.length,
        word_count: article.content.split(/\s+/).length,
        generation_time_ms: generationTime,
      },
    };
  }

  /**
   * Generate article using Claude
   */
  private async generateArticle(artist: Artist, sources: Source[]): Promise<ArticleStructure> {
    const config = getConfig();
    const prompt = config.prompts.article_generation;

    // Prepare source context
    const sourceContext = sources
      .map((source, idx) => {
        return `Source ${idx + 1} (${source.institution}, credibility: ${source.credibility_score}):\nURL: ${source.url}\n${this.extractRelevantSourceExcerpt(source, artist) ?? 'No summary available'}\n`;
      })
      .join('\n---\n\n');

    // Prepare artist context
    const artistContext = `
Name: ${artist.full_name}
Birthplace: ${artist.birthplace_city ?? 'Unknown'}, ${artist.birthplace_state ?? 'Unknown'}
Visual Practice: ${artist.visual_practice ?? 'Not specified'}
`;

    // Build user prompt
    const userPrompt = prompt.user_template
      .replace('{{artist_name}}', artist.full_name)
      .replace('{{artist_context}}', artistContext)
      .replace('{{source_context}}', sourceContext);

    console.log(`  Calling Gemini API (gemini-2.5-flash)...`);

    try {
      const content = await this.client.generateText({
        model: 'gemini-2.5-flash',
        systemInstruction: prompt.system,
        userPrompt,
        maxOutputTokens: 4096,
        temperature: 0.7,
      });

      // Parse response
      return this.parseArticleResponse(content, artist);
    } catch (error) {
      console.error('Gemini API error:', error);
      console.warn('Falling back to deterministic article generation');
      return this.buildFallbackArticle(artist, sources);
    }
  }

  /**
   * Parse Claude's response into structured article
   */
  private parseArticleResponse(response: string, artist: Artist): ArticleStructure {
    // Expected format:
    // # Title
    // ## Subtitle
    // Content...
    // Keywords: keyword1, keyword2, keyword3

    const lines = response.split('\n');
    let title = '';
    let subtitle = '';
    const contentLines: string[] = [];
    let keywords: string[] = [];

    let inContent = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('# ')) {
        title = trimmed.substring(2).trim();
      } else if (trimmed.startsWith('## ')) {
        subtitle = trimmed.substring(3).trim();
        inContent = true;
      } else if (trimmed.toLowerCase().startsWith('keywords:')) {
        keywords = trimmed
          .substring(9)
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k.length > 0);
      } else if (inContent && trimmed.length > 0) {
        contentLines.push(line);
      }
    }

    // Fallback if parsing fails
    if (!title) {
      title = `Inside the World of ${artist.full_name}`;
    }
    if (!subtitle) {
      subtitle = 'A visual artist from Northeast Brazil';
    }
    if (contentLines.length === 0) {
      contentLines.push(response);
    }

    if (!this.titleIncludesArtistName(title, artist.full_name)) {
      title = `${artist.full_name}: ${title}`;
    }

    return {
      title,
      subtitle,
      content: contentLines.join('\n').trim(),
      keywords,
    };
  }

  private buildFallbackArticle(artist: Artist, sources: Source[]): ArticleStructure {
    const practice = artist.visual_practice ?? 'visual art';
    const place = [artist.birthplace_city, artist.birthplace_state].filter(Boolean).join(', ');

    const institutions = Array.from(
      new Set(
        sources
          .map((source) => source.institution?.trim())
          .filter((institution): institution is string => Boolean(institution))
      )
    );

    const institutionalContext = institutions.length > 0
      ? `The article is based on ${sources.length} verified source${sources.length === 1 ? '' : 's'}, including ${institutions.slice(0, 3).join(', ')}.`
      : `The article is based on ${sources.length} verified source${sources.length === 1 ? '' : 's'} about the artist's career and work.`;

    const intro = `${artist.full_name} emerges from ${place || 'Northeast Brazil'} as an artist whose practice in ${practice} connects local memory, experimentation, and a wider contemporary Brazilian conversation. ${institutionalContext}`;

    const body = `${artist.full_name}'s documented trajectory points to an artist with a consistent body of work, visible regional importance, and enough critical or institutional presence to justify editorial attention. Even when the system cannot generate a fully expanded feature from the language model, the verified material still shows a practice shaped by place, visual identity, and long-term cultural relevance.`;

    const closing = `For readers discovering ${artist.full_name} for the first time, the essential takeaway is clear: this is an artist worth following more closely, both for the work itself and for what it reveals about the depth of contemporary art from Northeast Brazil.`;

    return {
      title: `Why ${artist.full_name} Is Worth Watching`,
      subtitle: `${artist.full_name}'s work connects ${place || 'Northeast Brazil'} to a wider conversation in contemporary art.`,
      content: `${intro}\n\n${body}\n\n${closing}`,
      keywords: [artist.full_name, 'Brazilian art', 'Northeast Brazil'],
    };
  }

  private titleIncludesArtistName(title: string, fullName: string): boolean {
    const normalizedTitle = this.normalizeText(title);
    const normalizedFullName = this.normalizeText(fullName);

    if (normalizedTitle.includes(normalizedFullName)) {
      return true;
    }

    const surname = normalizedFullName.split(/\s+/).filter(Boolean).pop();
    return Boolean(surname && surname.length >= 3 && normalizedTitle.includes(surname));
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  /**
   * Convert markdown to HTML for email
   */
  async toHtml(markdown: string): Promise<string> {
    return marked(markdown);
  }

  private filterSourcesForArtist(artist: Artist, sources: Source[]): Source[] {
    const filtered = sources.filter((source) => this.isSourceRelevantToArtist(source, artist));
    return filtered.length > 0 ? filtered : sources;
  }

  private isSourceRelevantToArtist(source: Source, artist: Artist): boolean {
    const normalizedArtistName = this.normalizeText(artist.full_name);
    const haystack = this.normalizeText(
      `${source.url} ${source.institution ?? ''} ${source.content_summary ?? ''}`
    );

    if (haystack.includes(normalizedArtistName)) {
      return true;
    }

    const tokens = normalizedArtistName.split(' ').filter((token) => token.length >= 2);
    if (tokens.length === 0) {
      return false;
    }

    const surname = tokens[tokens.length - 1];
    const givenTokens = tokens.slice(0, -1).filter((token) => token.length >= 4);

    if (givenTokens.length === 0) {
      return tokens.every((token) => haystack.includes(token));
    }

    const hasGivenName = givenTokens.some((token) => haystack.includes(token));
    const hasSurname = surname.length >= 4 ? haystack.includes(surname) : true;

    return hasGivenName && hasSurname;
  }

  private extractRelevantSourceExcerpt(source: Source, artist: Artist): string | null {
    const summary = source.content_summary?.trim();
    if (!summary) {
      return null;
    }

    const normalizedSummary = this.normalizeText(summary);
    const normalizedArtistName = this.normalizeText(artist.full_name);
    const paragraphExcerpt = this.extractRelevantParagraphs(summary, artist);
    if (paragraphExcerpt) {
      return paragraphExcerpt;
    }

    if (normalizedSummary.includes(normalizedArtistName)) {
      return this.sliceAroundMatch(summary, normalizedSummary.indexOf(normalizedArtistName), 420);
    }

    const givenTokens = normalizedArtistName
      .split(' ')
      .slice(0, -1)
      .filter((token) => token.length >= 4);

    for (const token of givenTokens) {
      const index = normalizedSummary.indexOf(token);
      if (index >= 0) {
        return this.sliceAroundMatch(summary, index, 420);
      }
    }

    return summary.slice(0, 500);
  }

  private extractRelevantParagraphs(value: string, artist: Artist): string | null {
    const paragraphs = value
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    if (paragraphs.length === 0) {
      return null;
    }

    const normalizedArtistName = this.normalizeText(artist.full_name);
    const givenTokens = normalizedArtistName
      .split(' ')
      .slice(0, -1)
      .filter((token) => token.length >= 4);

    const matchingParagraphs = paragraphs.filter((paragraph) => {
      const normalizedParagraph = this.normalizeText(paragraph);
      if (normalizedParagraph.includes(normalizedArtistName)) {
        return true;
      }

      return givenTokens.some((token) => normalizedParagraph.includes(token));
    });

    if (matchingParagraphs.length === 0) {
      return null;
    }

    return matchingParagraphs
      .slice(0, 3)
      .map((paragraph) => paragraph.slice(0, 220).trim())
      .join('\n\n');
  }

  private sliceAroundMatch(value: string, index: number, radius: number): string {
    const start = Math.max(0, index - radius / 2);
    const end = Math.min(value.length, index + radius / 2);
    return value.slice(start, end).trim();
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
}
