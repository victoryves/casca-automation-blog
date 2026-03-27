/**
 * Publishing Module
 *
 * Handles article publishing to Hashnode via GraphQL API.
 */

import axios from 'axios';
import { marked } from 'marked';
import { draftOps, artistOps, publishingOps, sourceOps } from '../../db/operations/index.js';
import type { PublishingResult, Draft, Image } from '../../types/index.js';

export class PublishingModule {
  private hashnodeApiKey: string;
  private hashnodePublicationId: string;
  private hashnodeApiEndpoint = 'https://gql.hashnode.com';

  constructor(hashnodeApiKey: string, hashnodePublicationId: string) {
    this.hashnodeApiKey = hashnodeApiKey;
    this.hashnodePublicationId = hashnodePublicationId;
  }

  /**
   * Publish draft to Hashnode
   */
  async publish(draftId: number, featuredImageIndex = 0): Promise<PublishingResult> {
    console.log(`\n🚀 Publishing draft ${draftId} to Hashnode...`);

    const draft = await draftOps.findById(draftId);
    if (!draft) {
      return {
        success: false,
        draft_id: draftId,
        error: 'Draft not found',
      };
    }

    if (draft.status !== 'approved') {
      return {
        success: false,
        draft_id: draftId,
        error: `Draft not approved (status: ${draft.status})`,
      };
    }

    const artist = await artistOps.findById(draft.artist_id);
    if (!artist) {
      return {
        success: false,
        draft_id: draftId,
        error: 'Artist not found',
      };
    }

    // Parse images
    const images: Image[] = draft.images ? JSON.parse(draft.images) : [];
    const normalizedFeaturedImageIndex =
      Number.isInteger(featuredImageIndex) && featuredImageIndex >= 0 ? featuredImageIndex : 0;
    const coverImage = images[normalizedFeaturedImageIndex] ?? images[0];
    const contentImages = images.filter((_, index) => index !== normalizedFeaturedImageIndex);

    try {
      if (!coverImage) {
        throw new Error('No images available for cover image. Draft must include at least one image.');
      }

      // Get sources for the article
      const sources = await sourceOps.findByArtistId(draft.artist_id);

      // Generate Hashnode-formatted content (HTML)
      const content = await this.generateHashnodeContent(
        draft,
        artist.full_name,
        contentImages,
        sources,
        coverImage
      );

      const coverImageURL = this.buildCoverImageUrl(coverImage.url);

      // Publish to Hashnode via GraphQL
      console.log('  Publishing to Hashnode...');

      const mutation = `
        mutation PublishPost($input: PublishPostInput!) {
          publishPost(input: $input) {
            post {
              id
              title
              url
              slug
            }
          }
        }
      `;

      const variables = {
        input: {
          title: draft.title,
          subtitle: draft.subtitle || undefined,
          contentMarkdown: content, // Hashnode supports markdown
          tags: [
            { slug: 'brazilian-art', name: 'Brazilian Art' },
            { slug: 'northeast-brazil', name: 'Northeast Brazil' },
            { slug: 'visual-arts', name: 'Visual Arts' },
            { slug: 'art-history', name: 'Art History' },
          ],
          publicationId: this.hashnodePublicationId,
          coverImageOptions: coverImageURL ? {
            coverImageURL: coverImageURL,
            coverImageAttribution: coverImage.attribution,
          } : undefined,
          settings: {
            delisted: false,
          },
        },
      };

      const response = await axios.post(
        this.hashnodeApiEndpoint,
        {
          query: mutation,
          variables: variables,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: this.hashnodeApiKey,
          },
        }
      );

      if (response.data.errors) {
        throw new Error(`Hashnode API error: ${JSON.stringify(response.data.errors)}`);
      }

      const postData = response.data.data.publishPost.post;
      const hashnodeUrl = postData.url;
      console.log(`  ✓ Published to Hashnode: ${hashnodeUrl}`);

      // Log publication
      const logId = await publishingOps.create({
        draft_id: draftId,
        medium_url: hashnodeUrl, // Using same field for now
      });

      console.log(`  ✓ Publication logged: ${logId}`);

      // Update artist status
      await artistOps.updateStatus(artist.id!, 'published');
      console.log(`  ✓ Artist marked as published`);

      return {
        success: true,
        draft_id: draftId,
        medium_url: hashnodeUrl,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ Publishing failed: ${errorMsg}`);

      if (axios.isAxiosError(error)) {
        console.error('  API Error:', error.response?.data);
      }

      // Log error
      await publishingOps.create({
        draft_id: draftId,
        error_message: errorMsg,
      });

      return {
        success: false,
        draft_id: draftId,
        error: errorMsg,
      };
    }
  }

  /**
   * Generate Hashnode-formatted content (Markdown)
   */
  private async generateHashnodeContent(
    draft: Draft,
    authorName: string,
    images: Image[],
    sources?: any[],
    coverImage?: Image
  ): Promise<string> {
    // Start with the original content and normalize line breaks
    // Convert single line breaks to double (markdown paragraphs)
    let content = draft.content.replace(/\n/g, '\n\n');

    // Split into paragraphs
    const paragraphs = content.split('\n\n').filter(p => p.trim().length > 0);

    // Insert images between paragraphs
    if (images && images.length > 0) {
      const totalParagraphs = paragraphs.length;
      const imageCount = Math.min(images.length, 8); // Up to 8 images distributed

      if (totalParagraphs > 1) {
        const interval = Math.floor(totalParagraphs / (imageCount + 1));
        const positions: number[] = [];

        for (let i = 0; i < imageCount; i++) {
          const pos = Math.min((i + 1) * interval, totalParagraphs - 1);
          if (pos > 0 && pos < totalParagraphs) {
            positions.push(pos);
          }
        }

        let result: string[] = [];
        let imageIndex = 0;

        for (let i = 0; i < paragraphs.length; i++) {
          result.push(paragraphs[i]);

          if (imageIndex < positions.length && i === positions[imageIndex]) {
            const img = images[imageIndex];
            // Use image proxy to avoid hotlinking issues
            const proxyUrl = this.buildProxyUrl(img.url, 800);
            result.push(`![${img.caption}](${proxyUrl})`);
            result.push(`*${img.attribution}*`);
            imageIndex++;
          }
        }

        content = result.join('\n\n');
      } else {
        content = paragraphs.join('\n\n');
      }
    } else {
      content = paragraphs.join('\n\n');
    }

    // Insert sources before Keywords
    if (sources && sources.length > 0) {
      let sourcesMarkdown = '\n\n**Fontes:**\n\n';
      sources.forEach((source, index) => {
        sourcesMarkdown += `(${index + 1}) ${source.institution || 'Source'} - [${source.url}](${source.url})\n\n`;
      });

      // Try to insert before Keywords
      const keywordsPattern = /\*\*Keywords:\*\*/i;
      if (keywordsPattern.test(content)) {
        content = content.replace(keywordsPattern, sourcesMarkdown + '**Keywords:**');
      } else {
        content += sourcesMarkdown;
      }
    }

    // Add cover attribution if cover image is not in the body
    if (coverImage) {
      content += `\n\n*Imagem de capa: ${coverImage.attribution}*`;
    }

    // Add footer
    content += `\n\n---\n\n*This article is part of the CASCA Archive, documenting visual artists from Northeast Brazil. ${authorName ? `Story about ${authorName}.` : ''}*\n`;

    return content;
  }

  /**
   * Update Medium URL after publication confirmation
   */
  async updateMediumUrl(draftId: number, mediumUrl: string): Promise<void> {
    const logs = await publishingOps.findByDraftId(draftId);
    if (logs.length > 0) {
      const latestLog = logs[0];
      await publishingOps.updateMediumUrl(latestLog.id!, mediumUrl);
      console.log(`✓ Updated Medium URL for draft ${draftId}`);
    }
  }

  private buildProxyUrl(url: string, width = 800): string {
    return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=${width}&output=webp`;
  }

  private buildCoverImageUrl(url: string): string {
    if (url.startsWith('https://')) {
      return url;
    }

    return this.buildProxyUrl(url, 1200);
  }
}
