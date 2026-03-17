/**
 * Visual Materials Module
 *
 * Sources and manages images for articles using a 3-layer verification pipeline:
 * 1. Extract from verified sources (highest confidence)
 * 2. Wikimedia Commons + Claude Vision verification
 * 3. Web search + Claude Vision verification
 */

import OpenAI from 'openai';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type { Image, Source, WikimediaImage } from '../../types/index.js';
import { ScraperBridge } from '../scraper-bridge/index.js';

interface ArtistInfo {
  full_name: string;
  visual_practice?: string;
  birthplace_city?: string;
  birthplace_state?: string;
}

export class VisualModule {
  private readonly imagesDir: string;
  private readonly wikimediaApiBase = 'https://commons.wikimedia.org/w/api.php';
  private readonly scraperBridge: ScraperBridge;
  private readonly openai: OpenAI;

  constructor(openaiApiKey: string, imagesDir = './data/images') {
    this.imagesDir = imagesDir;
    this.scraperBridge = new ScraperBridge();
    this.openai = new OpenAI({ apiKey: openaiApiKey });
    this.ensureImagesDir();
  }

  /**
   * Source images for an artist using 3-layer verification pipeline.
   */
  async sourceImages(
    artist: ArtistInfo,
    sources: Source[],
    _draftId: number,
    maxImages = 3
  ): Promise<Image[]> {
    console.log(`\n🖼️  Sourcing verified images for ${artist.full_name}...`);

    const images: Image[] = [];

    // Layer 1: Extract from verified sources (no Claude verification needed)
    await this.extractFromVerifiedSources(artist, sources, images, maxImages);

    // Layer 2: Wikimedia Commons + Claude Vision
    if (images.length < maxImages) {
      await this.searchWikimediaVerified(artist, images, maxImages);
    }

    // Layer 3: Web search + Claude Vision
    if (images.length < maxImages) {
      await this.searchWebVerified(artist, images, maxImages);
    }

    console.log(`  ✓ Sourced ${images.length} verified images total`);
    return images;
  }

  /**
   * Layer 1: Extract images directly from verified source pages.
   */
  private async extractFromVerifiedSources(
    artist: ArtistInfo,
    sources: Source[],
    images: Image[],
    maxImages: number
  ): Promise<void> {
    const scraperAvailable = await this.scraperBridge.isAvailable();
    if (!scraperAvailable) {
      console.log('  Scrapling not available — skipping source extraction');
      return;
    }

    // Sort by credibility_score descending
    const sortedSources = [...sources].sort(
      (a, b) => (b.credibility_score ?? 0) - (a.credibility_score ?? 0)
    );

    for (const source of sortedSources) {
      if (images.length >= maxImages) break;

      try {
        console.log(`  Extracting images from ${source.institution}: ${source.url}`);
        const result = await this.scraperBridge.extractImages(source.url, 200, maxImages - images.length);

        if (result.success && result.images.length > 0) {
          for (const img of result.images) {
            if (images.length >= maxImages) break;
            // Even verified sources need quality check (could be banners/thumbnails)
            const quality = await this.verifyImageWithClaude(img.url, artist);
            if (quality.verified) {
              images.push({
                url: img.url,
                caption: img.alt || `Artwork by ${artist.full_name}`,
                attribution: `Source: ${source.institution}. Credibility: ${source.credibility_score?.toFixed(1) ?? '1.0'}.`,
              });
              console.log(`  ✓ Added verified image from ${source.institution}: ${quality.reason}`);
            } else {
              console.log(`  ✗ Rejected from ${source.institution}: ${quality.reason}`);
            }
          }
        }
      } catch (error) {
        console.warn(`  ✗ Failed to extract from ${source.url}:`, error);
      }
    }
  }

  /**
   * Layer 2: Search Wikimedia Commons, verify with Claude Vision.
   */
  private async searchWikimediaVerified(
    artist: ArtistInfo,
    images: Image[],
    maxImages: number
  ): Promise<void> {
    const query = this.buildSearchQuery(artist);
    console.log(`  Searching Wikimedia: "${query}"`);

    const wikimediaImages = await this.searchWikimedia(query, (maxImages - images.length) * 2);
    console.log(`  Found ${wikimediaImages.length} Wikimedia candidates`);

    for (const wikiImage of wikimediaImages) {
      if (images.length >= maxImages) break;

      const verification = await this.verifyImageWithClaude(wikiImage.url, artist);
      if (verification.verified) {
        images.push({
          url: wikiImage.url,
          caption: wikiImage.description ?? `Artwork by ${artist.full_name}`,
          attribution: this.generateAttribution(wikiImage),
        });
        console.log(`  ✓ Wikimedia image verified: ${verification.reason}`);
      } else {
        console.log(`  ✗ Wikimedia image rejected: ${verification.reason}`);
      }
    }
  }

  /**
   * Layer 3: Web search via Scrapling, verify with Claude Vision.
   */
  private async searchWebVerified(
    artist: ArtistInfo,
    images: Image[],
    maxImages: number
  ): Promise<void> {
    const scraperAvailable = await this.scraperBridge.isAvailable();
    if (!scraperAvailable) {
      console.log('  Scrapling not available — skipping web search');
      return;
    }

    const query = this.buildSearchQuery(artist);
    console.log(`  Searching web: "${query}"`);

    const searchResult = await this.scraperBridge.searchImages(query, 'all', (maxImages - images.length) * 2);

    if (!searchResult.success || searchResult.images.length === 0) {
      console.log('  No web search results');
      return;
    }

    console.log(`  Found ${searchResult.images.length} web search candidates`);

    for (const img of searchResult.images) {
      if (images.length >= maxImages) break;

      const verification = await this.verifyImageWithClaude(img.url, artist);
      if (verification.verified) {
        images.push({
          url: img.url,
          caption: img.caption || `Artwork by ${artist.full_name}`,
          attribution: `Verified via Claude Vision. Educational use.`,
        });
        console.log(`  ✓ Web image verified: ${verification.reason}`);
      } else {
        console.log(`  ✗ Web image rejected: ${verification.reason}`);
      }
    }
  }

  /**
   * Verify an image belongs to the artist using OpenAI Vision (GPT-4o).
   * Fail-safe: on error, rejects the image.
   */
  private async verifyImageWithClaude(
    imageUrl: string,
    artist: ArtistInfo
  ): Promise<{ verified: boolean; reason: string }> {
    try {
      // Download image as base64
      const imageData = await this.downloadImageAsBase64(imageUrl);
      if (!imageData) {
        return { verified: false, reason: 'Could not download image for verification' };
      }

      const practiceInfo = artist.visual_practice ? ` Their artistic practice: ${artist.visual_practice}.` : '';
      const locationInfo = artist.birthplace_city
        ? ` Based in ${artist.birthplace_city}${artist.birthplace_state ? `, ${artist.birthplace_state}` : ''}.`
        : '';

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${imageData.mediaType};base64,${imageData.base64}`,
                },
              },
              {
                type: 'text',
                text: `Evaluate this image for use in an article about the artist "${artist.full_name}".${practiceInfo}${locationInfo}

Answer with a JSON object: {"verified": true/false, "reason": "brief explanation"}

Verify ALL of these criteria (reject if ANY fails):
1. ARTWORK: This must be an artwork (painting, print, woodcut print, etc.), not a photo of a person, UI element, logo, or banner.
2. PAPER PRINT ONLY — NOT A PHYSICAL OBJECT: Look carefully at the image. Ask yourself: "Am I looking at ink on paper, or a photo of a 3D object?"
   - ACCEPT: A print on paper (ink transferred from a woodblock to paper). The background should be the paper itself (white, cream, off-white). The image looks flat, like a scan or a straight-on photo of paper.
   - REJECT if ANY of these are true:
     * The image shows a carved wooden block or matrix (you can see wood grain, the carving is recessed into wood, the medium is WOOD not paper)
     * There is a gray, colored, or gradient background BEHIND the artwork (this means it's a photo of a physical object, not a scan of a print)
     * There are visible shadows cast by the artwork (means it's a 3D object being photographed)
     * The artwork appears to float or have depth/perspective (mockup or framed piece)
     * You can see a frame, wall, gallery, or room around the artwork
     * The edges of the artwork look like a thick physical object rather than a flat sheet of paper
   For woodcut/xilogravura artists: we want the PRINTED RESULT on paper, NOT the carved wooden block.
3. ATTRIBUTION: The artwork style must plausibly match the artist. If you can't confirm, reject.
4. FILLS THE FRAME — NO WIDE BORDERS: The artwork must fill at least 90% of the image area. REJECT if ANY of these are true:
     * The artwork is centered on a sheet of paper with obvious wide white/blank margins around it (more than ~5% of the image on any side)
     * There is handwriting, a signature, numbering (like "2/10"), or text below/above the artwork
     * The artwork is small and "floating" within a much larger blank image
   A thin sliver of paper edge or minimal texture at the border is OK — what matters is that the artwork dominates the image. Close-up crops that fill the frame are ideal.
5. COMPLETE: The artwork should show ONE piece, not a collage of multiple works or a tiny thumbnail.
6. HIGH RESOLUTION AND SHARP: The image must be crisp with clearly visible fine details and textures. REJECT if the image looks soft, fuzzy, compressed, low-resolution, or if you cannot make out fine lines and details clearly.

When in doubt on any criterion, say false.`,
              },
            ],
          },
        ],
      });

      const text = response.choices[0]?.message?.content || '';
      const jsonMatch = text.match(/\{[^}]+\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          verified: parsed.verified === true,
          reason: parsed.reason || 'No reason given',
        };
      }

      return { verified: false, reason: 'Could not parse verification response' };
    } catch (error) {
      console.warn(`  OpenAI Vision verification failed for ${imageUrl}:`, error);
      return { verified: false, reason: 'Verification error — rejected for safety' };
    }
  }

  /**
   * Download an image and return as base64 with media type.
   */
  private async downloadImageAsBase64(
    url: string
  ): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' } | null> {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      // Reject small files (< 50KB — likely low-res, thumbnails, or icons)
      const buffer = Buffer.from(response.data);
      if (buffer.length < 50_000) {
        console.log(`  Skipped ${url} — file too small (${(buffer.length / 1024).toFixed(0)}KB, min 50KB)`);
        return null;
      }

      const contentType = response.headers['content-type'] || '';
      let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg';
      if (contentType.includes('png')) mediaType = 'image/png';
      else if (contentType.includes('gif')) mediaType = 'image/gif';
      else if (contentType.includes('webp')) mediaType = 'image/webp';

      const base64 = buffer.toString('base64');
      return { base64, mediaType };
    } catch {
      return null;
    }
  }

  /**
   * Build a specific search query using artist details instead of generic terms.
   */
  private buildSearchQuery(artist: ArtistInfo): string {
    const parts = [artist.full_name];

    if (artist.visual_practice) {
      parts.push(artist.visual_practice);
    } else {
      parts.push('artwork');
    }

    if (artist.birthplace_state) {
      parts.push(artist.birthplace_state);
    } else if (artist.birthplace_city) {
      parts.push(artist.birthplace_city);
    }

    return parts.join(' ');
  }

  /**
   * Search Wikimedia Commons for artist images.
   */
  private async searchWikimedia(query: string, limit: number): Promise<WikimediaImage[]> {
    try {
      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        generator: 'search',
        gsrsearch: query,
        gsrlimit: String(Math.min(limit * 2, 10)),
        prop: 'imageinfo',
        iiprop: 'url|extmetadata',
        iiurlwidth: '800',
      });

      const response = await axios.get(`${this.wikimediaApiBase}?${params.toString()}`, {
        timeout: 15000,
        headers: {
          'User-Agent': 'CASCA-Editorial-Agent/1.0 (https://github.com/casca-archive; victoryves@gmail.com)',
        },
      });

      const pages = response.data?.query?.pages;
      if (!pages) return [];

      const images: WikimediaImage[] = [];

      for (const page of Object.values(pages) as any[]) {
        const imageInfo = page.imageinfo?.[0];
        if (!imageInfo) continue;

        const metadata = imageInfo.extmetadata;

        images.push({
          title: page.title,
          url: imageInfo.url,
          description: metadata?.ImageDescription?.value,
          author: metadata?.Artist?.value,
          license: metadata?.License?.value,
          thumb_url: imageInfo.thumburl,
        });

        if (images.length >= limit) break;
      }

      return images;
    } catch (error) {
      console.warn('Wikimedia search failed:', error);
      return [];
    }
  }

  /**
   * Generate proper attribution text for Wikimedia images.
   */
  private generateAttribution(image: WikimediaImage): string {
    const parts: string[] = [];

    if (image.author) {
      parts.push(`Image: ${this.cleanHtml(image.author)}`);
    }

    if (image.license) {
      parts.push(`License: ${this.cleanHtml(image.license)}`);
    }

    parts.push('Source: Wikimedia Commons');

    return parts.join('. ');
  }

  /**
   * Clean HTML from metadata.
   */
  private cleanHtml(text: string): string {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }

  /**
   * Ensure images directory exists.
   */
  private ensureImagesDir(): void {
    if (!fs.existsSync(this.imagesDir)) {
      fs.mkdirSync(this.imagesDir, { recursive: true });
    }
  }

  /**
   * Get image as base64 for email embedding.
   */
  getImageBase64(filepath: string): string {
    const buffer = fs.readFileSync(filepath);
    return buffer.toString('base64');
  }

  /**
   * Get image mime type.
   */
  getImageMimeType(filepath: string): string {
    const ext = path.extname(filepath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    return mimeTypes[ext] || 'image/jpeg';
  }
}
