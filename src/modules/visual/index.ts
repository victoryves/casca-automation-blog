/**
 * Visual Materials Module
 *
 * Sources and manages images for articles using a 3-layer verification pipeline:
 * 1. Extract from verified sources (highest confidence)
 * 2. Wikimedia Commons + Gemini vision verification
 * 3. Web search + Gemini vision verification
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type { Image, Source, WikimediaImage } from '../../types/index.js';
import { GeminiClient } from '../../lib/gemini.js';
import { ScraperBridge } from '../scraper-bridge/index.js';

interface ArtistInfo {
  full_name: string;
  visual_practice?: string;
  birthplace_city?: string;
  birthplace_state?: string;
}

interface DirectImageCandidate {
  url: string;
  context: string;
  alt: string;
  title: string;
  objectTitle: string;
  objectHref: string;
}

interface VerificationCacheEntry {
  verified: boolean;
  reason: string;
  cachedAt: string;
}

export class VisualModule {
  private readonly imagesDir: string;
  private readonly verificationCachePath: string;
  private readonly verificationSchemaVersion = 'v2.2';
  private readonly wikimediaApiBase = 'https://commons.wikimedia.org/w/api.php';
  private readonly scraperBridge: ScraperBridge;
  private readonly gemini: GeminiClient;
  private visionUnavailableUntil = 0;
  private verificationCache = new Map<string, VerificationCacheEntry>();

  constructor(geminiApiKey: string, imagesDir = './data/images') {
    this.imagesDir = imagesDir;
    this.verificationCachePath = path.join(path.dirname(imagesDir), 'image-verification-cache.json');
    this.scraperBridge = new ScraperBridge();
    this.gemini = new GeminiClient(geminiApiKey);
    this.ensureImagesDir();
    this.loadVerificationCache();
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
    const selectedArtworkKeys = new Set<string>();

    // Layer 0: Extract likely artwork images directly from source HTML.
    await this.extractDirectSourceImages(artist, sources, images, maxImages, selectedArtworkKeys);

    // Layer 1: Extract from verified sources (no Claude verification needed)
    if (images.length < maxImages) {
      await this.extractFromVerifiedSources(artist, sources, images, maxImages, selectedArtworkKeys);
    }

    // Layer 2: Wikimedia Commons + Claude Vision
    if (images.length < maxImages && !this.isVisionTemporarilyUnavailable()) {
      await this.searchWikimediaVerified(artist, images, maxImages, selectedArtworkKeys);
    }

    // Layer 3: Web search + Claude Vision
    if (images.length < maxImages && !this.isVisionTemporarilyUnavailable()) {
      await this.searchWebVerified(artist, images, maxImages, selectedArtworkKeys);
    }

    console.log(`  ✓ Sourced ${images.length} verified images total`);
    return images;
  }

  /**
   * Layer 0: Directly fetch source HTML and extract likely artwork image URLs.
   * This works even when Scrapling is unavailable or partially broken.
   */
  private async extractDirectSourceImages(
    artist: ArtistInfo,
    sources: Source[],
    images: Image[],
    maxImages: number,
    selectedArtworkKeys: Set<string>
  ): Promise<void> {
    const sortedSources = [...sources].sort(
      (a, b) => (b.credibility_score ?? 0) - (a.credibility_score ?? 0)
    );

    for (const source of sortedSources) {
      if (images.length >= maxImages) break;
      if (this.isSocialSource(source.url, source.institution)) {
        console.log(`  Skipping social source for images: ${source.url}`);
        continue;
      }

      try {
        const response = await axios.get(source.url, {
          timeout: 15000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
        });

        const html = typeof response.data === 'string' ? response.data : '';
        if (!html) continue;

        const candidates = this.extractImageCandidatesFromHtml(html, source.url);
        for (const candidate of candidates) {
          if (images.length >= maxImages) break;
          const resolvedCandidates = await this.expandCandidateFromObjectPage(candidate, source.url);

          for (const resolvedCandidate of resolvedCandidates) {
            if (images.length >= maxImages) break;
            const artworkKey = this.buildArtworkKey(
              resolvedCandidate.url,
              resolvedCandidate.objectHref,
              resolvedCandidate.objectTitle
            );
            if (selectedArtworkKeys.has(artworkKey)) continue;

            const candidateMetadata = `${resolvedCandidate.alt} ${resolvedCandidate.title} ${resolvedCandidate.objectTitle}`.trim();
            const chosenLabel = resolvedCandidate.objectTitle || resolvedCandidate.alt || resolvedCandidate.title;

            if (
              (!resolvedCandidate.objectTitle.trim() && resolvedCandidate.context.includes('visualizacao rapida')) ||
              ((!resolvedCandidate.objectTitle.trim() && !resolvedCandidate.objectHref.trim()) &&
                ['untitled', 'sem titulo'].includes(resolvedCandidate.alt.trim().toLowerCase())) ||
              (!candidateMetadata &&
                !this.containsArtworkSignals(this.normalizeText(resolvedCandidate.url))) ||
              (!resolvedCandidate.alt.trim() &&
                !resolvedCandidate.title.trim() &&
                !resolvedCandidate.objectTitle.trim() &&
                !resolvedCandidate.objectHref.trim())
            ) {
              console.log(
                `  ✗ Rejected direct-source image from ${source.institution}: Image lacks descriptive metadata and object link`
              );
              continue;
            }

            if (!this.isMeaningfulArtworkLabel(chosenLabel, resolvedCandidate.context, resolvedCandidate.objectHref)) {
              console.log(
                `  ✗ Rejected direct-source image from ${source.institution}: Candidate lacks a specific artwork title or object description`
              );
              continue;
            }

            const prevalidated = await this.prevalidateSourceImage(
              resolvedCandidate.url,
              `${resolvedCandidate.url} ${resolvedCandidate.context} ${source.url} ${source.institution} ${source.content_summary ?? ''}`,
              true,
              true,
              artist
            );
            if (!prevalidated.ok) {
              console.log(`  ✗ Rejected direct-source image from ${source.institution}: ${prevalidated.reason}`);
              continue;
            }

            if (
              this.isMarketArtworkHost(resolvedCandidate.url) &&
              !this.assetUrlStronglyTargetsArtist(resolvedCandidate.url, artist.full_name)
            ) {
              console.log(
                `  ✗ Rejected direct-source image from ${source.institution}: Asset URL does not strongly target ${artist.full_name}`
              );
              continue;
            }

            if (
              this.shouldAcceptHighConfidenceTrustedArtwork(
                source,
                resolvedCandidate.url,
                resolvedCandidate.objectHref || source.url,
                `${resolvedCandidate.objectTitle} ${resolvedCandidate.alt} ${resolvedCandidate.title} ${resolvedCandidate.context}`,
                artist
              )
            ) {
              images.push({
                url: resolvedCandidate.url,
                caption: chosenLabel || `Artwork by ${artist.full_name}`,
                attribution: `Source: ${source.institution}. Credibility: ${source.credibility_score?.toFixed(1) ?? '1.0'}.`,
              });
              selectedArtworkKeys.add(artworkKey);
              console.log(`  ✓ Added direct-source image from ${source.institution}: High-confidence trusted-source acceptance`);
              break;
            }

            const quality = await this.verifyImageWithClaude(resolvedCandidate.url, artist);
            if (quality.verified && !this.isNegativeVerificationReason(quality.reason)) {
              images.push({
                url: resolvedCandidate.url,
                caption: chosenLabel || `Artwork by ${artist.full_name}`,
                attribution: `Source: ${source.institution}. Credibility: ${source.credibility_score?.toFixed(1) ?? '1.0'}.`,
              });
              selectedArtworkKeys.add(artworkKey);
              console.log(`  ✓ Added direct-source image from ${source.institution}: ${quality.reason}`);
              break;
            } else {
              console.log(`  ✗ Rejected direct-source image from ${source.institution}: ${quality.reason}`);
            }
          }
        }
      } catch (error) {
        console.warn(`  ✗ Failed direct image extraction from ${source.url}:`, error);
      }
    }
  }

  /**
   * Layer 1: Extract images directly from verified source pages.
   */
  private async extractFromVerifiedSources(
    artist: ArtistInfo,
    sources: Source[],
    images: Image[],
    maxImages: number,
    selectedArtworkKeys: Set<string>
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
      if (this.isSocialSource(source.url, source.institution)) {
        console.log(`  Skipping social source for images: ${source.url}`);
        continue;
      }

      try {
        console.log(`  Extracting images from ${source.institution}: ${source.url}`);
        const result = await this.scraperBridge.extractImages(source.url, 200, maxImages - images.length);

        if (result.success && result.images.length > 0) {
          for (const img of result.images) {
            if (images.length >= maxImages) break;
            const normalizedUrl = this.normalizeImageUrl(img.url);
            const artworkKey = this.buildArtworkKey(normalizedUrl, img.source_page, img.alt);
            if (selectedArtworkKeys.has(artworkKey)) continue;

            const prevalidated = await this.prevalidateSourceImage(
              normalizedUrl,
              `${normalizedUrl} ${img.alt} ${source.url} ${source.institution} ${source.content_summary ?? ''}`,
              true,
              true,
              artist
            );
            if (!prevalidated.ok) {
              console.log(`  ✗ Rejected from ${source.institution}: ${prevalidated.reason}`);
              continue;
            }

            if (
              this.isMarketArtworkHost(normalizedUrl) &&
              !this.assetUrlStronglyTargetsArtist(normalizedUrl, artist.full_name)
            ) {
              console.log(
                `  ✗ Rejected from ${source.institution}: Asset URL does not strongly target ${artist.full_name}`
              );
              continue;
            }

            // Even verified sources need quality check (could be banners/thumbnails)
            if (
              this.shouldAcceptHighConfidenceTrustedArtwork(
                source,
                normalizedUrl,
                img.source_page || source.url,
                `${img.alt} ${img.source_page ?? ''}`,
                artist
              )
            ) {
              images.push({
                url: normalizedUrl,
                caption: img.alt || `Artwork by ${artist.full_name}`,
                attribution: `Source: ${source.institution}. Credibility: ${source.credibility_score?.toFixed(1) ?? '1.0'}.`,
              });
              selectedArtworkKeys.add(artworkKey);
              console.log(`  ✓ Added verified image from ${source.institution}: High-confidence trusted-source acceptance`);
              continue;
            }

            const quality = await this.verifyImageWithClaude(normalizedUrl, artist);
            if (quality.verified) {
              images.push({
                url: normalizedUrl,
                caption: img.alt || `Artwork by ${artist.full_name}`,
                attribution: `Source: ${source.institution}. Credibility: ${source.credibility_score?.toFixed(1) ?? '1.0'}.`,
              });
              selectedArtworkKeys.add(artworkKey);
              console.log(
                `  ✓ Added verified image from ${source.institution}: ${quality.reason}`
              );
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
    maxImages: number,
    selectedArtworkKeys: Set<string>
  ): Promise<void> {
    const query = this.buildSearchQuery(artist);
    console.log(`  Searching Wikimedia: "${query}"`);

    const wikimediaImages = await this.searchWikimedia(query, (maxImages - images.length) * 2);
    console.log(`  Found ${wikimediaImages.length} Wikimedia candidates`);

    for (const wikiImage of wikimediaImages) {
      if (images.length >= maxImages) break;
      const artworkKey = this.buildArtworkKey(wikiImage.url, wikiImage.url, wikiImage.title ?? wikiImage.description);
      if (selectedArtworkKeys.has(artworkKey)) continue;

      if (this.shouldAcceptHeuristicWebCandidate(wikiImage, artist)) {
        images.push({
          url: wikiImage.url,
          caption: wikiImage.description ?? `Artwork by ${artist.full_name}`,
          attribution: this.generateAttribution(wikiImage),
        });
        selectedArtworkKeys.add(artworkKey);
        console.log('  ✓ Wikimedia image accepted by heuristic filter');
        continue;
      }

      const verification = await this.verifyImageWithClaude(wikiImage.url, artist);
      if (verification.verified) {
        images.push({
          url: wikiImage.url,
          caption: wikiImage.description ?? `Artwork by ${artist.full_name}`,
          attribution: this.generateAttribution(wikiImage),
        });
        selectedArtworkKeys.add(artworkKey);
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
    maxImages: number,
    selectedArtworkKeys: Set<string>
  ): Promise<void> {
    const scraperAvailable = await this.scraperBridge.isAvailable();
    if (!scraperAvailable) {
      console.log('  Scrapling not available — skipping web search');
      return;
    }

    const queries = this.buildWebImageQueries(artist);
    const remainingSlots = maxImages - images.length;
    const searchCandidates = await this.collectWebSearchCandidates(
      queries,
      Math.max(remainingSlots * 6, 12),
      artist
    );

    if (searchCandidates.length === 0) {
      console.log('  No web search results');
      return;
    }

    console.log(`  Found ${searchCandidates.length} web search candidates`);

    for (const img of searchCandidates) {
      if (images.length >= maxImages) break;
      const normalizedUrl = this.normalizeImageUrl(img.url);
      const artworkKey = this.buildArtworkKey(normalizedUrl, img.source_page, img.caption);
      if (selectedArtworkKeys.has(artworkKey)) continue;
      if (this.isSocialSource(img.source_page, img.source_page)) continue;

      const prevalidated = await this.prevalidateSourceImage(
        normalizedUrl,
        `${normalizedUrl} ${img.caption ?? ''} ${img.source_page ?? ''}`,
        true,
        this.webCandidateTargetsArtist(img, artist),
        artist
      );
      if (!prevalidated.ok) {
        console.log(`  ✗ Web image rejected: ${prevalidated.reason}`);
        continue;
      }

      if (this.shouldAcceptHeuristicWebCandidate(img, artist)) {
        images.push({
          url: normalizedUrl,
          caption: img.caption || `Artwork by ${artist.full_name}`,
          attribution: 'Accepted by heuristic filter before Gemini vision. Educational use.',
        });
        selectedArtworkKeys.add(artworkKey);
        console.log('  ✓ Web image accepted by heuristic filter');
        continue;
      }

      const verification = await this.verifyImageWithClaude(normalizedUrl, artist);
      if (verification.verified && !this.isNegativeVerificationReason(verification.reason)) {
        images.push({
          url: normalizedUrl,
          caption: img.caption || `Artwork by ${artist.full_name}`,
          attribution: `Verified via Gemini vision. Educational use.`,
        });
        selectedArtworkKeys.add(artworkKey);
        console.log(`  ✓ Web image verified: ${verification.reason}`);
      } else {
        console.log(`  ✗ Web image rejected: ${verification.reason}`);
      }
    }
  }

  private async collectWebSearchCandidates(
    queries: string[],
    desiredLimit: number,
    artist: ArtistInfo
  ): Promise<Array<{ url: string; caption: string; source_page: string }>> {
    const candidates: Array<{ url: string; caption: string; source_page: string }> = [];
    const seen = new Set<string>();

    for (const query of queries) {
      console.log(`  Searching web: "${query}"`);
      const searchResult = await this.scraperBridge.searchImages(query, 'all', Math.max(desiredLimit, 6));
      if (!searchResult.success || searchResult.images.length === 0) {
        continue;
      }

      for (const image of searchResult.images) {
        const normalizedUrl = this.normalizeImageUrl(image.url);
        const key = this.buildArtworkKey(normalizedUrl, image.source_page, image.caption);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          url: normalizedUrl,
          caption: image.caption,
          source_page: image.source_page,
        });
      }

      if (candidates.length >= desiredLimit) {
        break;
      }
    }

    const topLimit = Math.min(Math.max(5, Math.ceil(desiredLimit / 2)), 5);

    return candidates
      .sort((a, b) => this.scoreWebCandidate(b, artist) - this.scoreWebCandidate(a, artist))
      .slice(0, topLimit);
  }

  private buildWebImageQueries(artist: ArtistInfo): string[] {
    const artistName = artist.full_name.trim();
    const practice = artist.visual_practice?.trim();
    const stateOrCity = artist.birthplace_state?.trim() || artist.birthplace_city?.trim() || '';
    const queries = [
      `${artistName} art`,
      `${artistName} artwork`,
      `${artistName} obra`,
      `${artistName} artista`,
      practice ? `${artistName} ${practice} art` : '',
      practice ? `${artistName} ${practice} obra` : '',
      stateOrCity ? `${artistName} art ${stateOrCity}` : '',
      stateOrCity ? `${artistName} obra ${stateOrCity}` : '',
    ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

    return queries;
  }

  private scoreWebCandidate(
    candidate: { url: string; caption: string; source_page: string },
    artist: ArtistInfo
  ): number {
    const normalized = this.normalizeText(
      `${candidate.url} ${candidate.caption} ${candidate.source_page}`
    );
    let score = 0;

    if (!this.isSocialSource(candidate.source_page, candidate.source_page)) score += 4;
    if (this.webCandidateTargetsArtist(candidate, artist)) score += 4;
    if (this.containsArtworkSignals(normalized)) score += 3;
    if (this.isPhotographyPractice(artist)) score += 1;
    if (!this.isPhotographyPractice(artist) && this.looksLikeNonArtworkPhotoScene(normalized)) score -= 8;
    if (this.containsNonArtworkSignals(normalized, this.isPhotographyPractice(artist))) score -= 6;

    return score;
  }

  private webCandidateTargetsArtist(
    candidate: { url: string; caption: string; source_page: string },
    artist: ArtistInfo
  ): boolean {
    const haystack = this.normalizeText(
      `${candidate.url} ${candidate.caption} ${candidate.source_page}`
    );
    return this.metadataMatchesArtist(haystack, artist.full_name);
  }

  private shouldAcceptHeuristicWebCandidate(
    candidate: { url: string; caption?: string; source_page?: string; description?: string },
    artist: ArtistInfo
  ): boolean {
    const normalized = this.normalizeText(
      `${candidate.url} ${candidate.caption ?? ''} ${candidate.source_page ?? ''} ${candidate.description ?? ''}`
    );

    if (this.isSocialSource(candidate.source_page ?? '', candidate.source_page ?? '')) {
      return false;
    }

    if (!this.webCandidateTargetsArtist(
      {
        url: candidate.url,
        caption: candidate.caption ?? candidate.description ?? '',
        source_page: candidate.source_page ?? candidate.url,
      },
      artist
    )) {
      return false;
    }

    if (this.containsNonArtworkSignals(normalized, this.isPhotographyPractice(artist))) {
      return false;
    }

    if (!this.isPhotographyPractice(artist) && this.looksLikeNonArtworkPhotoScene(normalized)) {
      return false;
    }

    if (this.isPhotographyPractice(artist)) {
      return (
        normalized.includes('fotografia') ||
        normalized.includes('photography') ||
        normalized.includes('photo') ||
        normalized.includes('series')
      );
    }

    return this.containsArtworkSignals(normalized) && this.scoreWebCandidate(
      {
        url: candidate.url,
        caption: candidate.caption ?? candidate.description ?? '',
        source_page: candidate.source_page ?? candidate.url,
      },
      artist
    ) >= 8;
  }

  private isTrustedSource(source: Source): boolean {
    try {
      const hostname = new URL(source.url).hostname.toLowerCase();
      const trustedHosts = [
        'wikipedia.org',
        'wikimedia.org',
        'itaucultural.org.br',
        'moma.org',
        'tate.org.uk',
        'masp.org.br',
        'pinacoteca.org.br',
        'enciclopedia.itaucultural.org.br',
        'escritoriodearte.com',
      ];

      const hostTrusted = trustedHosts.some(
        (trustedHost) => hostname === trustedHost || hostname.endsWith(`.${trustedHost}`)
      );

      return hostTrusted && (source.credibility_score ?? 0) >= 0.9;
    } catch {
      return false;
    }
  }

  private isSocialSource(url: string, institution = ''): boolean {
    const normalizedInstitution = institution.toLowerCase();
    if (
      normalizedInstitution.includes('instagram') ||
      normalizedInstitution.includes('pinterest') ||
      normalizedInstitution.includes('facebook') ||
      normalizedInstitution.includes('twitter') ||
      normalizedInstitution.includes('x.com') ||
      normalizedInstitution.includes('tiktok')
    ) {
      return true;
    }

    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const socialHosts = [
        'instagram.com',
        'cdninstagram.com',
        'facebook.com',
        'fbcdn.net',
        'pinterest.com',
        'pinimg.com',
        'x.com',
        'twitter.com',
        'tiktok.com',
        'tumblr.com',
      ];

      return socialHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  }

  private async prevalidateSourceImage(
    url: string,
    contextText = '',
    requireArtworkSignal = false,
    allowSourceContextFallback = false,
    artist?: ArtistInfo
  ): Promise<{ ok: boolean; reason: string }> {
    if (this.isStrongArtworkAssetUrl(url)) {
      const imageData = await this.downloadImageAsBase64(url);
      if (!imageData) {
        return { ok: false, reason: 'Could not download image for validation' };
      }

      return { ok: true, reason: 'Proceeding based on strong artwork asset URL' };
    }

    if (this.isBlockedImageHost(url)) {
      return { ok: false, reason: 'Image host is too risky for approval emails' };
    }

    const imageData = await this.downloadImageAsBase64(url);
    if (!imageData) {
      return { ok: false, reason: 'Could not download image for validation' };
    }

    const normalizedContext = this.normalizeText(`${url} ${contextText}`);

    if (this.containsNonArtworkSignals(normalizedContext, false)) {
      return { ok: false, reason: 'Context suggests portrait, author photo, or book cover instead of artwork' };
    }

    if (artist && !this.isPhotographyPractice(artist) && this.looksLikeNonArtworkPhotoScene(normalizedContext)) {
      return { ok: false, reason: 'Context suggests a landscape or documentary photograph, not the artist artwork' };
    }

    if (requireArtworkSignal && !this.containsArtworkSignals(normalizedContext)) {
      if (allowSourceContextFallback) {
        return { ok: true, reason: 'Proceeding to visual verification based on trusted source context' };
      }
      return { ok: false, reason: 'No strong artwork signal found in caption or source context' };
    }

    return { ok: true, reason: 'Image passed direct-source validation' };
  }

  private containsNonArtworkSignals(text: string, allowPortraitArtwork = false): boolean {
    const blockedSignals = [
      'author photo',
      'artist photo',
      'photo of the artist',
      'artist portrait',
      'selfie',
      'people',
      'person',
      'portrait photo',
      'headshot',
      'face',
      'faces',
      'crowd',
      'group photo',
      'group of people',
      'man',
      'woman',
      'boy',
      'girl',
      'child',
      'children',
      'family',
      'friends',
      'audience',
      'profile',
      'author',
      'writer',
      'book launch',
      'biography',
      'biografia',
      'book',
      'livro',
      'ebook',
      'course',
      'curso',
      'class',
      'lesson',
      'workshop',
      'oficina',
      'lecture',
      'talk',
      'panel',
      'conference',
      'press',
      'news',
      'award',
      'prize',
      'ceremony',
      'stage',
      'microphone',
      'backdrop',
      'flyer',
      'poster',
      'cartaz',
      'event',
      'evento',
      'festival',
      'opening',
      'vernissage',
      'opening night',
      'press release',
      'press photo',
      'installation',
      'installation view',
      'installation shot',
      'exhibition',
      'exhibition view',
      'gallery view',
      'museum view',
      'gallery interior',
      'exhibition hall',
      'gallery space',
      'white wall',
      'on view',
      'on display',
      'displayed in',
      'display case',
      'display pedestal',
      'gallery wall',
      'museum gallery',
      'visitor',
      'visitors',
      'tour',
      'guided tour',
      'opening ceremony',
      'program',
      'programa',
      'registration',
      'inscricao',
      'enroll',
      'product',
      'produto',
      'store',
      'shop',
      'loja',
      'buy',
      'comprar',
      'sale',
      'venda',
      'price',
      'preco',
      'cart',
      'carrinho',
      'quadrinho',
      'tile',
      'tiles',
      'surface',
      'surfaces',
      'applied on',
      'application on',
      'mockup',
      'mock-up',
      'interior decor',
      'wall decor',
      'moldura',
      'frame',
      'framed',
      'azulejo',
      'madeira',
      'wood panel',
      'wood plaque',
      'artesanato',
      'decor',
      'decoration',
      'decorative object',
      'ornament',
      'product shot',
      'studio shot',
      'still life',
      'tabletop',
      'capa',
      'cover',
      'catalog',
      'catalogue',
      'publication',
      'publicacao',
      'person holding',
      'holding book',
      'foto do autor',
      'foto do artista',
      'inventory',
      'abebooks',
      'amazon',
      'kindle',
      'editora',
      'publisher',
      'isbn',
      'hardcover',
      'paperback',
      'workshop portrait',
      'interview',
    ];

    if (!allowPortraitArtwork) {
      blockedSignals.push('photo', 'photograph', 'photography', 'fotografia', 'foto');
      blockedSignals.push('portrait', 'retrato');
    }

    return blockedSignals.some((signal) => text.includes(signal));
  }

  private containsArtworkSignals(text: string): boolean {
    const artworkSignals = [
      'artwork',
      'work on paper',
      'work',
      'works',
      'obra',
      'obras',
      'painting',
      'paintings',
      'pintura',
      'pinturas',
      'woodcut',
      'woodcuts',
      'xilo',
      'xilogravura',
      'xilogravuras',
      'gravura',
      'gravuras',
      'print',
      'prints',
      'acervo',
      'collection',
      'colecao',
      'museum',
      'museu',
      'gallery',
      'galeria',
      'canvas',
      'tela',
      'paper',
      'papel',
      'cordel',
      'etching',
      'engraving',
      'linocut',
      'serigraph',
      'serigrafia',
      'silkscreen',
      'mixed media',
      'oil on canvas',
      'oleo',
      'guache',
      'gouache',
      'nanquim',
      'aquarela',
      'watercolor',
      'litogravura',
      'lithograph',
      'acrilica',
      'acrylic',
      'desenho',
      'grafite',
      'sepia',
      'acrylic on canvas',
      'tempera',
      'untitled',
      'series',
      'obra em',
    ];

    return artworkSignals.some((signal) => text.includes(signal));
  }

  private looksLikeNonArtworkPhotoScene(text: string): boolean {
    const photoSceneSignals = [
      'landscape',
      'paisagem',
      'beach',
      'praia',
      'ocean',
      'sea',
      'shore',
      'waves',
      'wave',
      'island',
      'ilha',
      'coast',
      'coastal',
      'rock formation',
      'mountain',
      'sky',
      'clouds',
      'sunset',
      'sunrise',
      'travel',
      'tourism',
      'turismo',
      'nature',
      'natural',
      'national park',
      'parque',
      'destination',
      'portrait',
      'retrato',
      'selfie',
      'headshot',
      'face',
      'faces',
      'person',
      'people',
      'crowd',
      'group',
      'man',
      'woman',
      'boy',
      'girl',
      'child',
      'children',
      'family',
      'audience',
      'event',
      'evento',
      'festival',
      'opening',
      'vernissage',
      'ceremony',
      'award',
      'prize',
      'conference',
      'talk',
      'lecture',
      'gallery',
      'museum',
      'exhibition',
      'installation',
      'installation view',
      'gallery view',
      'exhibition view',
      'museum view',
      'gallery interior',
      'gallery space',
      'white wall',
      'on display',
      'on view',
      'display case',
      'pedestal',
      'fernando de noronha',
      'cacimba do padre',
      'laurini',
    ];

    const photographicMediumSignals = [
      'photo',
      'photography',
      'fotografia',
      'jpg',
      'jpeg',
      'png',
      'webp',
      'camera',
      'shutter',
      'exposure',
    ];

    const artworkMediumSignals = [
      'painting',
      'pintura',
      'canvas',
      'tela',
      'woodcut',
      'xilogravura',
      'gravura',
      'drawing',
      'desenho',
      'mural',
      'wall painting',
      'acrylic',
      'oil on canvas',
      'watercolor',
      'guache',
      'gouache',
      'print',
      'obra',
      'artwork',
    ];

    const hasPhotoSceneSignal = photoSceneSignals.some((signal) => text.includes(signal));
    if (!hasPhotoSceneSignal) {
      return false;
    }

    const hasPhotographicMediumSignal = photographicMediumSignals.some((signal) => text.includes(signal));
    const hasArtworkMediumSignal = artworkMediumSignals.some((signal) => text.includes(signal));

    return hasPhotographicMediumSignal || !hasArtworkMediumSignal;
  }

  private isMeaningfulArtworkLabel(label: string, context = '', objectHref = ''): boolean {
    const cleanedLabel = label.replace(/["'`]+/g, ' ').replace(/\s+/g, ' ').trim();
    const normalizedLabel = this.normalizeText(cleanedLabel).replace(/\s+/g, ' ').trim();
    const normalizedContext = this.normalizeText(context).replace(/\s+/g, ' ').trim();
    const normalizedHref = this.normalizeText(objectHref);

    if (normalizedLabel.length >= 6) {
      const blockedGenericLabels = [
        'hoje',
        'today',
        'obra',
        'artwork',
        'work',
        'image',
        'imagem',
        'foto',
        'photo',
        'sem titulo',
        'untitled',
        'sem titulo i',
        'sem titulo ii',
        'centro de arte',
        'museu',
        'museum',
        'instituto',
        'itau cultural',
        'galeria',
        'gallery',
        'acervo',
        'colecao',
        'collection',
        'exposicao',
        'exhibition',
        'untitled work',
        'obra sem titulo',
      ];

      const looksGeneric = blockedGenericLabels.some(
        (blocked) => normalizedLabel === blocked || normalizedLabel.startsWith(`${blocked} `)
      );

      if (!looksGeneric && !this.containsNonArtworkSignals(normalizedLabel)) {
        return true;
      }
    }

    const hasSpecificObjectLink =
      normalizedHref.length > 0 &&
      !normalizedHref.includes('/pessoas/') &&
      !normalizedHref.includes('/artista/') &&
      !normalizedHref.endsWith('/');

    return (
      cleanedLabel.length >= 8 &&
      hasSpecificObjectLink &&
      this.containsArtworkSignals(normalizedContext) &&
      !this.containsNonArtworkSignals(normalizedContext)
    );
  }

  private isNegativeVerificationReason(reason: string): boolean {
    const normalizedReason = this.normalizeText(reason);
    const negativeSignals = [
      'not an artwork',
      'photo of a person',
      'photograph of a person',
      'portrait',
      'author photo',
      'artist photo',
      'book cover',
      'catalog',
      'poster',
      'flyer',
      'logo',
      'banner',
      'ui element',
      'mockup',
      'frame',
      'framed',
      'gallery wall',
      'room around the artwork',
      'physical object',
      'wooden block',
      'matrix',
      'wide white margins',
      'numbering',
      'signature',
      'low-resolution',
      'low resolution',
      'fuzzy',
      'soft',
      'blurry',
      'compressed',
      'cannot confirm',
      'cant confirm',
      'cannot verify',
      'wrong artist',
      'does not match',
      'appears to be',
      'looks like',
    ];

    return negativeSignals.some((signal) => normalizedReason.includes(signal));
  }

  private shouldAcceptTrustedSourceWithoutVision(
    source: Source,
    objectHref: string,
    metadataText: string,
    artist: ArtistInfo,
    verificationReason: string
  ): boolean {
    if (!this.isQuotaOrVisionOutageReason(verificationReason)) {
      return false;
    }

    if (!this.isTrustedSource(source)) {
      return false;
    }

    const normalizedMetadata = this.normalizeText(
      `${metadataText} ${source.url} ${objectHref} ${source.content_summary ?? ''}`
    );

    if (this.containsNonArtworkSignals(normalizedMetadata)) {
      return false;
    }

    if (!this.containsArtworkSignals(normalizedMetadata)) {
      return false;
    }

    if (!this.metadataMatchesArtist(normalizedMetadata, artist.full_name)) {
      return false;
    }

    const normalizedObjectHref = this.normalizeText(objectHref);
    if (
      normalizedObjectHref &&
      (normalizedObjectHref.includes('/artista/') || normalizedObjectHref.includes('/artist/')) &&
      !this.objectHrefTargetsArtist(normalizedObjectHref, artist.full_name)
    ) {
      return false;
    }

    return true;
  }

  private shouldAcceptHighConfidenceTrustedArtwork(
    source: Source,
    imageUrl: string,
    objectHref: string,
    metadataText: string,
    artist: ArtistInfo
  ): boolean {
    if (!this.isTrustedSource(source)) {
      return false;
    }

    if (this.isMarketArtworkHost(imageUrl) && !this.assetUrlStronglyTargetsArtist(imageUrl, metadataText)) {
      return false;
    }

    const normalizedMetadata = this.normalizeText(
      `${metadataText} ${imageUrl} ${source.url} ${objectHref} ${source.content_summary ?? ''}`
    );

    if (this.containsNonArtworkSignals(normalizedMetadata)) {
      return false;
    }

    if (!this.containsArtworkSignals(normalizedMetadata)) {
      return false;
    }

    if (!this.metadataMatchesArtist(normalizedMetadata, artist.full_name)) {
      return false;
    }

    const normalizedObjectHref = this.normalizeText(objectHref);
    if (!normalizedObjectHref || !this.objectHrefTargetsArtist(normalizedObjectHref, artist.full_name)) {
      if (!this.urlTargetsArtist(source.url, artist.full_name)) {
        return false;
      }
    }

    return this.isStrongArtworkAssetUrl(imageUrl);
  }

  private isQuotaOrVisionOutageReason(reason: string): boolean {
    const normalizedReason = this.normalizeText(reason);
    return (
      normalizedReason.includes('quota exceeded') ||
      normalizedReason.includes('rate limit') ||
      normalizedReason.includes('retry in') ||
      normalizedReason.includes('verification error') ||
      normalizedReason.includes('api key not valid')
    );
  }

  private metadataMatchesArtist(text: string, artistName: string): boolean {
    const normalizedArtist = this.normalizeText(artistName);
    if (!normalizedArtist) {
      return false;
    }

    if (text.includes(normalizedArtist)) {
      return true;
    }

    const tokens = normalizedArtist.split(' ').filter((token) => token.length >= 4);
    if (tokens.length === 0) {
      return false;
    }

    const surname = tokens[tokens.length - 1];
    const givenNames = tokens.slice(0, -1);

    return text.includes(surname) && givenNames.some((token) => text.includes(token));
  }

  private objectHrefTargetsArtist(normalizedObjectHref: string, artistName: string): boolean {
    const slug = this.normalizeText(artistName).replace(/\s+/g, '-');
    return normalizedObjectHref.includes(`/${slug}`) || normalizedObjectHref.includes(slug);
  }

  private urlTargetsArtist(url: string, artistName: string): boolean {
    return this.objectHrefTargetsArtist(this.normalizeText(url), artistName);
  }

  private isBlockedImageHost(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const blockedHosts = [
        'pictures.abebooks.com',
        'abebooks.com',
        'amazon.com',
        'amazon.com.br',
        'm.media-amazon.com',
        'books.google.com',
        'cdn.sistemawbuy.com.br',
        'sistemawbuy.com.br',
        'imaterial.art.br',
        'blogger.googleusercontent.com',
        'bp.blogspot.com',
        'blogspot.com',
        'pinterest.com',
        'pinimg.com',
      ];

      return blockedHosts.some((blockedHost) => hostname === blockedHost || hostname.endsWith(`.${blockedHost}`));
    } catch {
      return false;
    }
  }

  private isMarketArtworkHost(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return (
        hostname === 'www.escritoriodearte.com' ||
        hostname.endsWith('.escritoriodearte.com') ||
        hostname === 'dailyartfair.com' ||
        hostname.endsWith('.dailyartfair.com')
      );
    } catch {
      return false;
    }
  }

  private assetUrlStronglyTargetsArtist(url: string, artistContext: string): boolean {
    const normalizedUrl = this.normalizeText(url).replace(/[^a-z0-9]+/g, ' ');
    const normalizedArtist = this.normalizeText(artistContext).replace(/[^a-z0-9]+/g, ' ');
    const artistTokens = normalizedArtist.split(/\s+/).filter((token) => token.length >= 4);

    if (artistTokens.length === 0) {
      return false;
    }

    const surname = artistTokens[artistTokens.length - 1];
    const givenNames = artistTokens.slice(0, -1);

    if (!normalizedUrl.includes(surname)) {
      return false;
    }

    return givenNames.some((token) => normalizedUrl.includes(token));
  }

  private isStrongArtworkAssetUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();

      if (
        (hostname === 'www.escritoriodearte.com' || hostname.endsWith('.escritoriodearte.com')) &&
        pathname.includes('/quadro/') &&
        /\.(jpg|jpeg|png|webp)$/.test(pathname)
      ) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private buildArtworkKey(url: string, objectHref = '', label = ''): string {
    const normalizedUrl = this.normalizeImageUrl(url);

    try {
      const parsed = new URL(normalizedUrl);
      const hostname = parsed.hostname.toLowerCase();
      let pathname = parsed.pathname.toLowerCase();

      if (
        (hostname === 'www.escritoriodearte.com' || hostname.endsWith('.escritoriodearte.com')) &&
        pathname.includes('/quadro/')
      ) {
        pathname = pathname.replace(/([a-z0-9-]+?)[pg]\.(jpg|jpeg|png|webp)$/i, '$1.$2');
      }

      const urlKey = `url:${hostname}${pathname}`;

      if (objectHref) {
        try {
          const objectUrl = new URL(objectHref);
          const objectPath = objectUrl.pathname.toLowerCase();
          const isGenericListingPage =
            objectPath.includes('/artista/') ||
            objectPath.includes('/pessoas/') ||
            objectPath === '/' ||
            objectPath === '';

          if (!isGenericListingPage) {
            return `object:${objectUrl.toString().toLowerCase()}`;
          }
        } catch {
          // Ignore malformed object URL and keep URL-based key.
        }
      }

      return urlKey;
    } catch {
      const normalizedLabel = this.normalizeText(label).replace(/\s+/g, ' ').trim();
      return `label:${normalizedLabel || normalizedUrl.toLowerCase()}`;
    }
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  private extractImageCandidatesFromHtml(html: string, sourceUrl: string): DirectImageCandidate[] {
    const candidates: DirectImageCandidate[] = [];
    const seen = new Set<string>();
    const specializedCandidates = this.extractSourceSpecificCandidates(html, sourceUrl);

    for (const candidate of specializedCandidates) {
      const key = this.buildArtworkKey(candidate.url, candidate.objectHref, candidate.objectTitle || candidate.alt);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }

    const imgTagPattern = /<img\b[^>]*>/gi;

    for (const match of html.matchAll(imgTagPattern)) {
      const tag = match[0];
      const src = this.extractAttribute(tag, 'src') ?? this.extractAttribute(tag, 'data-src');
      if (!src) continue;

      const alt = this.extractAttribute(tag, 'alt') ?? '';
      const title = this.extractAttribute(tag, 'title') ?? '';
      const snippet = html.slice(
        Math.max(0, (match.index ?? 0) - 220),
        Math.min(html.length, (match.index ?? 0) + tag.length + 420)
      );
      const galleryTitle = this.extractSnippetValue(
        snippet,
        /data-testid="gallery-item-title"[^>]*>([^<]+)</i
      );
      const objectHref =
        this.extractSnippetValue(snippet, /<a[^>]+href="([^"]+)"/i) ??
        this.extractSnippetValue(snippet, /<a[^>]+href='([^']+)'/i) ??
        '';
      const context = [alt, title, galleryTitle, objectHref].filter(Boolean).join(' ');
      this.pushImageCandidate(
        candidates,
        seen,
        src,
        context,
        sourceUrl,
        alt,
        title,
        galleryTitle,
        objectHref
      );
    }

    const rawUrlPattern =
      /https?:\/\/[^"'()\s>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'()\s>]*)?/gi;
    for (const match of html.matchAll(rawUrlPattern)) {
      this.pushImageCandidate(candidates, seen, match[0], '', sourceUrl, '', '', '', '');
    }

    return candidates.slice(0, 12);
  }

  private extractSourceSpecificCandidates(html: string, sourceUrl: string): DirectImageCandidate[] {
    try {
      const hostname = new URL(sourceUrl).hostname.toLowerCase();

      if (hostname === 'dailyartfair.com' || hostname.endsWith('.dailyartfair.com')) {
        return this.extractDailyArtFairCandidates(html, sourceUrl);
      }
    } catch {
      // Ignore malformed source URL and fall back to generic extraction.
    }

    return [];
  }

  private extractDailyArtFairCandidates(html: string, sourceUrl: string): DirectImageCandidate[] {
    const candidates: DirectImageCandidate[] = [];
    const seen = new Set<string>();
    const blockPattern = /<div class="img-artwork"[\s\S]*?<\/div>\s*<!-- img-artworks -->/gi;

    for (const match of html.matchAll(blockPattern)) {
      const block = match[0];
      const imagePath =
        this.extractSnippetValue(block, /<img[^>]+class="thumb"[^>]+src="([^"]+)"/i) ||
        this.extractSnippetValue(block, /<img[^>]+class='thumb'[^>]+src='([^']+)'/i);
      if (!imagePath) continue;

      const title =
        this.extractSnippetValue(block, /<h4 class="titreoeuvre">([^<]+)<\/h4>/i) ||
        this.extractSnippetValue(block, /title="([^"]+)"/i);
      const medium = this.cleanHtml(this.extractSnippetValue(block, /<h6 class="teknic">([\s\S]*?)<\/h6>/i))
        .replace(/\s+/g, ' ')
        .trim();
      const alt =
        this.extractSnippetValue(block, /alt="([^"]+)"/i) ||
        this.extractSnippetValue(block, /title="([^"]+)"/i);
      const eventHref =
        this.extractSnippetValue(block, /<a href="([^"]+)" class="go_to_event"/i) ||
        sourceUrl;
      const gallery = this.extractSnippetValue(block, /<h4 class="artowork-gallery">([^<]+)<\/h4>/i);

      const absoluteImageUrl = this.normalizeImageUrl(new URL(imagePath, sourceUrl).toString());
      const objectTitle = title || alt;
      const context = [objectTitle, medium, gallery, eventHref].filter(Boolean).join(' ');
      const entry: DirectImageCandidate = {
        url: absoluteImageUrl,
        context,
        alt,
        title: objectTitle,
        objectTitle,
        objectHref: eventHref,
      };
      const key = this.buildArtworkKey(entry.url, entry.objectHref, entry.objectTitle || entry.alt);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(entry);
    }

    return candidates;
  }

  private pushImageCandidate(
    candidates: DirectImageCandidate[],
    seen: Set<string>,
    rawUrl: string,
    context: string,
    sourceUrl: string,
    alt: string,
    title: string,
    objectTitle: string,
    objectHref: string
  ): void {
    try {
      const absolute = this.normalizeImageUrl(new URL(rawUrl, sourceUrl).toString());
      const lower = absolute.toLowerCase();

      if (
        lower.includes('logo') ||
        lower.includes('icon') ||
        lower.includes('avatar') ||
        lower.includes('profile') ||
        lower.includes('thumb') ||
        lower.includes('banner') ||
        lower.includes('sprite')
      ) {
        return;
      }

      if (seen.has(absolute)) {
        return;
      }

      seen.add(absolute);
      candidates.push({ url: absolute, context, alt, title, objectTitle, objectHref });
    } catch {
      // Skip malformed URLs
    }
  }

  private normalizeImageUrl(url: string): string {
    try {
      const dailyArtFairLarge = url.match(
        /^https:\/\/dailyartfair\.com\/upload\/(?:small|medium)\/([^/?#]+\.(?:jpg|jpeg|png|webp))(?:\?.*)?$/i
      );
      if (dailyArtFairLarge?.[1]) {
        return `https://dailyartfair.com/upload/large/${dailyArtFairLarge[1]}`;
      }

      const escritoriodearteLarge = url.match(
        /^https:\/\/www\.escritoriodearte\.com\/quadro\/(.+?)p\.(jpg|jpeg|png|webp)(\?.*)?$/i
      );
      if (escritoriodearteLarge?.[1] && escritoriodearteLarge?.[2]) {
        return `https://www.escritoriodearte.com/quadro/${escritoriodearteLarge[1]}g.${escritoriodearteLarge[2]}`;
      }

      const wixMatch = url.match(
        /^https:\/\/static\.wixstatic\.com\/media\/([^/]+\.(?:jpg|jpeg|png|webp))(?:\/v1\/fill\/[^?]+)?(?:\?.*)?$/i
      );
      if (wixMatch?.[1]) {
        return `https://static.wixstatic.com/media/${wixMatch[1]}`;
      }

      return url;
    } catch {
      return url;
    }
  }

  private async expandCandidateFromObjectPage(
    candidate: DirectImageCandidate,
    sourceUrl: string
  ): Promise<DirectImageCandidate[]> {
    const expanded: DirectImageCandidate[] = [];
    const seen = new Set<string>();
    const pushUnique = (entry: DirectImageCandidate): void => {
      const entryKey = this.buildArtworkKey(entry.url, entry.objectHref, entry.objectTitle || entry.alt);
      if (seen.has(entryKey)) return;
      seen.add(entryKey);
      expanded.push(entry);
    };

    if (candidate.objectHref) {
      try {
        const objectUrl = new URL(candidate.objectHref, sourceUrl).toString();
        const response = await axios.get(objectUrl, {
          timeout: 15000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
        });

        const html = typeof response.data === 'string' ? response.data : '';
        if (html) {
          const pageTitle =
            this.extractMetaContent(html, 'property', 'og:title') ||
            this.extractMetaContent(html, 'name', 'twitter:title') ||
            candidate.objectTitle ||
            candidate.alt;

          const pageDescription =
            this.extractMetaContent(html, 'property', 'og:description') ||
            this.extractMetaContent(html, 'name', 'description') ||
            candidate.context;

          const ogImage =
            this.extractMetaContent(html, 'property', 'og:image') ||
            this.extractMetaContent(html, 'name', 'twitter:image');

          if (ogImage) {
            pushUnique({
              url: this.normalizeImageUrl(new URL(ogImage, objectUrl).toString()),
              context: `${candidate.context} ${pageTitle} ${pageDescription} ${objectUrl}`.trim(),
              alt: candidate.alt,
              title: candidate.title || pageTitle,
              objectTitle: candidate.objectTitle || pageTitle,
              objectHref: objectUrl,
            });
          }

          const pageCandidates = this.extractImageCandidatesFromHtml(html, objectUrl)
            .filter((entry) => !this.isLikelyUiAsset(entry.url))
            .slice(0, 6);

          for (const pageCandidate of pageCandidates) {
            pushUnique({
              ...pageCandidate,
              context: `${candidate.context} ${pageTitle} ${pageDescription} ${pageCandidate.context}`.trim(),
              objectTitle: pageCandidate.objectTitle || candidate.objectTitle || pageTitle,
              objectHref: objectUrl,
            });
          }
        }
      } catch {
        // Keep original candidate if object page cannot be fetched.
      }
    }

    pushUnique(candidate);
    return expanded;
  }

  private extractMetaContent(html: string, attrName: string, attrValue: string): string {
    const patterns = [
      new RegExp(`<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attrName}=["']${attrValue}["']`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    return '';
  }

  private isLikelyUiAsset(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes('logo') ||
      lower.includes('icon') ||
      lower.includes('avatar') ||
      lower.includes('profile') ||
      lower.includes('thumb') ||
      lower.includes('banner') ||
      lower.includes('sprite')
    );
  }

  private extractAttribute(tag: string, attribute: string): string | null {
    const quotedPattern = new RegExp(`${attribute}=["']([^"']+)["']`, 'i');
    const quotedMatch = tag.match(quotedPattern);
    if (quotedMatch?.[1]) {
      return quotedMatch[1];
    }

    const unquotedPattern = new RegExp(`${attribute}=([^\\s>]+)`, 'i');
    const unquotedMatch = tag.match(unquotedPattern);
    return unquotedMatch?.[1] ?? null;
  }

  private extractSnippetValue(snippet: string, pattern: RegExp): string {
    const match = snippet.match(pattern);
    return match?.[1]?.trim() ?? '';
  }

  /**
   * Verify an image belongs to the artist using Gemini vision.
   * Fail-safe: on error, rejects the image.
   */
  private async verifyImageWithClaude(
    imageUrl: string,
    artist: ArtistInfo
  ): Promise<{ verified: boolean; reason: string }> {
    if (this.isVisionTemporarilyUnavailable()) {
      return { verified: false, reason: 'Gemini vision temporarily unavailable due to quota' };
    }

    const cacheKey = this.buildVerificationCacheKey(imageUrl, artist);
    const cached = this.verificationCache.get(cacheKey);
    if (cached) {
      return {
        verified: cached.verified,
        reason: `${cached.reason} (cached)`,
      };
    }

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
      const photographyMode = this.isPhotographyPractice(artist);
      const criteriaText = photographyMode
        ? `Return JSON ONLY with keys:
{ "isArtwork": boolean, "isArtistPhoto": boolean, "hasPeople": boolean, "isInstallationView": boolean, "isDecorativeObject": boolean, "isDocumentaryPhoto": boolean, "isArtworkOnly": boolean, "confidence": number, "reason": string }
Rules:
1) PHOTOGRAPHIC ARTWORK: It must plausibly be a photographic artwork by "${artist.full_name}". Reject artist portraits, selfies, interviews, event photos, or installation views.
2) People are allowed ONLY if they appear as part of an intentional photographic artwork, not an artist portrait or event snapshot.
3) Must be one finished artwork, sharp and clear.
4) REJECT any image that contains large blocks of text, flyers, posters, captions, or promotional typography.
4) If unsure, set isArtwork=false and confidence<=0.5.`
        : `Return JSON ONLY with keys:
{ "isArtwork": boolean, "isArtistPhoto": boolean, "hasPeople": boolean, "isInstallationView": boolean, "isDecorativeObject": boolean, "isDocumentaryPhoto": boolean, "isArtworkOnly": boolean, "confidence": number, "reason": string }
Rules:
1) ARTWORK ONLY: Must be the artwork itself (painting/print/drawing/sculpture) — NOT a photo of the artist, NOT an exhibition/install view, NOT a framed piece on a wall, NOT a catalog page, NOT a mockup.
2) Reject if there are people, gallery spaces, display pedestals, or wide room context.
3) If it's a physical object, accept ONLY if it is clearly the artwork itself isolated on a neutral background (no people, no gallery context).
4) REJECT any image that contains large blocks of text, flyers, posters, captions, or promotional typography.
5) Must be one finished artwork, sharp and clear.
6) If unsure, set isArtwork=false and confidence<=0.5.`;

      const text = await this.gemini.generateTextFromImage({
        model: 'gemini-2.5-flash',
        maxOutputTokens: 200,
        temperature: 0,
        imageBase64: imageData.base64,
        mimeType: imageData.mediaType,
        responseMimeType: 'application/json',
        prompt: `Evaluate this image for use in an article about the artist "${artist.full_name}".${practiceInfo}${locationInfo}

${criteriaText}

Return JSON only, no extra text.`,
      });

      const parsed = this.safeParseVerificationJson(text);
      if (!parsed) {
        const normalized = text.trim().replace(/\s+/g, ' ');
        const result = {
          verified: false,
          reason: `Could not parse verification response: ${normalized.slice(0, 120)}`,
        };
        this.setVerificationCache(cacheKey, result);
        return result;
      }

      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
      const isArtwork = Boolean(parsed.isArtwork);
      const hasPeople = Boolean(parsed.hasPeople);
      const isArtistPhoto = Boolean(parsed.isArtistPhoto);
      const isInstallationView = Boolean(parsed.isInstallationView);
      const isDecorativeObject = Boolean(parsed.isDecorativeObject);
      const isDocumentaryPhoto = Boolean(parsed.isDocumentaryPhoto);
      const isArtworkOnly = Boolean(parsed.isArtworkOnly);
      const reasonText = this.normalizeText(parsed.reason ?? '');
      const reasonHasText = ['text', 'flyer', 'poster', 'cartaz', 'banner', 'typography', 'caption', 'promo'].some(
        (signal) => reasonText.includes(signal)
      );

      let allow = isArtwork && confidence >= 0.6;

      if (photographyMode) {
        if (isArtistPhoto || isInstallationView || isDecorativeObject) {
          allow = false;
        }
      } else {
        if (hasPeople || isArtistPhoto || isInstallationView || isDocumentaryPhoto) {
          allow = false;
        }
        if (isDecorativeObject && !isArtworkOnly) {
          allow = false;
        }
      }

      if (reasonHasText) {
        allow = false;
      }

      const result = {
        verified: allow,
        reason: parsed.reason || 'Gemini vision verification',
      };
      this.setVerificationCache(cacheKey, result);
      return result;
    } catch (error) {
      console.warn(`  Gemini vision verification failed for ${imageUrl}:`, error);
      this.noteVisionFailure(error);
      const result = { verified: false, reason: 'Verification error — rejected for safety' };
      this.setVerificationCache(cacheKey, result);
      return result;
    }
  }

  private safeParseVerificationJson(
    value: string
  ): null | {
    isArtwork?: boolean;
    isArtistPhoto?: boolean;
    hasPeople?: boolean;
    isInstallationView?: boolean;
    isDecorativeObject?: boolean;
    isDocumentaryPhoto?: boolean;
    isArtworkOnly?: boolean;
    confidence?: number;
    reason?: string;
  } {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private isVisionTemporarilyUnavailable(): boolean {
    return this.visionUnavailableUntil > Date.now();
  }

  private noteVisionFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = this.normalizeText(message);
    if (!normalized.includes('quota exceeded') && !normalized.includes('rate limit')) {
      return;
    }

    const retryMatch = message.match(/retry in\s+([0-9.]+)s/i);
    const retrySeconds = retryMatch ? Number.parseFloat(retryMatch[1]) : 60;
    const retryMs = Number.isFinite(retrySeconds) ? Math.ceil(retrySeconds * 1000) : 60_000;
    this.visionUnavailableUntil = Date.now() + Math.max(retryMs, 30_000);
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

      // Reject very small files (< 25KB — likely low-res, thumbnails, or icons)
      const buffer = Buffer.from(response.data);
      if (buffer.length < 25_000) {
        console.log(`  Skipped ${url} — file too small (${(buffer.length / 1024).toFixed(0)}KB, min 25KB)`);
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
    try {
      if (!fs.existsSync(this.imagesDir)) {
        fs.mkdirSync(this.imagesDir, { recursive: true });
      }
      const cacheDir = path.dirname(this.verificationCachePath);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
    } catch {
      // Ignore in serverless environments where filesystem is read-only
    }
  }

  private loadVerificationCache(): void {
    try {
      if (!fs.existsSync(this.verificationCachePath)) {
        return;
      }

      const raw = fs.readFileSync(this.verificationCachePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, VerificationCacheEntry>;
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value.verified !== 'boolean' || typeof value.reason !== 'string') {
          continue;
        }
        this.verificationCache.set(key, value);
      }
    } catch {
      // Ignore corrupt cache and keep going.
    }
  }

  private persistVerificationCache(): void {
    try {
      const payload = Object.fromEntries(this.verificationCache.entries());
      fs.writeFileSync(this.verificationCachePath, JSON.stringify(payload, null, 2));
    } catch {
      // Ignore cache persistence errors in serverless/read-only environments.
    }
  }

  private buildVerificationCacheKey(url: string, artist: ArtistInfo): string {
    return `${this.verificationSchemaVersion}::${this.normalizeText(url)}::${this.normalizeArtistPractice(artist)}`;
  }

  private setVerificationCache(
    key: string,
    result: { verified: boolean; reason: string }
  ): void {
    this.verificationCache.set(key, {
      verified: result.verified,
      reason: result.reason,
      cachedAt: new Date().toISOString(),
    });
    this.persistVerificationCache();
  }

  private isPhotographyPractice(artist: ArtistInfo): boolean {
    return this.normalizeArtistPractice(artist).includes('fot');
  }

  private normalizeArtistPractice(artist: ArtistInfo): string {
    return this.normalizeText(artist.visual_practice ?? '');
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
