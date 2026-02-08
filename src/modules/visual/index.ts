/**
 * Visual Materials Module
 *
 * Sources and manages images for articles from Wikimedia Commons and institutional sources.
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type { Image, WikimediaImage } from '../../types/index.js';

export class VisualModule {
  private readonly imagesDir: string;
  private readonly wikimediaApiBase = 'https://commons.wikimedia.org/w/api.php';
  private readonly unsplashApiBase = 'https://api.unsplash.com';

  constructor(imagesDir = './data/images') {
    this.imagesDir = imagesDir;
    this.ensureImagesDir();
  }

  /**
   * Source images for an artist
   */
  async sourceImages(artistName: string, draftId: number, maxImages = 3): Promise<Image[]> {
    console.log(`\n🖼️  Sourcing images for ${artistName}...`);

    const images: Image[] = [];
    // Request more images than needed to account for download failures
    const searchLimit = maxImages * 2;

    try {
      // Try Wikimedia Commons first
      const wikimediaImages = await this.searchWikimedia(artistName, searchLimit);
      console.log(`  Found ${wikimediaImages.length} Wikimedia images`);

      if (wikimediaImages.length > 0) {
        // Download Wikimedia images
        for (const wikiImage of wikimediaImages) {
          try {
            images.push({
              url: wikiImage.url,
              caption: wikiImage.description ?? `Artwork by ${artistName}`,
              attribution: this.generateAttribution(wikiImage),
            });
            console.log(`  ✓ Added Wikimedia image`);
          } catch (error) {
            console.warn(`  ✗ Failed to process image:`, error);
          }
        }
      }

      // If no Wikimedia images, try multiple sources
      if (images.length === 0) {
        // Try source 1: Bing Images (more permissive)
        console.log(`  Searching Bing Images for ${artistName}'s artwork...`);
        const bingImages = await this.searchBingImages(artistName, searchLimit);
        console.log(`  Found ${bingImages.length} Bing Images`);

        for (const bingImage of bingImages) {
          images.push({
            url: bingImage.url,
            caption: bingImage.caption,
            attribution: bingImage.attribution,
          });
        }

        // If still not enough, try DuckDuckGo
        if (images.length < searchLimit) {
          console.log(`  Searching DuckDuckGo for ${artistName}'s artwork...`);
          const ddgImages = await this.searchDuckDuckGoImages(
            artistName,
            searchLimit - images.length
          );
          console.log(`  Found ${ddgImages.length} DuckDuckGo Images`);

          for (const ddgImage of ddgImages) {
            images.push({
              url: ddgImage.url,
              caption: ddgImage.caption,
              attribution: ddgImage.attribution,
            });
          }
        }

        // Fallback: Google Images as last resort
        if (images.length < searchLimit) {
          console.log(`  Searching Google Images for ${artistName}'s artwork...`);
          const googleImages = await this.searchGoogleImages(
            artistName,
            searchLimit - images.length
          );
          console.log(`  Found ${googleImages.length} Google Images`);

          for (const googleImage of googleImages) {
            images.push({
              url: googleImage.url,
              caption: googleImage.caption,
              attribution: googleImage.attribution,
            });
          }
        }
      }

      console.log(`  ✓ Sourced ${images.length} images total`);
    } catch (error) {
      console.error('Error sourcing images:', error);
    }

    return images;
  }

  /**
   * Search Wikimedia Commons for artist images
   */
  private async searchWikimedia(artistName: string, limit: number): Promise<WikimediaImage[]> {
    try {
      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        generator: 'search',
        gsrsearch: `${artistName} artwork OR painting OR sculpture`,
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
   * Download image to local storage
   */
  private async downloadImage(url: string, draftId: number): Promise<string> {
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    const filename = `draft-${draftId}-${Date.now()}${ext}`;
    const filepath = path.join(this.imagesDir, filename);

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    fs.writeFileSync(filepath, response.data);

    return filepath;
  }

  /**
   * Generate proper attribution text
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
   * Clean HTML from metadata
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
   * Ensure images directory exists
   */
  private ensureImagesDir(): void {
    if (!fs.existsSync(this.imagesDir)) {
      fs.mkdirSync(this.imagesDir, { recursive: true });
    }
  }

  /**
   * Get image as base64 for email embedding
   */
  getImageBase64(filepath: string): string {
    const buffer = fs.readFileSync(filepath);
    return buffer.toString('base64');
  }

  /**
   * Get image mime type
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

  /**
   * Search Google Images for artist's artwork via scraping
   */
  private async searchGoogleImages(
    artistName: string,
    limit: number
  ): Promise<Array<{ url: string; caption: string; attribution: string }>> {
    try {
      // First try curated database
      const curatedArtistImages = await this.getCuratedArtistImages(artistName);
      if (curatedArtistImages.length > 0) {
        return curatedArtistImages.slice(0, limit);
      }

      // If not in database, scrape Google Images
      console.log(`  Scraping Google Images for ${artistName}...`);
      const query = encodeURIComponent(`${artistName} painting artwork`);
      const searchUrl = `https://www.google.com/search?q=${query}&tbm=isch&num=50`;

      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 10000,
      });

      // Extract image URLs from the HTML
      const html = response.data as string;
      const imageUrls = this.extractImageUrlsFromGoogleHtml(html, limit * 2);

      if (imageUrls.length > 0) {
        return imageUrls.map((url, idx) => ({
          url,
          caption: `Artwork by ${artistName}`,
          attribution: `Image from Google Images search. Educational use.`,
        }));
      }

      console.warn(`  No images found via scraping for ${artistName}`);
      return [];
    } catch (error) {
      console.error('Google Images scraping failed:', error);
      return [];
    }
  }

  /**
   * Extract image URLs from Google Images HTML
   */
  private extractImageUrlsFromGoogleHtml(html: string, limit: number): string[] {
    const urls: string[] = [];

    // Google Images stores image URLs in various formats
    // Pattern 1: Look for direct image URLs in the HTML
    const urlPattern1 = /"(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
    const matches1 = html.matchAll(urlPattern1);

    for (const match of matches1) {
      let url = match[1];
      // Decode unicode escapes (e.g., \u003d to =)
      url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
        String.fromCharCode(parseInt(code, 16))
      );
      // Filter out small icons and Google's own images
      if (
        !url.includes('google.com/images') &&
        !url.includes('gstatic.com') &&
        !url.includes('googleusercontent.com') &&
        url.length > 50
      ) {
        urls.push(url);
        if (urls.length >= limit) break;
      }
    }

    // If not enough URLs found, try alternative pattern
    if (urls.length < limit) {
      const urlPattern2 = /\["(https:\/\/[^"]+)","(\d+)","(\d+)"\]/g;
      const matches2 = html.matchAll(urlPattern2);

      for (const match of matches2) {
        let url = match[1];
        const width = parseInt(match[2]);
        const height = parseInt(match[3]);

        // Decode unicode escapes
        url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
          String.fromCharCode(parseInt(code, 16))
        );

        // Only get reasonably sized images
        if (width > 300 && height > 300 && !urls.includes(url)) {
          urls.push(url);
          if (urls.length >= limit) break;
        }
      }
    }

    return [...new Set(urls)].slice(0, limit);
  }

  /**
   * Get curated images from known museum sources for specific artists
   */
  private async getCuratedArtistImages(
    artistName: string
  ): Promise<Array<{ url: string; caption: string; attribution: string }>> {
    // Database of known Brazilian artists with publicly accessible image URLs
    // These URLs are from public domain or fair use sources
    const artistDatabase: Record<
      string,
      Array<{ url: string; title: string; source: string }>
    > = {
      // Curated database currently empty - relying on web scraping for now
      // TODO: Add verified museum URLs when found
    };

    const normalizedName = artistName.trim();

    if (artistDatabase[normalizedName]) {
      return artistDatabase[normalizedName].map((artwork) => ({
        url: artwork.url,
        caption: `"${artwork.title}" by ${artistName}`,
        attribution: `Image source: ${artwork.source}. Fair use for educational purposes.`,
      }));
    }

    // If artist not in database, return empty to trigger image search
    return [];
  }

  /**
   * Search Bing Images for artist's artwork
   */
  private async searchBingImages(
    artistName: string,
    limit: number
  ): Promise<Array<{ url: string; caption: string; attribution: string }>> {
    try {
      const query = encodeURIComponent(`${artistName} painting artwork`);
      const searchUrl = `https://www.bing.com/images/search?q=${query}&form=HDRSC2`;

      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 10000,
      });

      const html = response.data as string;

      // Extract image URLs from Bing's HTML
      const urls: string[] = [];
      const urlPattern = /"murl":"([^"]+)"/g;
      const matches = html.matchAll(urlPattern);

      for (const match of matches) {
        const url = match[1];
        if (url && url.startsWith('http') && !urls.includes(url)) {
          urls.push(url);
          if (urls.length >= limit) break;
        }
      }

      return urls.map((url, idx) => ({
        url,
        caption: `Artwork by ${artistName} (${idx + 1})`,
        attribution: `Image from Bing Images search. Educational use.`,
      }));
    } catch (error) {
      console.warn('Bing Images search failed:', error);
      return [];
    }
  }

  /**
   * Search DuckDuckGo Images for artist's artwork
   */
  private async searchDuckDuckGoImages(
    artistName: string,
    limit: number
  ): Promise<Array<{ url: string; caption: string; attribution: string }>> {
    try {
      const query = encodeURIComponent(`${artistName} painting artwork`);
      const searchUrl = `https://duckduckgo.com/?q=${query}&iax=images&ia=images`;

      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 10000,
      });

      const html = response.data as string;

      // Extract image URLs
      const urls: string[] = [];
      const urlPattern = /"image":"([^"]+)"/g;
      const matches = html.matchAll(urlPattern);

      for (const match of matches) {
        let url = match[1];
        url = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
          String.fromCharCode(parseInt(code, 16))
        );

        if (url && url.startsWith('http') && !urls.includes(url)) {
          urls.push(url);
          if (urls.length >= limit) break;
        }
      }

      return urls.map((url, idx) => ({
        url,
        caption: `Artwork by ${artistName} (${idx + 1})`,
        attribution: `Image from DuckDuckGo Images. Educational use.`,
      }));
    } catch (error) {
      console.warn('DuckDuckGo Images search failed:', error);
      return [];
    }
  }
}
