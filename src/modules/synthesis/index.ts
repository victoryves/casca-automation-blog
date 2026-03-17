/**
 * Synthesis Module
 *
 * Generates Medium-style articles using OpenAI GPT-4o.
 */

import OpenAI from 'openai';
import { marked } from 'marked';
import { artistOps, sourceOps, draftOps } from '../../db/operations/index.js';
import { getConfig } from '../../config/index.js';
import type { SynthesisResult, Artist, Source } from '../../types/index.js';

export interface ArticleStructure {
  title: string;
  subtitle: string;
  content: string;
  keywords: string[];
}

export class SynthesisModule {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
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

    const sources = await sourceOps.findByArtistId(artistId);
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
        return `Source ${idx + 1} (${source.institution}, credibility: ${source.credibility_score}):\nURL: ${source.url}\n${source.content_summary ?? 'No summary available'}\n`;
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

    console.log(`  Calling OpenAI API (gpt-4o)...`);

    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 4096,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: prompt.system,
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      // Parse response
      return this.parseArticleResponse(content);
    } catch (error) {
      console.error('OpenAI API error:', error);
      throw new Error(
        `Failed to generate article: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parse Claude's response into structured article
   */
  private parseArticleResponse(response: string): ArticleStructure {
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
      title = `The Story of ${response.split('\n')[0].substring(0, 50)}`;
    }
    if (!subtitle) {
      subtitle = 'A visual artist from Northeast Brazil';
    }
    if (contentLines.length === 0) {
      contentLines.push(response);
    }

    return {
      title,
      subtitle,
      content: contentLines.join('\n').trim(),
      keywords,
    };
  }

  /**
   * Convert markdown to HTML for email
   */
  async toHtml(markdown: string): Promise<string> {
    return marked(markdown);
  }
}
