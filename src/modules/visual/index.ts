/**
 * Visual Materials Module
 *
 * Sources and manages images for articles using a simpler pipeline:
 * 1. Exa-based commercial image scout
 * 2. Wikimedia Commons / Wikipedia image API
 * 3. Post-download resolution + context verification
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type { Image, Source, WikimediaImage } from '../../types/index.js';
import { GeminiClient } from '../../lib/gemini.js';
import { ScraperBridge } from '../scraper-bridge/index.js';
import { getConfig } from '../../config/index.js';
import { ExaClient } from '../discovery/exa-client.js';
import { assessSourceWithLibrarian, isDiamondDomain } from '../discovery/librarian.js';
import { forceHighResUrl, isHighResAuctionSource, isQuarantined, isUINoise, resolveHighResGuess } from './scavenger.js';
import { ExaImageScout } from './exa-image-scout.js';
import { GoogleScout } from './google-scout.js';
import { WikiScout } from './wiki-scout.js';

export interface VisualArtistInfo {
  full_name: string;
  visual_practice?: string;
  birth_year?: string;
  birthplace_city?: string;
  birthplace_state?: string;
  metadata?: string | null;
  artwork_candidates?: Array<{
    pageUrl: string;
    imageUrl?: string;
    title?: string;
    sourceDomain?: string;
    confidence?: number;
  }>;
}

type ArtistInfo = VisualArtistInfo;

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

interface DownloadedImageData {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  qualityWarning?: string;
  dimensions?: {
    width: number;
    height: number;
  };
}

const GALLERY_ELITE_DOMAINS = [
  'nararoesler.art',
  'almeidaedale.com.br',
  'gomide.art',
  'galeriaestacao.com.br',
  'leiloesbr.com.br',
  'catagano.com.br',
  'catalogodasartes.com.br',
  'leilaodearte.com',
  'ecarte.arrematearte.com.br',
  'tntarte.com.br',
  'masp.org.br',
  'museudeartemurilomendes.com.br',
  'commons.wikimedia.org',
  'upload.wikimedia.org',
];

const MANUAL_OVERRIDE_DOMAINS = [
  'sp-arte.com',
  'artesemfronteiras.com',
  'pimenta-rosa.substack.com',
  'nordestesse.com.br',
  'artsandculture.google.com',
  'bonifacio.net.br',
  'galeriamarcozero.com',
  'marcozero.plank.com.br',
  'instagram.com',
  'facebook.com',
];

export class VisualModule {
  private readonly imagesDir: string;
  private readonly verificationCachePath: string;
  private readonly verificationSchemaVersion = 'v3.4';
  private readonly scraperBridge: ScraperBridge;
  private readonly exaClient: ExaClient;
  private readonly gemini: GeminiClient;
  private readonly exaImageScout: ExaImageScout;
  private readonly googleScout: GoogleScout;
  private readonly wikiScout: WikiScout;
  private visionUnavailableUntil = 0;
  private verificationCache = new Map<string, VerificationCacheEntry>();

  constructor(geminiApiKey: string, imagesDir = './data/images') {
    this.imagesDir = imagesDir;
    this.verificationCachePath = path.join(path.dirname(imagesDir), 'image-verification-cache.json');
    this.scraperBridge = new ScraperBridge();
    this.exaClient = new ExaClient(getConfig().env.exaApiKey);
    this.gemini = new GeminiClient(geminiApiKey);
    this.exaImageScout = new ExaImageScout(this.exaClient);
    this.googleScout = new GoogleScout();
    this.wikiScout = new WikiScout();
    this.preserveLegacyHooksForOptionalFallbacks();
    this.ensureImagesDir();
    this.loadVerificationCache();
  }

  private preserveLegacyHooksForOptionalFallbacks(): void {
    void this.extractDirectSourceImages;
    void this.extractFromVerifiedSources;
    void this.collectInstitutionalBridgeCandidates;
    void this._buildSearchQuery;
  }

  async filterApprovalImages(
    artist: ArtistInfo,
    images: Image[],
    options: {
      skepticMode?: boolean;
      requireDiamondSources?: boolean;
      trustInstitutionalVerified?: boolean;
      allowGalleryProxy?: boolean;
    } = {}
  ): Promise<{ accepted: Image[]; rejected: Array<{ image: Image; reason: string }> }> {
    const accepted: Image[] = [];
    const rejected: Array<{ image: Image; reason: string }> = [];
    const forceExternalSources = this.getArtistMetadataFlag(artist, 'force_external_sources');
    const manualOverrideArtist = forceExternalSources;

    for (const image of images) {
      const isGalleryProxy = this.isGalleryProxyImage(image);
      const manualOverrideSourceRef = image.url || image.attribution || '';
      const isManualOverride = manualOverrideArtist && this.isManualOverrideSource(manualOverrideSourceRef);
      if (
        options.requireDiamondSources &&
        !this.isDiamondProvenanceImage(image) &&
        !(options.allowGalleryProxy && isGalleryProxy) &&
        !isManualOverride
      ) {
        rejected.push({ image, reason: 'Non-diamond provenance image rejected in skepticism mode' });
        continue;
      }
      if (isManualOverride) {
        accepted.push({
          ...image,
          caption: image.caption || `Artwork by ${artist.full_name}`,
          attribution: image.attribution,
          provenance_context:
            image.provenance_context ||
            `MANUAL_OVERRIDE: ${this.extractDomainLabel(image.attribution || image.url)}`,
        });
        continue;
      }
      if (
        options.trustInstitutionalVerified &&
        this.isInstitutionalVerifiedImage(image)
      ) {
        const institutionalCheck = await this.verifyInstitutionalImageForApproval(image.url, artist);
        if (institutionalCheck.verified) {
          accepted.push(image);
        } else {
          rejected.push({ image, reason: institutionalCheck.reason });
        }
        continue;
      }
      if (
        options.skepticMode &&
        options.requireDiamondSources &&
        this.isDiamondProvenanceImage(image) &&
        this.checkDomainAlignment(image.url, image.attribution ?? '')
      ) {
        accepted.push({
          ...image,
          caption: image.caption || `Artwork by ${artist.full_name}`,
          attribution: image.attribution,
          provenance_context:
            image.provenance_context ||
            `INSTITUTIONAL_VERIFIED: ${this.extractDomainLabel(image.attribution || image.url)}`,
        });
        continue;
      }
      const verification = await this.verifyImageWithClaude(image.url, artist, {
        skepticMode: options.skepticMode,
      });
      if (
        (verification.verified && !this.isNegativeVerificationReason(verification.reason)) ||
        this.shouldRecoverPositiveArtworkVerification(verification.reason)
      ) {
        accepted.push(image);
      } else {
        rejected.push({ image, reason: verification.reason });
      }
    }

    return { accepted, rejected };
  }

  async curateDraftImagesForReady(
    artist: ArtistInfo,
    images: Image[],
    options: { skepticMode?: boolean; requireDiamondSources?: boolean; allowGalleryProxy?: boolean } = {}
  ): Promise<{
    approved: Image[];
    rejected: Array<{ image: Image; reason: string }>;
    ready: boolean;
  }> {
    const filtered = await this.filterApprovalImages(artist, images, options);
    let approved = filtered.accepted.slice(0, 3);

    if (options.requireDiamondSources && options.allowGalleryProxy) {
      const diamondImages = filtered.accepted.filter((image) => this.isDiamondProvenanceImage(image));
      const galleryProxyImages = filtered.accepted.filter((image) => this.isGalleryProxyImage(image));
      approved = diamondImages.length > 0
        ? [...diamondImages.slice(0, 1), ...diamondImages.slice(1), ...galleryProxyImages].slice(0, 3)
        : galleryProxyImages.length >= 3
          ? galleryProxyImages.slice(0, 3)
          : [];
    }

    if (
      approved.length === 2 &&
      options.requireDiamondSources &&
      approved.every((image) => this.isDiamondProvenanceImage(image))
    ) {
      const relaxedThird = filtered.rejected.find((item) => this.isTriptychFallbackCandidate(item.image));
      if (relaxedThird) {
        approved = [...approved, relaxedThird.image].slice(0, 3);
      }
    }

    return {
      approved,
      rejected: filtered.rejected,
      ready: approved.length >= 3,
    };
  }

  /**
   * Source images for an artist using 3-layer verification pipeline.
   */
  async sourceImages(
    artist: ArtistInfo,
    _sources: Source[],
    _draftId: number,
    maxImages = 3
  ): Promise<Image[]> {
    console.log(`\n🖼️  Sourcing verified images for ${artist.full_name}...`);

    const images: Image[] = [];
    const selectedArtworkKeys = new Set<string>();

    // Layer 0: Use pre-mined artwork candidates already stored in the research cache.
    if (images.length < maxImages) {
      await this.extractFromResearchCacheCandidates(artist, images, maxImages, selectedArtworkKeys);
    }

    // Layer 1: Exa commercial visual scout.
    if (images.length < maxImages && !this.isVisionTemporarilyUnavailable()) {
      await this.searchExaVerified(artist, images, maxImages, selectedArtworkKeys);
    }

    // Layer 2: Google Custom Search image pool.
    if (images.length < maxImages && !this.isVisionTemporarilyUnavailable()) {
      await this.searchGoogleVerified(artist, images, maxImages, selectedArtworkKeys);
    }

    // Layer 3: Wikimedia Commons / Wikipedia images.
    if (images.length < maxImages && !this.isVisionTemporarilyUnavailable()) {
      await this.searchWikimediaVerified(artist, images, maxImages, selectedArtworkKeys);
    }

    console.log(`  ✓ Sourced ${images.length} verified images total`);
    return images;
  }

  async sourceInstitutionalFallbackImages(
    artist: ArtistInfo,
    maxImages = 3
  ): Promise<Image[]> {
    const images: Image[] = [];
    const selectedArtworkKeys = new Set<string>();
    const queries = [
      `${artist.full_name} site:itaucultural.org.br obra`,
      `${artist.full_name} site:enciclopedia.itaucultural.org.br obra`,
      `${artist.full_name} site:artsandculture.google.com artwork`,
      `${artist.full_name} site:google.com/culturalinstitute artwork`,
      `${artist.full_name} site:leiloesbr.com.br artwork "high resolution"`,
      `${artist.full_name} site:iam-pba.com.br artwork "high resolution"`,
    ];

    const searchCandidates = await this.collectParallelImagePoolCandidates(
      queries,
      Math.max(maxImages * 3, 9),
      artist,
      true
    );
    for (const img of searchCandidates) {
      if (images.length >= maxImages) break;
      const normalizedUrl = this.normalizeImageUrl(img.url);
      const artworkKey = this.buildArtworkKey(normalizedUrl, img.source_page, img.caption);
      if (selectedArtworkKeys.has(artworkKey)) continue;

      const prevalidated = await this.prevalidateSourceImage(
        normalizedUrl,
        `${normalizedUrl} ${img.caption ?? ''} ${img.source_page ?? ''}`,
        true,
        true,
        artist
      );
      if (!prevalidated.ok) {
        continue;
      }

      const verification = await this.verifyImageWithClaude(normalizedUrl, artist);
      if (verification.verified && !this.isNegativeVerificationReason(verification.reason)) {
        images.push({
          url: normalizedUrl,
          caption: img.caption || `Artwork by ${artist.full_name}`,
          attribution: img.source_page || img.source_domain || 'Institutional artwork source',
          provenance_context: this.checkDomainAlignment(normalizedUrl, img.source_page || img.url)
            ? `INSTITUTIONAL_VERIFIED: ${this.extractDomainLabel(img.source_page || img.url)}`
            : undefined,
        });
        selectedArtworkKeys.add(artworkKey);
      }
    }

    return images;
  }

  async sourceArtworkImagesFromDiscoveredPages(
    artist: ArtistInfo,
    sources: Source[],
    maxImages = 3
  ): Promise<Image[]> {
    const images: Image[] = [];
    const seen = new Set<string>();
    const forceHighResMode = this.getArtistMetadataFlag(artist, 'force_high_res_mode');

    for (const source of sources.slice(0, 3)) {
      const fetched = await this.scraperBridge.fetchPage(source.url, 5000);
      const artworkPages = await this.prioritizeInstitutionalCandidatePages([
        source.url,
        ...(fetched.discovered_urls ?? []),
      ]);

      for (const pageUrl of artworkPages) {
        if (images.length >= maxImages) {
          return images;
        }

        const extracted = await this.scraperBridge.extractImages(pageUrl, forceHighResMode ? 1200 : 300, 4);
        if (!extracted.success || extracted.images.length === 0) {
          continue;
        }

        for (const candidate of extracted.images) {
          if (images.length >= maxImages) {
            break;
          }

          const resolved = await resolveHighResGuess(candidate.url);
          const normalizedUrl = this.normalizeImageUrl(resolved.url);
          if (seen.has(normalizedUrl) || this.isBlockedImageHost(normalizedUrl)) {
            continue;
          }

          const image: Image = {
            url: normalizedUrl,
            caption: candidate.alt || `Artwork by ${artist.full_name}`,
            attribution: pageUrl,
            provenance_context: this.checkDomainAlignment(normalizedUrl, pageUrl)
              ? `INSTITUTIONAL_VERIFIED: ${this.extractDomainLabel(pageUrl)}`
              : undefined,
          };

          const prevalidated = await this.prevalidateSourceImage(
            normalizedUrl,
            `${candidate.alt ?? ''} ${pageUrl}`,
            true,
            true,
            artist,
            {
              minimumLongestSide: forceHighResMode ? 1200 : undefined,
            }
          );
          if (!prevalidated.ok) {
            continue;
          }

          const verification = await this.verifyImageWithClaude(normalizedUrl, artist);
          if (verification.verified && !this.isNegativeVerificationReason(verification.reason)) {
            images.push(image);
            seen.add(normalizedUrl);
          }
        }
      }
    }

    return images;
  }

  async scavengeMissingArtworkImages(
    artist: ArtistInfo,
    existingImages: Image[],
    missingSlots: number,
    options: { institutionalOnly?: boolean } = {}
  ): Promise<{
    approved: Image[];
    rejected: Array<{ image: Image; reason: string }>;
  }> {
    if (missingSlots <= 0) {
      return { approved: [], rejected: [] };
    }

    const approved: Image[] = [];
    const rejected: Array<{ image: Image; reason: string }> = [];
    const existingUrls = new Set(existingImages.map((image) => this.normalizeImageUrl(image.url)));
    const hasInstitutionalAnchor = existingImages.some((image) => this.isInstitutionalVerifiedImage(image));
    const diamondAmnestyEnabled =
      missingSlots <= 1 && (await this.hasTwoLargeApprovedImages(existingImages));
    const samicoGoogleArtsOnly = artist.full_name.trim().toLowerCase() === 'gilvan samico';
    const jotaWideNet = artist.full_name.trim().toLowerCase() === 'jota zer0ff';
    const forceExternalSources = this.getArtistMetadataFlag(artist, 'force_external_sources');
    const forceHighResMode = this.getArtistMetadataFlag(artist, 'force_high_res_mode');
    const auctionPriorityMode = forceHighResMode;
    const rawAssetsOnly = process.argv.includes('--raw-assets-only');
    const auctionResolutionFloor = 1500;
    const extraAuctionQueries = new Set<string>();
    const queries = rawAssetsOnly
      ? [
          this.buildBiographicArtworkQuery(artist, 'site:leiloesbr.com.br'),
          this.buildBiographicArtworkQuery(artist, 'site:artsy.net'),
          this.buildBiographicArtworkQuery(artist, 'site:sothebys.com'),
          this.buildBiographicArtworkQuery(artist, 'site:mutualart.com'),
          this.buildBiographicArtworkQuery(artist, 'site:artnet.com'),
          `"${artist.full_name}" painting site:leiloesbr.com.br "high resolution"`,
          `"${artist.full_name}" painting site:artsy.net "high resolution"`,
          `"${artist.full_name}" painting site:sothebys.com "high resolution"`,
          `"${artist.full_name}" painting site:mutualart.com "original size"`,
          `"${artist.full_name}" painting site:artnet.com "original size"`,
        ]
      : samicoGoogleArtsOnly
      ? [
          this.buildBiographicArtworkQuery(artist, 'site:artsandculture.google.com/asset'),
          this.buildBiographicArtworkQuery(artist, 'site:google.com/culturalinstitute'),
          `"${artist.full_name}" site:artsandculture.google.com/asset`,
          `"${artist.full_name}" site:google.com/culturalinstitute`,
          `"${artist.full_name}" woodcut site:artsandculture.google.com/asset`,
          `"${artist.full_name}" xilogravura site:artsandculture.google.com/asset`,
          `"${artist.full_name}" black and white woodcut site:artsandculture.google.com/asset`,
          `"${artist.full_name}" negative space woodcut site:artsandculture.google.com/asset`,
          `"${artist.full_name}" site:artsandculture.google.com/asset "A Espada e o Dragão"`,
          `"${artist.full_name}" site:artsandculture.google.com/asset "A Luta dos Anjos"`,
          `"${artist.full_name}" site:artsandculture.google.com/asset "A Fonte"`,
          `"${artist.full_name}" site:artsandculture.google.com/asset "A Mão"`,
        ]
      : [
          this.buildBiographicArtworkQuery(artist, 'site:leiloesbr.com.br'),
          this.buildBiographicArtworkQuery(artist, 'site:iam-pba.com.br'),
          this.buildBiographicArtworkQuery(artist, 'site:itaucultural.org.br/obra'),
          this.buildBiographicArtworkQuery(artist, 'site:artsandculture.google.com/asset'),
          this.buildBiographicArtworkQuery(artist, 'site:enciclopedia.itaucultural.org.br/obras'),
          this.buildBiographicArtworkQuery(artist, 'site:artsandculture.google.com/asset'),
          this.buildBiographicArtworkQuery(artist, 'site:google.com/culturalinstitute'),
          this.buildBiographicArtworkQuery(artist, 'site:itaucultural.org.br'),
          this.buildBiographicArtworkQuery(artist, 'site:itaucultural.org.br /obras'),
          this.buildBiographicArtworkQuery(artist, 'site:itaucultural.org.br /acervo'),
          this.buildBiographicArtworkQuery(artist, 'site:artsandculture.google.com /asset'),
          `"${artist.full_name}" site:artsandculture.google.com/asset`,
          `"${artist.full_name}" site:google.com/culturalinstitute`,
          `"Artwork by ${artist.full_name}" site:itaucultural.org.br`,
          `"Artwork by ${artist.full_name}" site:artsandculture.google.com`,
          `"${artist.full_name}" /obras site:itaucultural.org.br`,
          `"${artist.full_name}" /acervo site:itaucultural.org.br`,
          `"${artist.full_name}" /asset site:artsandculture.google.com`,
          `"${artist.full_name}" obra acervo site:itaucultural.org.br`,
          `"${artist.full_name}" obra acervo site:artsandculture.google.com`,
          `"${artist.full_name}" obra acervo site:google.com/culturalinstitute`,
          `"${artist.full_name}" site:leiloesbr.com.br "high resolution"`,
          `"${artist.full_name}" site:iam-pba.com.br "high resolution"`,
          `"${artist.full_name}" artwork museum archive`,
          `"${artist.full_name}" obra de arte`,
          `"${artist.full_name}" pintura`,
          `"${artist.full_name}" escultura`,
          `"${artist.full_name}" gravura`,
        ];

    const constrainedCandidates = await this.collectParallelImagePoolCandidates(
      queries,
      Math.max(missingSlots * 8, 12),
      artist,
      true
    );
    const unrestrictedCandidates: Array<{ url: string; caption: string; source_page: string; source_domain?: string }> = [];
    const galleryProxyQueries = hasInstitutionalAnchor
      ? GALLERY_ELITE_DOMAINS.flatMap((domain) => [
          this.buildBiographicArtworkQuery(artist, `site:${domain}`),
          `"${artist.full_name}" artwork site:${domain}`,
          `"${artist.full_name}" obra site:${domain}`,
        ])
      : [];
    const galleryProxyCandidates = hasInstitutionalAnchor
      ? await this.collectParallelImagePoolCandidates(
          galleryProxyQueries,
          Math.max(missingSlots * 8, 10),
          artist
        )
      : [];
    const exaHighResProxyCandidates = jotaWideNet
      ? await this.collectExaHighResProxyCandidates(
          [
            this.buildBiographicArtworkQuery(artist, 'site:sp-arte.com'),
            this.buildBiographicArtworkQuery(artist, 'site:artesemfronteiras.com'),
            this.buildBiographicArtworkQuery(artist, 'site:pimenta-rosa.substack.com'),
            this.buildBiographicArtworkQuery(artist, 'site:facebook.com/jotazer0ff'),
            this.buildBiographicArtworkQuery(artist, 'mural site:almeidaedale.com.br'),
            this.buildBiographicArtworkQuery(artist, 'street art site:artsy.net'),
            this.buildBiographicArtworkQuery(artist, '"wp-content/uploads/2024"'),
            this.buildBiographicArtworkQuery(artist, '"media/assets"'),
            `"${artist.full_name}" mural artwork Recife`,
            `"${artist.full_name}" mural artwork Maceió`,
            `"${artist.full_name}" street art painting`,
            `"${artist.full_name}" obra pintura mural`,
          ],
          Math.max(missingSlots * 8, 12),
          artist
        )
      : [];
    const allCandidates = [...constrainedCandidates, ...unrestrictedCandidates, ...galleryProxyCandidates, ...exaHighResProxyCandidates].filter(
      (candidate, index, list) =>
        list.findIndex((entry) => this.normalizeImageUrl(entry.url) === this.normalizeImageUrl(candidate.url)) === index
    );
    const auctionDirectCandidates = allCandidates.filter((candidate) =>
      isHighResAuctionSource(candidate.source_page || candidate.url)
    );
    const candidates =
      auctionPriorityMode && auctionDirectCandidates.length > 0
        ? auctionDirectCandidates
        : allCandidates;

    const buildAuctionTitleQueries = (title: string): string[] => {
      const cleanTitle = title
        .replace(/^artwork by\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleanTitle || cleanTitle.length < 4) {
        return [];
      }

      return [
        `"${artist.full_name}" "${cleanTitle}" "original size" site:leiloesbr.com.br`,
        `"${artist.full_name}" "${cleanTitle}" "original size" site:iam-pba.com.br`,
        `"${artist.full_name}" "${cleanTitle}" "high resolution" site:catagano.com.br`,
      ];
    };

    const isLowResFailureReason = (reason: string): boolean => {
      const normalized = reason.toLowerCase();
      return (
        normalized.includes('resolution too small') ||
        normalized.includes('file too small') ||
        normalized.includes('minimum 600px') ||
        normalized.includes('minimum 1200px') ||
        normalized.includes('quality warning') ||
        normalized.includes('low-res') ||
        normalized.includes('low resolution')
      );
    };

    const processCandidate = async (
      candidate: { url: string; caption: string; source_page: string; source_domain?: string }
    ): Promise<boolean> => {
      if (approved.length >= missingSlots) {
        return true;
      }

      const normalizedUrl = this.normalizeImageUrl(candidate.url);
      if (existingUrls.has(normalizedUrl)) {
        return false;
      }
      if (!jotaWideNet && (isQuarantined(normalizedUrl, artist.full_name) || isQuarantined(candidate.source_page || candidate.url, artist.full_name))) {
        rejected.push({ image: { url: normalizedUrl, caption: candidate.caption || '', attribution: candidate.source_page || '' }, reason: 'Quarantined source rejected for this artist' });
        return false;
      }
      if (isUINoise(normalizedUrl) || (!jotaWideNet && isUINoise(candidate.source_page || candidate.url))) {
        rejected.push({ image: { url: normalizedUrl, caption: candidate.caption || '', attribution: candidate.source_page || '' }, reason: 'UI noise asset rejected before curation' });
        return false;
      }

      const isGalleryProxyCandidate = hasInstitutionalAnchor && this.isGalleryEliteSource(candidate.source_page || candidate.url);
      const isJotaHighResProxy = jotaWideNet && !this.isInstitutionalSource(candidate.source_page || candidate.url);
      const isManualOverrideCandidate =
        forceExternalSources && jotaWideNet && this.isManualOverrideSource(candidate.source_page || candidate.url);
      const isAuctionDirectCandidate = isHighResAuctionSource(candidate.source_page || candidate.url);

      const image: Image = {
        url: normalizedUrl,
        caption: candidate.caption || `Artwork by ${artist.full_name}`,
        attribution: candidate.source_page || 'Institutional artwork source',
        provenance_context: this.checkDomainAlignment(
          normalizedUrl,
          candidate.source_page || candidate.url
        )
          ? `INSTITUTIONAL_VERIFIED: ${this.extractDomainLabel(candidate.source_page || candidate.url)}`
          : isManualOverrideCandidate
            ? `MANUAL_OVERRIDE: ${this.extractDomainLabel(candidate.source_page || candidate.url)}`
          : isGalleryProxyCandidate
            ? `GALLERY_PROXY: ${this.extractDomainLabel(candidate.source_page || candidate.url)}`
          : undefined,
      };

      if (
        options.institutionalOnly &&
        !jotaWideNet &&
        !isGalleryProxyCandidate &&
        !isAuctionDirectCandidate &&
        !this.isInstitutionalObjectPage(candidate.source_page || candidate.url)
      ) {
        rejected.push({ image, reason: 'Institutional scavenger candidate is not an object-level artwork page' });
        return false;
      }

      const prevalidated = await this.prevalidateSourceImage(
        normalizedUrl,
        `${candidate.caption ?? ''} ${candidate.source_page ?? ''} ${candidate.source_domain ?? ''}`,
        true,
        true,
        artist,
        {
          diamondAmnestyEnabled,
          minimumLongestSide: isAuctionDirectCandidate
            ? auctionResolutionFloor
            : isGalleryProxyCandidate
            ? 1200
            : isJotaHighResProxy
              ? 1200
            : samicoGoogleArtsOnly
              ? 1200
            : forceHighResMode
              ? 1200
            : approved.length === 0
              ? (options.institutionalOnly ? 800 : 1000)
              : undefined,
        }
      );
      if (!prevalidated.ok) {
        rejected.push({ image, reason: prevalidated.reason });
        if (
          auctionPriorityMode &&
          this.isInstitutionalSource(candidate.source_page || candidate.url) &&
          isLowResFailureReason(prevalidated.reason)
        ) {
          for (const query of buildAuctionTitleQueries(candidate.caption || image.caption || '')) {
            extraAuctionQueries.add(query);
          }
        }
        return false;
      }

      const verification = await this.verifyImageWithClaude(normalizedUrl, artist);
      if (verification.verified && !this.isNegativeVerificationReason(verification.reason)) {
        approved.push(image);
        existingUrls.add(normalizedUrl);
        return approved.length >= missingSlots;
      } else {
        rejected.push({ image, reason: verification.reason });
        return false;
      }
    };

    for (const candidate of candidates) {
      const done = await processCandidate(candidate);
      if (done) {
        break;
      }
    }

    if (approved.length < missingSlots && extraAuctionQueries.size > 0) {
      const auctionCandidates = await this.collectParallelImagePoolCandidates(
        [...extraAuctionQueries],
        Math.max(missingSlots * 10, 12),
        artist
      );

      for (const candidate of auctionCandidates) {
        const done = await processCandidate(candidate);
        if (done) {
          break;
        }
      }
    }

    return { approved, rejected };
  }

  private async extractFromResearchCacheCandidates(
    artist: ArtistInfo,
    images: Image[],
    maxImages: number,
    selectedArtworkKeys: Set<string>
  ): Promise<void> {
    const forceHighResMode = this.getArtistMetadataFlag(artist, 'force_high_res_mode');
    const candidates = (artist.artwork_candidates ?? [])
      .filter((candidate) => candidate.imageUrl)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, 8);

    if (candidates.length === 0) {
      return;
    }

    console.log(`  Trying ${candidates.length} pre-mined artwork candidate(s) from research cache`);

    for (const candidate of candidates) {
      if (images.length >= maxImages) {
        break;
      }

      const imageUrl = this.normalizeImageUrl(candidate.imageUrl!);
      const sourcePage = candidate.pageUrl || imageUrl;
      const artworkKey = this.buildArtworkKey(imageUrl, sourcePage, candidate.title ?? '');
      if (selectedArtworkKeys.has(artworkKey)) {
        continue;
      }

      if (this.isSocialSource(sourcePage, sourcePage) || this.isBlockedImageHost(imageUrl)) {
        continue;
      }

      const prevalidated = await this.prevalidateSourceImage(
        imageUrl,
        `${candidate.title ?? ''} ${sourcePage} ${candidate.sourceDomain ?? ''}`,
        true,
        true,
        artist,
        {
          minimumLongestSide: forceHighResMode ? 1200 : undefined,
        }
      );
      if (!prevalidated.ok) {
        console.log(`  ✗ Rejected research-cache candidate: ${prevalidated.reason}`);
        continue;
      }

      const verification = await this.verifyImageWithClaude(imageUrl, artist);
      if (!verification.verified || this.isNegativeVerificationReason(verification.reason)) {
        console.log(`  ✗ Rejected research-cache candidate: ${verification.reason}`);
        continue;
      }

      images.push({
        url: imageUrl,
        caption: candidate.title || `Artwork by ${artist.full_name}`,
        attribution: 'Artwork image.',
      });
      selectedArtworkKeys.add(artworkKey);
      console.log(`  ✓ Added research-cache artwork candidate: ${candidate.title || imageUrl}`);
    }
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
    const forceHighResMode = this.getArtistMetadataFlag(artist, 'force_high_res_mode');
    const sortedSources = [...sources].sort(
      (a, b) => (b.credibility_score ?? 0) - (a.credibility_score ?? 0)
    );

    for (const source of sortedSources) {
      if (images.length >= maxImages) break;
      if (this.isSocialSource(source.url, source.institution)) {
        console.log(`  Skipping social source for images: ${source.url}`);
        continue;
      }
      if (this.shouldSkipDirectExtractionForSource(source.url)) {
        console.log(`  Skipping noisy direct-source extraction for: ${source.url}`);
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

        const candidates = this.extractImageCandidatesFromHtml(html, source.url).slice(0, 24);
        let attemptsForSource = 0;
        let irrelevantForSource = 0;

        for (const candidate of candidates) {
          if (images.length >= maxImages) break;
          if (attemptsForSource >= 24 || irrelevantForSource >= 12) {
            console.log(
              `  Skipping remaining direct-source candidates from ${source.institution}: too many irrelevant matches`
            );
            break;
          }

          const resolvedCandidates = await this.expandCandidateFromObjectPage(candidate, source.url);

          for (const resolvedCandidate of resolvedCandidates) {
            if (images.length >= maxImages) break;
            if (attemptsForSource >= 24 || irrelevantForSource >= 12) {
              break;
            }

            attemptsForSource += 1;
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
              artist,
              {
                minimumLongestSide: forceHighResMode ? 1200 : undefined,
              }
            );
            if (!prevalidated.ok) {
              console.log(`  ✗ Rejected direct-source image from ${source.institution}: ${prevalidated.reason}`);
              continue;
            }

            if (
              this.isMarketArtworkHost(resolvedCandidate.url) &&
              !this.candidateStronglyTargetsArtist(
                resolvedCandidate.url,
                resolvedCandidate.objectHref,
                artist.full_name
              )
            ) {
              irrelevantForSource += 1;
              console.log(
                `  ✗ Rejected direct-source image from ${source.institution}: Asset URL does not strongly target ${artist.full_name}`
              );
              continue;
            }

            const quality = await this.verifyImageWithClaude(resolvedCandidate.url, artist);
            if (quality.verified && !this.isNegativeVerificationReason(quality.reason)) {
              images.push({
                url: resolvedCandidate.url,
                caption: chosenLabel || `Artwork by ${artist.full_name}`,
                attribution: `Source: ${source.institution}.`,
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
    const forceHighResMode = this.getArtistMetadataFlag(artist, 'force_high_res_mode');
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
      if (this.shouldSkipVerifiedExtractionForSource(source.url)) {
        console.log(`  Skipping noisy verified-source extraction for: ${source.url}`);
        continue;
      }

      try {
        console.log(`  Extracting images from ${source.institution}: ${source.url}`);
        const result = await this.scraperBridge.extractImages(source.url, forceHighResMode ? 1200 : 200, maxImages - images.length);

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
              artist,
              {
                minimumLongestSide: forceHighResMode ? 1200 : undefined,
              }
            );
            if (!prevalidated.ok) {
              console.log(`  ✗ Rejected from ${source.institution}: ${prevalidated.reason}`);
              continue;
            }

            if (
              this.isMarketArtworkHost(normalizedUrl) &&
              !this.candidateStronglyTargetsArtist(
                normalizedUrl,
                img.source_page,
                artist.full_name
              )
            ) {
              console.log(
                `  ✗ Rejected from ${source.institution}: Asset URL does not strongly target ${artist.full_name}`
              );
              continue;
            }

            // Even verified sources need quality check (could be banners/thumbnails)
            const quality = await this.verifyImageWithClaude(normalizedUrl, artist);
            if (quality.verified) {
              images.push({
                url: normalizedUrl,
                caption: img.alt || `Artwork by ${artist.full_name}`,
                attribution: `Source: ${source.institution}.`,
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
    const query = artist.full_name.trim();
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
          provenance_context: 'GALLERY_PROXY: commons.wikimedia.org',
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
          provenance_context: 'GALLERY_PROXY: commons.wikimedia.org',
        });
        selectedArtworkKeys.add(artworkKey);
        console.log(`  ✓ Wikimedia image verified: ${verification.reason}`);
      } else {
        console.log(`  ✗ Wikimedia image rejected: ${verification.reason}`);
      }
    }
  }

  private async searchExaVerified(
    artist: ArtistInfo,
    images: Image[],
    maxImages: number,
    selectedArtworkKeys: Set<string>
  ): Promise<void> {
    console.log(`  Searching Exa Images: "${artist.full_name}"`);
    const exaImages = await this.exaImageScout.searchArtworkImages(
      artist.full_name,
      (maxImages - images.length) * 4
    );
    console.log(`  Found ${exaImages.length} Exa image candidates`);

    for (const candidate of exaImages) {
      if (images.length >= maxImages) break;
      const artworkKey = this.buildArtworkKey(candidate.url, candidate.source_page, candidate.caption);
      if (selectedArtworkKeys.has(artworkKey)) continue;
      if (this.isSocialSource(candidate.source_page, candidate.source_page)) {
        continue;
      }
      const candidateUrls = candidate.is_page_candidate
        ? await this.expandExaPageCandidateUrls(candidate.url)
        : [candidate.url];

      for (const candidateUrl of candidateUrls) {
        if (images.length >= maxImages) break;
        if (this.isBlockedImageHost(candidateUrl)) {
          continue;
        }

        const prevalidated = await this.prevalidateSourceImage(
          candidateUrl,
          `${candidate.caption} ${candidate.source_page}`,
          true,
          true,
          artist,
          {
            minimumLongestSide: 450,
          }
        );
        if (!prevalidated.ok) {
          continue;
        }

        const verification = await this.verifyImageWithClaude(candidateUrl, artist);
        if (!verification.verified || this.isNegativeVerificationReason(verification.reason)) {
          continue;
        }

        images.push({
          url: this.normalizeImageUrl(candidateUrl),
          caption: candidate.caption || `Artwork by ${artist.full_name}`,
          attribution: candidate.source_page,
          provenance_context: this.checkDomainAlignment(candidateUrl, candidate.source_page)
            ? this.isDiamondImageSource(candidate.source_page, candidate.source_page)
              ? `INSTITUTIONAL_VERIFIED: ${this.extractDomainLabel(candidate.source_page)}`
              : this.isGalleryEliteSource(candidate.source_page)
                ? `GALLERY_PROXY: ${this.extractDomainLabel(candidate.source_page)}`
                : undefined
            : this.isGalleryEliteSource(candidate.source_page)
              ? `GALLERY_PROXY: ${this.extractDomainLabel(candidate.source_page)}`
              : undefined,
        });
        selectedArtworkKeys.add(artworkKey);
        console.log(`  ✓ Exa image verified: ${candidate.source_page}`);
        break;
      }
    }
  }

  private async expandExaPageCandidateUrls(pageUrl: string): Promise<string[]> {
    try {
      const extracted = await this.scraperBridge.extractImages(pageUrl, 450, 6);
      if (!extracted.success || extracted.images.length === 0) {
        return [];
      }
      return extracted.images
        .map((item) => this.normalizeImageUrl(item.url))
        .filter((value, index, list) => list.indexOf(value) === index);
    } catch {
      return [];
    }
  }

  private async searchGoogleVerified(
    artist: ArtistInfo,
    images: Image[],
    maxImages: number,
    selectedArtworkKeys: Set<string>
  ): Promise<void> {
    console.log(`  Searching Google Images: "${artist.full_name}"`);
    const googleImages = await this.googleScout.searchArtworkImages(
      artist.full_name,
      (maxImages - images.length) * 4
    );
    console.log(`  Found ${googleImages.length} Google image candidates`);

    for (const candidate of googleImages) {
      if (images.length >= maxImages) break;
      const artworkKey = this.buildArtworkKey(candidate.url, candidate.source_page, candidate.caption);
      if (selectedArtworkKeys.has(artworkKey)) continue;
      if (this.isSocialSource(candidate.source_page, candidate.source_page) || this.isBlockedImageHost(candidate.url)) {
        continue;
      }

      const prevalidated = await this.prevalidateSourceImage(
        candidate.url,
        `${candidate.caption} ${candidate.source_page}`,
        true,
        true,
        artist,
        {
          minimumLongestSide: 450,
        }
      );
      if (!prevalidated.ok) {
        continue;
      }

      const verification = await this.verifyImageWithClaude(candidate.url, artist);
      if (!verification.verified || this.isNegativeVerificationReason(verification.reason)) {
        continue;
      }

      images.push({
        url: this.normalizeImageUrl(candidate.url),
        caption: candidate.caption || `Artwork by ${artist.full_name}`,
        attribution: candidate.source_page,
        provenance_context: this.isGalleryEliteSource(candidate.source_page)
          ? `GALLERY_PROXY: ${this.extractDomainLabel(candidate.source_page)}`
          : undefined,
      });
      selectedArtworkKeys.add(artworkKey);
      console.log(`  ✓ Google image verified: ${candidate.source_page}`);
    }
  }

  private async collectParallelImagePoolCandidates(
    queries: string[],
    desiredLimit: number,
    artist: ArtistInfo,
    institutionalOnly = false
  ): Promise<Array<{ url: string; caption: string; source_page: string; source_domain?: string }>> {
    const merged: Array<{ url: string; caption: string; source_page: string; source_domain?: string }> = [];
    const seen = new Set<string>();
    const rawCandidates = await this.collectExaImageScoutCandidates(queries, artist, desiredLimit);

    for (const candidate of rawCandidates) {
      if (
        institutionalOnly &&
        !this.isInstitutionalSource(candidate.source_page || candidate.url) &&
        !isHighResAuctionSource(candidate.source_page || candidate.url)
      ) {
        continue;
      }
      if (isQuarantined(candidate.url, artist.full_name) || isQuarantined(candidate.source_page || candidate.url, artist.full_name)) {
        continue;
      }
      const key = this.buildArtworkKey(candidate.url, candidate.source_page, candidate.caption);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(candidate);
    }

    return merged
      .sort((a, b) => this.scoreWebCandidate(b, artist) - this.scoreWebCandidate(a, artist))
      .slice(0, Math.min(desiredLimit, 16));
  }

  private async collectExaImageScoutCandidates(
    _queries: string[],
    artist: ArtistInfo,
    desiredLimit: number
  ): Promise<Array<{ url: string; caption: string; source_page: string; source_domain?: string }>> {
    const candidates: Array<{ url: string; caption: string; source_page: string; source_domain?: string }> = [];
    const seen = new Set<string>();

    const exaResults = await this.exaImageScout.searchArtworkImages(artist.full_name, Math.min(desiredLimit, 12));
    for (const candidate of exaResults) {
        const key = this.buildArtworkKey(candidate.url, candidate.source_page, candidate.caption);
        if (seen.has(key) || isUINoise(candidate.url) || isUINoise(candidate.source_page)) {
          continue;
        }
        seen.add(key);
        candidates.push({
          url: this.normalizeImageUrl(candidate.url),
          caption: candidate.caption,
          source_page: candidate.source_page,
          source_domain: candidate.source_domain,
        });
      if (candidates.length >= desiredLimit) {
        return candidates;
      }
    }

    return candidates;
  }

  private async collectExaHighResProxyCandidates(
    queries: string[],
    desiredLimit: number,
    artist: ArtistInfo
  ): Promise<Array<{ url: string; caption: string; source_page: string; source_domain?: string }>> {
    const candidates: Array<{ url: string; caption: string; source_page: string; source_domain?: string }> = [];
    const seenPages = new Set<string>();
    const forceExternalSources = this.getArtistMetadataFlag(artist, 'force_external_sources');
    const manualOverrideArtist = forceExternalSources && artist.full_name.trim().toLowerCase() === 'jota zer0ff';

    for (const query of queries.slice(0, 4)) {
      try {
        const response = await this.exaClient.search({
          query,
          maxResults: 6,
          excludeDomains: [
            'pinterest.com',
            'amazon.com',
            'amazon.com.br',
            'mercadolivre.com.br',
            'shopee.com.br',
            ...(manualOverrideArtist ? [] : ['instagram.com', 'facebook.com']),
          ],
        });

        for (const result of response.results) {
          if (seenPages.has(result.url)) {
            continue;
          }
          if (isUINoise(result.url) || (!manualOverrideArtist && this.isInstitutionalNoise(result.url))) {
            continue;
          }
          const prioritizedAssetDirectory =
            /wp-content\/uploads\/2024|media\/assets/i.test(result.url) ||
            /wp-content\/uploads\/2024|media\/assets/i.test(`${result.title ?? ''} ${result.content ?? ''}`);
          seenPages.add(result.url);

          const extracted = await this.scraperBridge.extractImages(result.url, 1200, 4);
          if (!extracted.success || extracted.images.length === 0) {
            continue;
          }

          for (const image of extracted.images) {
            const resolved = await resolveHighResGuess(image.url);
            const normalizedUrl = this.normalizeImageUrl(resolved.url);
            if (isUINoise(normalizedUrl)) {
              continue;
            }
            const fakeCandidate = {
              url: normalizedUrl,
              caption: image.alt || result.title || 'Artwork image',
              source_page: result.url,
              source_domain: (() => {
                try {
                  return new URL(result.url).hostname.replace(/^www\./, '');
                } catch {
                  return undefined;
                }
              })(),
            };
            if (!prioritizedAssetDirectory && this.scoreWebCandidate(fakeCandidate, artist) < 10) {
              continue;
            }
            candidates.push(fakeCandidate);
            if (candidates.length >= desiredLimit) {
              return candidates;
            }
          }
        }
      } catch (error) {
        console.warn(`  Exa high-res proxy search failed for "${query}":`, error);
      }
    }

    return candidates;
  }

  private async collectBridgeImageCandidates(
    queries: string[],
    desiredLimit: number,
    institutionalOnly = false,
    minImageSize = 300
  ): Promise<Array<{ url: string; caption: string; source_page: string; source_domain?: string }>> {
    const candidates: Array<{ url: string; caption: string; source_page: string; source_domain?: string }> = [];
    const seenPages = new Set<string>();
    const seenImages = new Set<string>();

    for (const query of queries.slice(0, 3)) {
      try {
        const response = await this.exaClient.search({
          query,
          maxResults: 4,
          category: 'news',
          excludeDomains: [
            'pinterest.com',
            'instagram.com',
            'facebook.com',
            'amazon.com',
            'amazon.com.br',
            'mercadolivre.com.br',
            'shopee.com.br',
          ],
        });

        const pageJobs = response.results
          .filter((result) => {
            if (seenPages.has(result.url)) return false;
            if (!this.isAllowedInstitutionalCandidatePage(result.url)) return false;
            if (isUINoise(result.url)) return false;
            const librarian = assessSourceWithLibrarian(result.url, getConfig(), result.score ?? 0);
            if (librarian.blocked || (librarian.priority === 'low' && !isHighResAuctionSource(result.url))) return false;
            if (institutionalOnly && !(librarian.priority === 'high' || this.isInstitutionalSource(result.url))) {
              return false;
            }
            seenPages.add(result.url);
            return true;
          })
          .slice(0, 3)
          .map(async (result) => {
            const fetched = await this.scraperBridge.fetchPage(result.url, 5000);
            const pages = await this.prioritizeInstitutionalCandidatePages([
              result.url,
              ...(fetched.discovered_urls ?? []),
            ]);

            const extracted = await Promise.allSettled(
              pages.map((pageUrl) => this.scraperBridge.extractImages(pageUrl, minImageSize, 5))
            );

            for (const extraction of extracted) {
              if (extraction.status !== 'fulfilled' || !extraction.value.success) {
                continue;
              }
              for (const image of extraction.value.images) {
                const resolved = await resolveHighResGuess(image.url);
                const normalizedUrl = this.normalizeImageUrl(resolved.url);
                if (
                  seenImages.has(normalizedUrl) ||
                  this.isBlockedImageHost(normalizedUrl) ||
                  isUINoise(normalizedUrl) ||
                  isUINoise(image.source_page || result.url)
                ) {
                  continue;
                }
                seenImages.add(normalizedUrl);
                candidates.push({
                  url: normalizedUrl,
                  caption: image.alt || result.title || 'Artwork image',
                  source_page: image.source_page || result.url,
                  source_domain: (() => {
                    try {
                      return new URL(image.source_page || result.url).hostname.replace(/^www\./, '');
                    } catch {
                      return undefined;
                    }
                  })(),
                });
                if (candidates.length >= desiredLimit) {
                  return;
                }
              }
            }
          });

        await Promise.allSettled(pageJobs);
        if (candidates.length >= desiredLimit) {
          break;
        }
      } catch (error) {
        console.warn(`  Bridge image-page search failed for "${query}":`, error);
      }
    }

    return candidates;
  }

  private async collectInstitutionalBridgeCandidates(
    queries: string[],
    desiredLimit: number,
    minImageSize = 300
  ): Promise<Array<{ url: string; caption: string; source_page: string; source_domain?: string }>> {
    const institutionalQueries = queries.flatMap((query) => [
      `${query} site:leiloesbr.com.br`,
      `${query} site:iam-pba.com.br`,
      `${query} site:itaucultural.org.br/obra`,
      `${query} site:enciclopedia.itaucultural.org.br/obras`,
      `${query} site:artsandculture.google.com/asset`,
      `${query} site:enciclopedia.itaucultural.org.br`,
      `${query} site:itaucultural.org.br`,
      `${query} site:artsandculture.google.com`,
      `${query} site:google.com/culturalinstitute`,
    ]);

    return this.collectBridgeImageCandidates(
      institutionalQueries.filter((value, index, list) => list.indexOf(value) === index),
      desiredLimit,
      true,
      minImageSize
    );
  }

  private buildBiographicArtworkQuery(artist: ArtistInfo, siteFilter: string): string {
    const parts = [`"${artist.full_name}"`];
    if (artist.birth_year?.trim()) {
      parts.push(`"${artist.birth_year.trim()}"`);
    }
    if (artist.birthplace_city?.trim()) {
      parts.push(`"${artist.birthplace_city.trim()}"`);
    } else if (artist.birthplace_state?.trim()) {
      parts.push(`"${artist.birthplace_state.trim()}"`);
    }
    parts.push(siteFilter);
    parts.push('"high resolution"');
    parts.push('"original size"');
    parts.push('"2000px"');
    return parts.join(' ');
  }

  private isInstitutionalNoise(url: string): boolean {
    const normalized = url.toLowerCase();
    const blockedFragments = [
      '/faq',
      '/equipe',
      '/staff',
      '/about',
      '/quem-somos',
      '/educador',
      '/educativo',
      '/agenda',
      '/noticias',
      '/contato',
      '/login',
      '/imprensa',
      '/associe-se',
      '/acesso-a-informacao',
      '/ouvidoria',
      '/editais',
      '/espaco-do-educador',
    ];
    return blockedFragments.some((fragment) => normalized.includes(fragment));
  }

  private hasInventoryMarkers(html: string): boolean {
    const normalized = this.normalizeText(html);
    return ['tecnica', 'dimensoes', 'n de inventario', 'numero de inventario', 'colecao', 'acervo']
      .some((marker) => normalized.includes(marker));
  }

  private async prioritizeInstitutionalCandidatePages(urls: string[]): Promise<string[]> {
    const unique = urls
      .filter(Boolean)
      .filter((url, index, list) => list.indexOf(url) === index)
      .filter((url) => !this.isInstitutionalNoise(url) && this.isAllowedInstitutionalCandidatePage(url));

    const scored = await Promise.all(
      unique.slice(0, 8).map(async (url) => {
        let inventoryBoost = 0;
        try {
          const fetched = await this.scraperBridge.fetchPage(url, 1500);
          if (fetched.success && fetched.content && this.hasInventoryMarkers(fetched.content)) {
            inventoryBoost = 10;
          }
        } catch {
          // Ignore fetch failures during prioritization.
        }

        return {
          url,
          score:
            (this.isInstitutionalObjectPage(url) ? 20 : 0) +
            inventoryBoost +
            (/\/(obra|obras|acervo|asset|colecao|colecoes)\b/i.test(url) ? 6 : 0),
        };
      })
    );

    return scored
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.url)
      .slice(0, 6);
  }

  private isInstitutionalSource(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return (
        hostname.includes('itaucultural.org.br') ||
        hostname === 'pinacoteca.org.br' ||
        hostname.endsWith('.pinacoteca.org.br') ||
        hostname.endsWith('.gov.br') ||
        hostname.endsWith('.org.br') ||
        hostname === 'artsandculture.google.com' ||
        hostname === 'google.com'
      );
    } catch {
      return false;
    }
  }

  private isAllowedInstitutionalCandidatePage(url: string): boolean {
    const normalized = url.toLowerCase();
    const blockedFragments = [
      '/faq',
      '/equipe',
      '/staff',
      '/about',
      '/contato',
      '/entrevista',
      '/login',
      '/imprensa',
      '/quem-somos',
      '/educador',
      '/educativo',
      '/espaco-do-educador',
      '/agenda',
      '/noticias',
      '/associe-se',
      '/acesso-a-informacao',
      '/ouvidoria',
      '/editais',
    ];
    if (blockedFragments.some((fragment) => normalized.includes(fragment))) {
      return false;
    }

    if (
      normalized.includes('enciclopedia.itaucultural.org.br') ||
      normalized.includes('itaucultural.org.br') ||
      normalized.includes('artsandculture.google.com') ||
      normalized.includes('google.com/culturalinstitute') ||
      normalized.includes('.gov.br') ||
      normalized.includes('.org.br')
    ) {
      return (
        normalized.includes('/obra') ||
        normalized.includes('/obras') ||
        normalized.includes('/acervo') ||
        normalized.includes('/colecao') ||
        normalized.includes('/colecoes') ||
        normalized.includes('/asset/') ||
        normalized.includes('/pessoas/') ||
        normalized.includes('/pessoa')
      );
    }

    return true;
  }

  private scoreWebCandidate(
    candidate: { url: string; caption: string; source_page: string },
    artist: ArtistInfo
  ): number {
    const artBaselArtworkPage = this.isArtBaselArtworkPage(candidate.url, candidate.source_page);
    const oculaArtworkPage = this.isOculaArtworkPage(candidate.url, candidate.source_page);
    const normalized = this.normalizeText(
      `${candidate.url} ${candidate.caption} ${candidate.source_page}`
    );
    const normalizedForSignals = artBaselArtworkPage
      ? normalized.replace(/catalog/g, 'artworkpage')
      : normalized;
    let score = 0;

    if (!this.isSocialSource(candidate.source_page, candidate.source_page)) score += 4;
    if (this.webCandidateTargetsArtist(candidate, artist)) score += 4;
    if (this.isTrustedArtworkWebHost(candidate.url, candidate.source_page)) score += 5;
    if (this.isVisualAidsAsset(candidate.url, candidate.source_page)) score += 3;
    if (artBaselArtworkPage) score += 6;
    if (oculaArtworkPage) score += 4;
    if (this.containsArtworkSignals(normalizedForSignals)) score += 3;
    if (this.isPhotographyPractice(artist)) score += 1;
    if (
      !artBaselArtworkPage &&
      !this.isPhotographyPractice(artist) &&
      this.looksLikeNonArtworkPhotoScene(normalizedForSignals)
    ) {
      score -= 8;
    }
    if (this.containsNonArtworkSignals(normalizedForSignals, this.isPhotographyPractice(artist))) score -= 6;

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
    const artBaselArtworkPage = this.isArtBaselArtworkPage(candidate.url, candidate.source_page ?? candidate.url);
    const oculaArtworkPage = this.isOculaArtworkPage(candidate.url, candidate.source_page ?? candidate.url);
    const visualAidsAsset = this.isVisualAidsAsset(candidate.url, candidate.source_page ?? candidate.url);
    const normalized = this.normalizeText(
      `${candidate.url} ${candidate.caption ?? ''} ${candidate.source_page ?? ''} ${candidate.description ?? ''}`
    );
    const normalizedForSignals = artBaselArtworkPage
      ? normalized.replace(/catalog/g, 'artworkpage')
      : normalized;

    if (this.isSocialSource(candidate.source_page ?? '', candidate.source_page ?? '')) {
      return false;
    }

    if (this.isBlockedImageHost(candidate.url)) {
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

    if (this.containsNonArtworkSignals(normalizedForSignals, this.isPhotographyPractice(artist))) {
      return false;
    }

    if (
      !artBaselArtworkPage &&
      !this.isPhotographyPractice(artist) &&
      this.looksLikeNonArtworkPhotoScene(normalizedForSignals)
    ) {
      return false;
    }

    const trustedArtworkHost = this.isTrustedArtworkWebHost(candidate.url, candidate.source_page ?? candidate.url);
    if (!trustedArtworkHost) {
      return false;
    }

    const strongArtworkContext =
      this.containsArtworkSignals(normalizedForSignals) ||
      visualAidsAsset ||
      artBaselArtworkPage ||
      oculaArtworkPage ||
      normalized.includes('art basel');

    if (!strongArtworkContext) {
      return false;
    }

    return this.scoreWebCandidate(
      {
        url: candidate.url,
        caption: candidate.caption ?? candidate.description ?? '',
        source_page: candidate.source_page ?? candidate.url,
      },
      artist
    ) >= 10;
  }

  private isTrustedArtworkWebHost(url: string, sourcePage = ''): boolean {
    const values = [url, sourcePage].filter(Boolean);
    const trustedHosts = [
      'artbasel.com',
      'visualaids.org',
      'artsandculture.google.com',
      'ocula.com',
      'leiloesbr.com.br',
      'iam-pba.com.br',
      'enciclopedia.itaucultural.org.br',
      'itaucultural.org.br',
      'masp.org.br',
      'pinacoteca.org.br',
      'escritoriodearte.com',
      'dailyartfair.com',
      'mutualart.com',
      'inhotim.org.br',
      'museudeartedorio.org.br',
      'mam.org.br',
      'mamba.org.br',
      'museuafrobrasil.org.br',
    ];

    for (const value of values) {
      try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        if (
          hostname === 'storage.googleapis.com' &&
          pathname.includes('/visualaids-artists/artists/')
        ) {
          return true;
        }

        if (
          hostname === 'dza2a2ql7zktf.cloudfront.net' &&
          pathname.includes('/image/fetch/')
        ) {
          return true;
        }

        if (trustedHosts.some((trustedHost) => hostname === trustedHost || hostname.endsWith(`.${trustedHost}`))) {
          return true;
        }
      } catch {
        // Ignore malformed values.
      }
    }

    return false;
  }

  private isVisualAidsAsset(url: string, sourcePage = ''): boolean {
    const values = [url, sourcePage].filter(Boolean);

    for (const value of values) {
      try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        if (hostname === 'visualaids.org' || hostname.endsWith('.visualaids.org')) {
          return true;
        }

        if (
          hostname === 'storage.googleapis.com' &&
          pathname.includes('/visualaids-artists/artists/')
        ) {
          return true;
        }
      } catch {
        // Ignore malformed values.
      }
    }

    return false;
  }

  private isArtBaselArtworkPage(url: string, sourcePage = ''): boolean {
    const values = [url, sourcePage].filter(Boolean);

    for (const value of values) {
      try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        if (
          (hostname === 'www.artbasel.com' || hostname.endsWith('.artbasel.com')) &&
          pathname.includes('/catalog/artwork/')
        ) {
          return true;
        }
      } catch {
        // Ignore malformed values.
      }
    }

    return false;
  }

  private isOculaArtworkPage(url: string, sourcePage = ''): boolean {
    const values = [url, sourcePage].filter(Boolean);

    for (const value of values) {
      try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        if (
          (hostname === 'ocula.com' || hostname.endsWith('.ocula.com')) &&
          pathname.includes('/artworks/')
        ) {
          return true;
        }
      } catch {
        // Ignore malformed values.
      }
    }

    return false;
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
    artist?: ArtistInfo,
    options: { diamondAmnestyEnabled?: boolean; minimumLongestSide?: number } = {}
  ): Promise<{ ok: boolean; reason: string }> {
    const normalizedContext = this.normalizeText(`${url} ${contextText}`);

    if (artist) {
      const mediumMismatchReason = this.detectPracticeMismatch(artist, normalizedContext);
      if (mediumMismatchReason) {
        return { ok: false, reason: mediumMismatchReason };
      }
    }

    if (this.isStrongArtworkAssetUrl(url)) {
      if (
        artist &&
        this.isMarketArtworkHost(url) &&
        !this.metadataMatchesArtist(normalizedContext, artist.full_name)
      ) {
        return { ok: false, reason: 'Strong artwork asset lacks convincing artist ownership context' };
      }

      const imageData = await this.downloadImageAsBase64(url, {
        allowDiamondWarning: this.isDiamondImageSource(url, contextText),
        minDiamondShortSide: options.diamondAmnestyEnabled ? 350 : 400,
        minLongestSide: options.minimumLongestSide,
      });
      if (!imageData) {
        return { ok: false, reason: 'Could not download image for validation' };
      }

      if (imageData.qualityWarning) {
        return { ok: false, reason: imageData.qualityWarning };
      }

      return { ok: true, reason: 'Proceeding based on strong artwork asset URL' };
    }

    if (this.isBlockedImageHost(url)) {
      return { ok: false, reason: 'Image host is too risky for approval emails' };
    }

    const imageData = await this.downloadImageAsBase64(url, {
      allowDiamondWarning: this.isDiamondImageSource(url, contextText),
      minDiamondShortSide: options.diamondAmnestyEnabled ? 350 : 400,
      minLongestSide: options.minimumLongestSide,
    });
    if (!imageData) {
      return { ok: false, reason: 'Could not download image for validation' };
    }

    if (imageData.qualityWarning) {
      return { ok: false, reason: imageData.qualityWarning };
    }

    const artBaselArtworkPage =
      this.isArtBaselArtworkPage(url, contextText) ||
      normalizedContext.includes('artbasel.com/catalog/artwork');
    const normalizedContextForSignals = artBaselArtworkPage
      ? normalizedContext.replace(/catalog/g, 'artworkpage')
      : normalizedContext;

    if (this.containsNonArtworkSignals(normalizedContextForSignals, false)) {
      return { ok: false, reason: 'Context suggests portrait, author photo, or book cover instead of artwork' };
    }

    if (
      artist &&
      !artBaselArtworkPage &&
      !this.isPhotographyPractice(artist) &&
      this.looksLikeNonArtworkPhotoScene(normalizedContextForSignals)
    ) {
      return { ok: false, reason: 'Context suggests a landscape or documentary photograph, not the artist artwork' };
    }

    if (requireArtworkSignal && !this.containsArtworkSignals(normalizedContextForSignals)) {
      if (allowSourceContextFallback) {
        return { ok: true, reason: 'Proceeding to visual verification based on trusted source context' };
      }
      return { ok: false, reason: 'No strong artwork signal found in caption or source context' };
    }

    return { ok: true, reason: 'Image passed direct-source validation' };
  }

  private isDiamondImageSource(url: string, contextText = ''): boolean {
    if (isDiamondDomain(url)) {
      return true;
    }

    const urls = contextText.match(/https?:\/\/\S+/g) ?? [];
    return urls.some((value) => isDiamondDomain(value));
  }

  private isDiamondProvenanceImage(image: Image): boolean {
    return this.isDiamondImageSource(image.url, `${image.attribution ?? ''} ${image.caption ?? ''}`);
  }

  private isInstitutionalVerifiedImage(image: Image): boolean {
    return (image.provenance_context ?? '').startsWith('INSTITUTIONAL_VERIFIED:');
  }

  private isGalleryProxyImage(image: Image): boolean {
    return (image.provenance_context ?? '').startsWith('GALLERY_PROXY:');
  }

  private checkDomainAlignment(imageUrl: string, sourceUrl: string): boolean {
    try {
      const imageDomain = new URL(imageUrl).hostname.replace(/^www\./, '').toLowerCase();
      const sourceDomain = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
      return (
        imageDomain === sourceDomain ||
        imageDomain.endsWith(`.${sourceDomain}`) ||
        sourceDomain.endsWith(`.${imageDomain}`)
      );
    } catch {
      return false;
    }
  }

  private extractDomainLabel(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return url;
    }
  }

  private isGalleryEliteSource(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return GALLERY_ELITE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  }

  private isManualOverrideSource(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return MANUAL_OVERRIDE_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  }

  private getArtistMetadataFlag(artist: ArtistInfo, key: string): boolean {
    const artistWithMetadata = artist as ArtistInfo & { metadata?: string };
    const raw = artistWithMetadata.metadata;
    if (!raw) {
      return false;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed[key] === true;
    } catch {
      return false;
    }
  }

  private isTriptychFallbackCandidate(image: Image): boolean {
    const provenanceText = `${image.url} ${image.caption ?? ''} ${image.attribution ?? ''}`.toLowerCase();
    return (
      this.isDiamondProvenanceImage(image) ||
      provenanceText.includes('gallery') ||
      provenanceText.includes('almeida') ||
      provenanceText.includes('dale') ||
      provenanceText.includes('pinacoteca')
    );
  }

  private async verifyInstitutionalImageForApproval(
    imageUrl: string,
    artist: ArtistInfo
  ): Promise<{ verified: boolean; reason: string }> {
    if (this.isVisionTemporarilyUnavailable()) {
      return { verified: false, reason: 'Gemini vision temporarily unavailable due to quota' };
    }

    try {
      const imageData = await this.downloadImageAsBase64(imageUrl);
      if (!imageData) {
        return { verified: false, reason: 'Could not download image for verification' };
      }

      const practiceInfo = artist.visual_practice ? ` Artist practice: ${artist.visual_practice}.` : '';
      const text = await this.gemini.generateTextFromImage({
        model: 'gemini-2.5-flash',
        maxOutputTokens: 220,
        temperature: 0,
        thinkingBudget: 0,
        imageBase64: imageData.base64,
        mimeType: imageData.mediaType,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['isAcceptable', 'containsPortrait', 'containsTextOverlay', 'isLowQuality', 'reason'],
          properties: {
            isAcceptable: { type: 'boolean' },
            containsPortrait: { type: 'boolean' },
            containsTextOverlay: { type: 'boolean' },
            isLowQuality: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
        prompt: `This image is already institutionally verified for ownership. Do not guess who owns the work.${practiceInfo}

Only validate:
1) image quality is publication-grade,
2) it is not a portrait of the artist or a documentary/event photo,
3) it is visually consistent with the artist practice.

Return JSON only.`,
      });

      const parsed = JSON.parse(text) as {
        isAcceptable?: boolean;
        containsPortrait?: boolean;
        containsTextOverlay?: boolean;
        isLowQuality?: boolean;
        reason?: string;
      };

      const verified =
        parsed.isAcceptable === true &&
        parsed.containsPortrait !== true &&
        parsed.containsTextOverlay !== true &&
        parsed.isLowQuality !== true;
      return {
        verified,
        reason: parsed.reason?.trim() || 'Institutional provenance verification',
      };
    } catch (error) {
      this.noteVisionFailure(error);
      return { verified: false, reason: 'Institutional verification failed for safety' };
    }
  }

  private detectPracticeMismatch(artist: ArtistInfo, normalizedContext: string): string | null {
    const normalizedPractice = this.normalizeText(artist.visual_practice ?? '');
    if (!normalizedPractice || !normalizedContext) {
      return null;
    }

    const mentionsPainting =
      normalizedContext.includes(' oleo ') ||
      normalizedContext.includes(' oil on canvas ') ||
      normalizedContext.includes(' acrylic ') ||
      normalizedContext.includes(' pintura ') ||
      normalizedContext.includes(' painting ') ||
      normalizedContext.includes(' tela ');
    const mentionsSculpture =
      normalizedContext.includes(' escultura ') ||
      normalizedContext.includes(' sculpture ') ||
      normalizedContext.includes(' carved wood ') ||
      normalizedContext.includes(' madeira ') ||
      normalizedContext.includes(' madeira policromada ') ||
      normalizedContext.includes(' wood sculpture ') ||
      normalizedContext.includes(' ceramica ') ||
      normalizedContext.includes(' ceramic ');
    const mentionsPhotography =
      normalizedContext.includes(' fotografia ') ||
      normalizedContext.includes(' photography ') ||
      normalizedContext.includes(' photo ') ||
      normalizedContext.includes(' photograph ');

    if (
      (normalizedPractice.includes('escultura') || normalizedPractice.includes('ceramica')) &&
      mentionsPainting &&
      !mentionsSculpture
    ) {
      return `Artist practice is "${artist.visual_practice}", but candidate context points to painting rather than sculpture or ceramic work`;
    }

    if (normalizedPractice.includes('pintura') && mentionsSculpture && !mentionsPainting) {
      return `Artist practice is "${artist.visual_practice}", but candidate context points to sculpture or object photography rather than painting`;
    }

    if (
      normalizedPractice.includes('fotografia') &&
      (mentionsPainting || mentionsSculpture) &&
      !mentionsPhotography
    ) {
      return `Artist practice is "${artist.visual_practice}", but candidate context points to another medium`;
    }

    return null;
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
      'table',
      'desk',
      'on table',
      'on a table',
      'on tabletop',
      'resting on table',
      'laid on table',
      'display table',
      'wooden table',
      'mesa',
      'sobre mesa',
      'em cima da mesa',
      'sobre uma mesa',
      'produto em mesa',
      'capa',
      'cover',
      'catalog',
      'catalogue',
      'concept art',
      'digital art',
      'game art',
      'fantasy art',
      'environment art',
      'character design',
      'render',
      'cgi',
      '3d art',
      '3d render',
      'matte painting',
      'speedpaint',
      'fan art',
      'ai art',
      'midjourney',
      'krea',
      'artstation',
      'deviantart',
      'behance',
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
      'table',
      'desk',
      'tabletop',
      'on table',
      'on a table',
      'wooden table',
      'mesa',
      'sobre mesa',
      'em cima da mesa',
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
    const hasSpecificObjectLink =
      normalizedHref.length > 0 &&
      !normalizedHref.includes('/pessoas/') &&
      !normalizedHref.includes('/artista/') &&
      !normalizedHref.endsWith('/');

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

      const untitledButSpecificWork =
        hasSpecificObjectLink &&
        (normalizedLabel === 'sem titulo' ||
          normalizedLabel === 'untitled' ||
          normalizedLabel.startsWith('sem titulo ') ||
          normalizedLabel.startsWith('untitled '));

      const looksGeneric = blockedGenericLabels.some(
        (blocked) => normalizedLabel === blocked || normalizedLabel.startsWith(`${blocked} `)
      );

      if ((untitledButSpecificWork || !looksGeneric) && !this.containsNonArtworkSignals(normalizedLabel)) {
        return true;
      }
    }

    return (
      cleanedLabel.length >= 8 &&
      hasSpecificObjectLink &&
      this.containsArtworkSignals(normalizedContext) &&
      !this.containsNonArtworkSignals(normalizedContext)
    );
  }

  private isNegativeVerificationReason(reason: string): boolean {
    const normalizedReason = this.normalizeText(reason);
    const signatureOnlyText = this.isLikelyArtworkSignatureText(normalizedReason);
    if (signatureOnlyText && this.reasonSuggestsStandaloneArtwork(normalizedReason)) {
      return false;
    }

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
      'tabletop',
      'on a table',
      'on table',
      'desk',
      'mesa',
      'sobre mesa',
      'em cima da mesa',
      'product page',
      'product shot',
      'decor item',
      'display table',
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
    ];

    return negativeSignals.some((signal) => normalizedReason.includes(signal));
  }

  private reasonSuggestsVisibleTextOverlay(reasonText: string): boolean {
    if (!reasonText) {
      return false;
    }

    const explicitSafeSignals = [
      'no text overlay',
      'without text overlay',
      'no visible text',
      'without visible text',
      'contains no text',
      'no promotional text',
      'without promotional text',
    ];

    if (explicitSafeSignals.some((signal) => reasonText.includes(signal))) {
      return false;
    }

    const explicitTextSignals = [
      'text overlay',
      'contains text',
      'visible text',
      'promotional graphic',
      'promotional text',
      'poster',
      'flyer',
      'cartaz',
      'banner',
      'caption over',
      'logo',
      'typography',
      'watermark',
    ];

    return explicitTextSignals.some((signal) => reasonText.includes(signal));
  }

  private reasonSuggestsStandaloneArtwork(reasonText: string): boolean {
    if (!reasonText) {
      return false;
    }

    const positiveSignals = [
      'depiction of an artwork',
      'artwork only',
      'artwork-only',
      'isolated on a neutral background',
      'no people',
      'no gallery context',
      'suitable for an article',
      'high-resolution depiction',
      'clear high-resolution depiction',
      'clear, high-resolution photograph of a painting',
      'clear high-resolution photograph of a painting',
      'clear high-resolution photograph of a drawing',
      'clear high-resolution image of a painting',
      'clear high-resolution image of a drawing',
      'finished artwork',
      'painting',
      'drawing',
      'sculpture',
      'print',
      'woodcut',
      'engraving',
      'photograph of an artwork',
    ];

    return positiveSignals.some((signal) => reasonText.includes(signal));
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

    if (tokens.length === 1) {
      const token = tokens[0];
      return token.length >= 6 && text.includes(token);
    }

    const surname = tokens[tokens.length - 1];
    const givenNames = tokens.slice(0, -1);

    return text.includes(surname) && givenNames.some((token) => text.includes(token));
  }

  private objectHrefTargetsArtist(normalizedObjectHref: string, artistName: string): boolean {
    const slug = this.normalizeText(artistName).replace(/\s+/g, '-');
    return normalizedObjectHref.includes(`/${slug}`) || normalizedObjectHref.includes(slug);
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

  private shouldSkipDirectExtractionForSource(sourceUrl: string): boolean {
    const normalized = sourceUrl.toLowerCase();

    if (
      normalized.includes('enciclopedia.itaucultural.org.br') &&
      !normalized.includes('/obras/') &&
      !normalized.includes('/obra/')
    ) {
      return true;
    }

    return false;
  }

  private shouldSkipVerifiedExtractionForSource(sourceUrl: string): boolean {
    const normalized = sourceUrl.toLowerCase();

    if (
      normalized.includes('enciclopedia.itaucultural.org.br') &&
      !normalized.includes('/obras/') &&
      !normalized.includes('/obra/')
    ) {
      return true;
    }

    return false;
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

  private candidateStronglyTargetsArtist(
    imageUrl: string,
    objectHref: string,
    artistContext: string
  ): boolean {
    const normalizedObjectHref = this.normalizeText(objectHref);

    if (
      this.isStrongArtworkAssetUrl(imageUrl) &&
      (
        this.objectHrefTargetsArtist(normalizedObjectHref, artistContext)
      )
    ) {
      return true;
    }

    return (
      this.assetUrlStronglyTargetsArtist(imageUrl, artistContext) ||
      this.objectHrefTargetsArtist(normalizedObjectHref, artistContext)
    );
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

      if (hostname === 'www.escritoriodearte.com' || hostname.endsWith('.escritoriodearte.com')) {
        return this.extractEscritorioDeArteCandidates(html, sourceUrl);
      }

      if (hostname === 'dailyartfair.com' || hostname.endsWith('.dailyartfair.com')) {
        return this.extractDailyArtFairCandidates(html, sourceUrl);
      }
    } catch {
      // Ignore malformed source URL and fall back to generic extraction.
    }

    return [];
  }

  private extractEscritorioDeArteCandidates(html: string, sourceUrl: string): DirectImageCandidate[] {
    const candidates: DirectImageCandidate[] = [];
    const seen = new Set<string>();
    const listingMatches = Array.from(
      html.matchAll(
        /<div class="lista_quadros">[\s\S]*?<a href="(?<href>\/(?:en\/)?artista\/[^"]+\/[^"]*-\d+)"><img src="(?<img>\/quadro\/[^"]+)"[^>]*alt="(?<alt>[^"]+)"/gi
      )
    );

    for (const match of listingMatches) {
      const relativeHref = match.groups?.href?.trim();
      const relativeImg = match.groups?.img?.trim();
      const alt = match.groups?.alt?.trim() ?? 'Artwork';
      if (!relativeHref || !relativeImg) continue;

      const objectHref = new URL(relativeHref, sourceUrl).toString();
      const imageUrl = this.normalizeImageUrl(new URL(relativeImg, sourceUrl).toString());
      const objectTitle = alt;
      const context = `${alt} ${objectHref}`;
      const entry: DirectImageCandidate = {
        url: imageUrl,
        context,
        alt,
        title: alt,
        objectTitle,
        objectHref,
      };
      const key = this.buildArtworkKey(entry.url, entry.objectHref, entry.objectTitle || entry.alt);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(entry);
    }

    return candidates;
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
      const cleaned = forceHighResUrl(url);

      const dailyArtFairLarge = cleaned.match(
        /^https:\/\/dailyartfair\.com\/upload\/(?:small|medium)\/([^/?#]+\.(?:jpg|jpeg|png|webp))(?:\?.*)?$/i
      );
      if (dailyArtFairLarge?.[1]) {
        return `https://dailyartfair.com/upload/large/${dailyArtFairLarge[1]}`;
      }

      const escritoriodearteLarge = cleaned.match(
        /^https:\/\/www\.escritoriodearte\.com\/quadro\/(.+?)p\.(jpg|jpeg|png|webp)(\?.*)?$/i
      );
      if (escritoriodearteLarge?.[1] && escritoriodearteLarge?.[2]) {
        return `https://www.escritoriodearte.com/quadro/${escritoriodearteLarge[1]}g.${escritoriodearteLarge[2]}`;
      }

      const wixMatch = cleaned.match(
        /^https:\/\/static\.wixstatic\.com\/media\/([^/]+\.(?:jpg|jpeg|png|webp))(?:\/v1\/fill\/[^?]+)?(?:\?.*)?$/i
      );
      if (wixMatch?.[1]) {
        return `https://static.wixstatic.com/media/${wixMatch[1]}`;
      }

      const visualAidsOriginal = cleaned.match(
        /^https:\/\/storage\.googleapis\.com\/visualaids-artists\/artists\/([^/]+)\/_medium\/([^/?#]+\.(?:jpg|jpeg|png|webp))(?:\?.*)?$/i
      );
      if (visualAidsOriginal?.[1] && visualAidsOriginal?.[2]) {
        return `https://storage.googleapis.com/visualaids-artists/artists/${visualAidsOriginal[1]}/${visualAidsOriginal[2]}`;
      }

      if (cleaned.includes('dza2a2ql7zktf.cloudfront.net') && cleaned.includes('/image/fetch/')) {
        return cleaned.replace(/q_auto,w_\d+\//i, 'q_auto,w_1600/');
      }

      return cleaned;
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

          for (const resolvedImageUrl of this.extractDeepAssetUrlsFromObjectHtml(html, objectUrl, candidate.url)) {
            pushUnique({
              url: resolvedImageUrl,
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

    if (!this.isLikelyThumbnailAsset(candidate.url)) {
      pushUnique(candidate);
    }
    return expanded;
  }

  private extractDeepAssetUrlsFromObjectHtml(html: string, objectUrl: string, candidateUrl: string): string[] {
    const urls = new Set<string>();
    const hostname = (() => {
      try {
        return new URL(objectUrl).hostname.replace(/^www\./, '').toLowerCase();
      } catch {
        return '';
      }
    })();

    const pushUrl = (rawUrl: string | null | undefined): void => {
      if (!rawUrl) return;
      try {
        const normalized = this.normalizeImageUrl(new URL(rawUrl, objectUrl).toString());
        if (this.isLikelyUiAsset(normalized) || this.isLikelyThumbnailAsset(normalized)) {
          return;
        }
        urls.add(normalized);
      } catch {
        // ignore malformed asset
      }
    };

    if (hostname.includes('artsandculture.google.com')) {
      const googleMatches = html.match(/https:\\\/\\\/lh3\.googleusercontent\.com\\\/ci\\\/[^"']+(?:\\u003ds\d+)?/gi) ?? [];
      for (const match of googleMatches) {
        pushUrl(match.replace(/\\u003d/g, '=').replace(/\\\//g, '/'));
      }
    }

    if (hostname.includes('itaucultural.org.br')) {
      const itauMatches = html.match(/https:\/\/midias-publicas\.enciclopedia\.itaucultural\.org\.br\/[^"'\\s<)]+/gi) ?? [];
      for (const match of itauMatches) {
        pushUrl(match);
      }

      const hrefMatches = html.match(/href=["'](\/obras\/[^"']+)["']/gi) ?? [];
      for (const href of hrefMatches) {
        const relative = href.match(/href=["']([^"']+)["']/i)?.[1];
        if (!relative) continue;
        pushUrl(relative);
      }
    }

    if (urls.size === 0 && !this.isLikelyThumbnailAsset(candidateUrl)) {
      pushUrl(candidateUrl);
    }

    return [...urls];
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

  private isLikelyThumbnailAsset(url: string): boolean {
    const lower = url.toLowerCase();
    const filename = lower.split('/').pop() ?? lower;
    return (
      lower.includes('/thumbnail') ||
      lower.includes('/thumbnails/') ||
      lower.includes('thumb') ||
      lower.includes('small') ||
      lower.includes('icon') ||
      filename.includes('thumbnail') ||
      filename.includes('thumb') ||
      filename.includes('small') ||
      filename.includes('icon')
    );
  }

  private isInstitutionalObjectPage(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
      const pathname = parsed.pathname.toLowerCase();
      if (hostname.includes('artsandculture.google.com')) {
        return pathname.includes('/asset/');
      }
      if (hostname.includes('itaucultural.org.br')) {
        return pathname.includes('/obras/') || pathname.includes('/acervo');
      }
      if (hostname.endsWith('.org.br') || hostname.endsWith('.gov.br')) {
        return pathname.includes('/obra') || pathname.includes('/obras') || pathname.includes('/acervo') || pathname.includes('/asset/');
      }
      return false;
    } catch {
      return false;
    }
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
    artist: ArtistInfo,
    options: { skepticMode?: boolean } = {}
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
      const amnestyMode = this.getArtistMetadataFlag(artist, 'vision_amnesty_mode');
      const responseJsonSchema = {
        type: 'object',
        additionalProperties: false,
        required: [
          'isArtwork',
          'isArtistPhoto',
          'hasPeople',
          'isInstallationView',
          'isDecorativeObject',
          'isDocumentaryPhoto',
          'isArtworkOnly',
          'containsTextOverlay',
          'isLowQuality',
          'confidence',
          'reason',
        ],
        properties: {
          isArtwork: { type: 'boolean' },
          isArtistPhoto: { type: 'boolean' },
          hasPeople: { type: 'boolean' },
          isInstallationView: { type: 'boolean' },
          isDecorativeObject: { type: 'boolean' },
          isDocumentaryPhoto: { type: 'boolean' },
          isArtworkOnly: { type: 'boolean' },
          containsTextOverlay: { type: 'boolean' },
          isLowQuality: { type: 'boolean' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
      };
      const skepticismPrefix = options.skepticMode
        ? `You are an expert art curator. REJECT any image unless you are at least 95% certain it belongs to ${artist.full_name}. Look for institutional provenance, watermarks, collection context, and stylistic consistency. Better to have zero images than one wrong image.`
        : '';
      const amnestyModeRule = amnestyMode
        ? `TEMPORARY AMNESTY MODE FOR FORCE-DISPATCH:
- Lower the context-purity threshold to 80% confidence for this run.
- If the image is high-resolution and clearly shows the artwork, you may PASS even when a slight frame edge or minor display residue remains.
- Still REJECT real people, hands, tools, studio walls, event context, street context, or heavy environmental contamination.
- Prefer sendable artwork purity over museum-perfect purity for this emergency validation run.`
        : '';
      const samicoWoodcutMode = artist.full_name.trim().toLowerCase() === 'gilvan samico'
        ? `SPECIAL MODE FOR GILVAN SAMICO: Analyze this woodcut for extreme high contrast and masterful negative space. REJECT if the image is a low-resolution scan, shows visible paper texture, yellowing, glare, moire patterns, muddy grays, or any loss of the digital purity of the black-and-white line. Prefer crisp, high-resolution reproductions that preserve the structural leg of the carved line.`
        : '';
      const jotaMuralMode = artist.full_name.trim().toLowerCase() === 'jota zer0ff'
        ? `SPECIAL MODE FOR JOTA ZER0FF: Prioritize vibrant palettes, crisp mural edges, and clean digital composition. Focus on the structural weight of the lines (the leg), mural textures, and high-contrast color fields. REJECT washed-out documentation photos, muddy smartphone captures, tilted street snapshots, images where the wall texture overwhelms the painted line, or any image containing Wix UI elements, site chrome, or news banners. Prefer images where the anatomy of the streets reads clearly through the structural leg of the mural line.`
        : '';
      const studioOnlyRule = `PURE CONTEXT INVARIANT (STEP 0 - GOOGLE LENS STYLE CHECK):
- REJECT immediately if any real person is visible, including the artist, visitors, staff, or reflections.
- REJECT immediately if artist hands, tools, easels, studio furniture, hanging systems, wall labels, pedestals, event context, street context, environmental background, or any room depth are visible.
- REJECT immediately if the work is photographed at an angle, in perspective, on a wall, on concrete, or inside any installation/display context.
- ACCEPT ONLY when the image behaves like a pure artwork crop: frontal, orthogonal, isolated, and visually flat.
- ACCEPT ONLY if the work itself fills the frame or sits in pure negative space with no environmental contamination.

STUDIO-ONLY INVARIANT:
- ACCEPT ONLY flat studio pieces: frontal canvas works, works on paper, engravings, prints, or other flat pieces shown head-on with clean edges.
- ACCEPT ONLY when the edge of the canvas/paper is clearly visible OR the artwork occupies the full frame with zero environmental depth.
- REJECT if the image shows a wall, concrete texture, street context, environmental background, room context, angled perspective, installation context, or any applied/mural work.
- REJECT if the photograph documents the artwork in situ instead of isolating the artwork itself.
- REJECT yellowed scans, muddy contrast, glare, or photography that weakens the negative space.
- Prefer high-contrast compositions, clean negative space, and minimal visual noise consistent with the Casca Archive editorial system.`;
      const mediumCheckRule = `MEDIUM CHECK (RUN BEFORE CONTEXT CHECK):
- REJECT immediately if the image has high text density, reads like a book page, catalog spread, poem, flyer, newspaper clipping, document scan, or any literary/editorial page.
- REJECT immediately if the image looks like a manuscript, printed page, cover design, poster, or text-first artifact instead of a visual artwork.
- ACCEPT ONLY if the medium reads as oil on canvas, acrylic, print, engraving, drawing, or another 2D visual artwork shown orthographically.
- If the image is ambiguous between artwork and document, reject it.`;
      const styleMatchRule = `SIGNATURE AND STYLE MATCH:
- Compare the visual language to the known practice of "${artist.full_name}".
- REJECT if the image metadata, visible text, watermark, or surrounding context mentions another artist name such as Portinari, Aldemir Martins, or any different author.
- REJECT if the work reads as a sketch, study, draft on paper, notebook page, or preparatory drawing when the artist is primarily being sourced here as a painter of finished frontal works.
- REJECT if the image style clearly belongs to another artist or medium family than ${artist.visual_practice ?? 'the expected practice for this artist'}.
- If the image is hosted on a Diamond domain such as Google Arts & Culture, Itaú Cultural, or another museum/collection source, and the brushwork, palette, themes, and compositional structure strongly match the researched profile of "${artist.full_name}", you are authorized to grant a HIGH CONFIDENCE PASS even if no visible signature appears in the crop.
- If the image is hosted on another gallery, museum, or collection domain and the style strongly matches the researched profile of "${artist.full_name}", you may PASS ownership on stylistic confidence even if no visible signature appears in the crop.
- When uncertain about attribution or style match, reject.`;
      const clovisNaifMode = artist.full_name.trim().toLowerCase() === 'clovis júnior' || artist.full_name.trim().toLowerCase() === 'clovis junior'
        ? `SPECIAL MODE FOR CLOVIS JÚNIOR: Prioritize the strongest high-contrast and symmetrical compositions. Look for a naïf-contemporary hybrid language with festive but structurally firm figures. Favor clean frontal works whose rigid figure balance supports the Casca minimal aesthetic.`
        : '';

      const criteriaText = photographyMode
        ? `Return JSON ONLY with keys:
{ "isArtwork": boolean, "isArtistPhoto": boolean, "hasPeople": boolean, "isInstallationView": boolean, "isDecorativeObject": boolean, "isDocumentaryPhoto": boolean, "isArtworkOnly": boolean, "containsTextOverlay": boolean, "isLowQuality": boolean, "confidence": number, "reason": string }
Rules:
0) ${studioOnlyRule}
0.05) ${mediumCheckRule}
0.1) ${styleMatchRule}
1) STRICT CURATION: Decide whether this image is strictly a piece of artwork suitable for editorial publication. If it is a portrait of a person, an event photo, a gallery photo, an installation view, or a text-heavy image, it must be rejected.
2) PHOTOGRAPHIC ARTWORK: It must plausibly be a photographic artwork by "${artist.full_name}". Reject artist portraits, selfies, interviews, event photos, or installation views.
3) People are allowed ONLY if they appear as part of an intentional photographic artwork, not an artist portrait or event snapshot.
4) Must be one finished artwork, sharp and clear.
5) REJECT any image that contains visible text blocks, posters, labels, watermarks, captions, promotional typography, or contextual UI noise.
6) Reject if the image is thumbnail-sized, blurry, heavily compressed, pixelated, or too low-resolution for publication.
7) If unsure, set isArtwork=false and confidence<=0.5.`
        : `Return JSON ONLY with keys:
{ "isArtwork": boolean, "isArtistPhoto": boolean, "hasPeople": boolean, "isInstallationView": boolean, "isDecorativeObject": boolean, "isDocumentaryPhoto": boolean, "isArtworkOnly": boolean, "containsTextOverlay": boolean, "isLowQuality": boolean, "confidence": number, "reason": string }
Rules:
0) ${studioOnlyRule}
0.05) ${mediumCheckRule}
0.1) ${styleMatchRule}
1) STRICT CURATION: Decide whether this image is strictly a piece of artwork (painting, woodcut, sculpture, drawing, print, or similar). If it is a portrait of a person, a gallery photo, an installation view, or text-heavy, it must be rejected.
2) ARTWORK ONLY: Must be primarily the artwork itself — NOT a photo of the artist, NOT an exhibition/install view, NOT a catalog page, NOT a mockup. A simple frame or narrow border is acceptable if the artwork clearly fills most of the image.
3) People or animals depicted INSIDE the artwork are allowed. Reject only if there are real people, gallery spaces, display pedestals, or wide room context around the artwork.
4) If it's a physical object, accept ONLY if it is clearly the artwork itself isolated on a neutral background (no people, no gallery context).
5) REJECT any image that contains visible text blocks, posters, labels, watermarks, captions, promotional typography, or contextual UI noise.
6) Reject if the image is thumbnail-sized, blurry, heavily compressed, pixelated, or too low-resolution for publication.
7) Must be one finished artwork, sharp and clear.
8) If unsure, set isArtwork=false and confidence<=0.5.`;

      const text = await this.gemini.generateTextFromImage({
        model: 'gemini-2.5-flash',
        maxOutputTokens: 320,
        temperature: 0,
        thinkingBudget: 0,
        imageBase64: imageData.base64,
        mimeType: imageData.mediaType,
        responseMimeType: 'application/json',
        responseJsonSchema,
        prompt: `Evaluate this image for use in an article about the artist "${artist.full_name}".${practiceInfo}${locationInfo}

${skepticismPrefix}

${amnestyModeRule}

${samicoWoodcutMode}

${jotaMuralMode}

${clovisNaifMode}

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
      const containsTextOverlay = Boolean(parsed.containsTextOverlay);
      const isLowQuality = Boolean(parsed.isLowQuality);
      const reasonText = this.normalizeText(parsed.reason ?? '');
      const signatureOnlyText = this.isLikelyArtworkSignatureText(reasonText);
      const reasonHasText =
        !signatureOnlyText && this.reasonSuggestsVisibleTextOverlay(reasonText);

      const minimumConfidence = amnestyMode ? 0.8 : options.skepticMode ? 0.95 : 0.75;
      let allow = isArtwork && confidence >= minimumConfidence;

      if (hasPeople && !photographyMode && !isArtworkOnly) {
        allow = false;
      }

      if (photographyMode) {
        if (isArtistPhoto || isInstallationView || isDecorativeObject) {
          allow = false;
        }
      } else {
        if (isArtistPhoto || isInstallationView || isDocumentaryPhoto) {
          allow = false;
        }
        if (isDecorativeObject && !isArtworkOnly) {
          allow = false;
        }
      }

      if (reasonHasText) {
        allow = false;
      }

      if (isLowQuality) {
        allow = false;
      }

      if (containsTextOverlay && !signatureOnlyText) {
        allow = false;
      }

      if (
        !allow &&
        signatureOnlyText &&
        this.reasonSuggestsStandaloneArtwork(reasonText) &&
        !this.isNegativeVerificationReason(parsed.reason ?? '') &&
        !isArtistPhoto &&
        !isInstallationView &&
        !isDocumentaryPhoto &&
        !isLowQuality &&
        !(hasPeople && !photographyMode && !isArtworkOnly)
      ) {
        allow = true;
      }

      if (
        !allow &&
        this.reasonSuggestsStandaloneArtwork(reasonText) &&
        this.reasonSuggestsDepictedFiguresAreInsideArtwork(reasonText) &&
        !this.isNegativeVerificationReason(parsed.reason ?? '') &&
        !isArtistPhoto &&
        !isInstallationView &&
        !isDocumentaryPhoto &&
        !isLowQuality &&
        !(containsTextOverlay && !signatureOnlyText)
      ) {
        allow = true;
      }

      if (
        !allow &&
        this.reasonSuggestsStandaloneArtwork(reasonText) &&
        !this.isNegativeVerificationReason(parsed.reason ?? '') &&
        !isArtistPhoto &&
        !isInstallationView &&
        !isDocumentaryPhoto &&
        !isLowQuality &&
        !(hasPeople && !photographyMode && !isArtworkOnly) &&
        !(containsTextOverlay && !signatureOnlyText)
      ) {
        allow = true;
      }

      const finalReason =
        allow && signatureOnlyText
          ? 'Verified standalone artwork image suitable for publication; any visible markings are intrinsic to the artwork itself.'
          : parsed.reason || 'Gemini vision verification';

      const result = {
        verified: allow,
        reason: finalReason,
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
    containsTextOverlay?: boolean;
    isLowQuality?: boolean;
    confidence?: number;
    reason?: string;
  } {
    const attemptParse = (payload: string): Record<string, unknown> | null => {
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    };

    const direct = attemptParse(value);
    if (direct) return direct;

    const trimmed = value.trim();
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      const fenced = attemptParse(fencedMatch[1].trim());
      if (fenced) return fenced;
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const sliced = trimmed.slice(firstBrace, lastBrace + 1);
      const extracted = attemptParse(sliced);
      if (extracted) return extracted;
    }

    const regexFallback = this.parseLooseVerificationFields(trimmed);
    if (regexFallback) return regexFallback;

    return null;
  }

  private reasonSuggestsDepictedFiguresAreInsideArtwork(reason: string): boolean {
    const normalized = this.normalizeText(reason);
    return [
      'part of the artwork itself',
      'part of the artwork',
      'depicted inside the artwork',
      'depicted are part of the artwork',
      'within the artwork itself',
      'inside the artwork itself',
    ].some((signal) => normalized.includes(signal));
  }

  private shouldRecoverPositiveArtworkVerification(reason: string): boolean {
    const normalized = this.normalizeText(reason);
    if (!normalized) {
      return false;
    }

    const explicitSafeTextSignals = [
      'no text overlay',
      'there is no visible text',
      'no visible text',
      'contains no text',
      'no promotional typography',
      'no promotional text',
      'no watermark',
      'no caption',
    ];

    const safeArtworkContext =
      this.reasonSuggestsStandaloneArtwork(normalized) &&
      !this.reasonContainsExplicitRejectionCue(normalized);

    const negatedTextConcern =
      explicitSafeTextSignals.some((signal) => normalized.includes(signal)) ||
      (normalized.includes('text') &&
        (normalized.includes('no ') ||
          normalized.includes('without ') ||
          normalized.includes('contains no ')));

    return safeArtworkContext && (!this.reasonSuggestsVisibleTextOverlay(normalized) || negatedTextConcern);
  }

  private reasonContainsExplicitRejectionCue(reason: string): boolean {
    const normalized = this.normalizeText(reason);
    return [
      'not an artwork',
      'wrong artist',
      'does not match',
      'cannot confirm',
      'cannot verify',
      'cant confirm',
      'photo of a person',
      'photograph of a person',
      'real people around the artwork',
      'gallery wall',
      'room around the artwork',
      'product page',
      'product shot',
      'decor item',
      'display table',
      'on a table',
      'on table',
      'tabletop',
      'mockup',
    ].some((signal) => normalized.includes(signal));
  }

  private parseLooseVerificationFields(value: string): Record<string, unknown> | null {
    const fields: Record<string, unknown> = {};
    const boolKeys = [
      'isArtwork',
      'isArtistPhoto',
      'hasPeople',
      'isInstallationView',
      'isDecorativeObject',
      'isDocumentaryPhoto',
      'isArtworkOnly',
      'containsTextOverlay',
      'isLowQuality',
    ];
    const matchKey = (key: string): RegExp => new RegExp(`["']?${key}["']?\\s*[:=]\\s*`, 'i');

    for (const key of boolKeys) {
      const match = value.match(new RegExp(`${matchKey(key).source}["']?(true|false)["']?`, 'i'));
      if (match) {
        fields[key] = match[1].toLowerCase() === 'true';
      }
    }

    const confidenceMatch = value.match(new RegExp(`${matchKey('confidence').source}["']?([0-9.]+)["']?`, 'i'));
    if (confidenceMatch) {
      fields.confidence = Number.parseFloat(confidenceMatch[1]);
    }

    const reasonMatch = value.match(new RegExp(`${matchKey('reason').source}["']?([\\s\\S]+?)["']?(?:\\n|$)`, 'i'));
    if (reasonMatch) {
      fields.reason = reasonMatch[1].trim();
    }

    if (Object.keys(fields).length === 0) {
      return null;
    }

    return fields;
  }

  private isLikelyArtworkSignatureText(reasonText: string): boolean {
    if (!reasonText) {
      return false;
    }

    const signatureSignals = [
      'signature',
      'signed',
      'small date',
      'date in the bottom',
      'date in the corner',
      'bottom left corner',
      'bottom right corner',
      'bottom left',
      'bottom right',
      'artist signature',
    ];

    const strongTextSignals = ['poster', 'flyer', 'watermark', 'caption', 'label', 'banner', 'promotional', 'typography'];
    return signatureSignals.some((signal) => reasonText.includes(signal)) &&
      !strongTextSignals.some((signal) => reasonText.includes(signal));
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
    url: string,
    options: { allowDiamondWarning?: boolean; minDiamondShortSide?: number; minLongestSide?: number } = {}
  ): Promise<DownloadedImageData | null> {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'User-Agent':
            'CascaArchiveBot/1.0 (https://blog.casca-archive.org; contact@casca-archive.org) Node.js',
          Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: 'https://commons.wikimedia.org/',
        },
      });

      const buffer = Buffer.from(response.data);
      const contentType = response.headers['content-type'] || '';
      let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg';
      if (contentType.includes('png')) mediaType = 'image/png';
      else if (contentType.includes('gif')) mediaType = 'image/gif';
      else if (contentType.includes('webp')) mediaType = 'image/webp';

      const dimensions = this.getImageDimensions(buffer, mediaType);
      // Reject tiny files only when they are also below the approved editorial baseline.
      if (
        buffer.length < 8_000 &&
        (!dimensions || dimensions.width < 450 || dimensions.height < 450)
      ) {
        console.log(`  Skipped ${url} — file too small (${(buffer.length / 1024).toFixed(0)}KB, min 8KB)`);
        return null;
      }
      const isForcedHighGoogleArts = this.isForcedHighGoogleArtsUrl(url);
      if (!isForcedHighGoogleArts) {
        const publishableQuality = this.isPublishableQuality(url, dimensions);
        if (!publishableQuality.ok) {
          console.log(`  Skipped ${url} — ${publishableQuality.reason}`);
          return null;
        }
      }
      if (
        dimensions &&
        options.minLongestSide &&
        Math.max(dimensions.width, dimensions.height) < options.minLongestSide
      ) {
        console.log(
          `  Skipped ${url} — longest side too small (${dimensions.width}x${dimensions.height}, min longest side ${options.minLongestSide})`
        );
        return null;
      }
      if (
        dimensions &&
        (dimensions.width < 450 || dimensions.height < 450)
      ) {
        if (
          options.allowDiamondWarning &&
          Math.min(dimensions.width, dimensions.height) >= (options.minDiamondShortSide ?? 400) &&
          Math.max(dimensions.width, dimensions.height) >= 440
        ) {
          const base64 = buffer.toString('base64');
          return {
            base64,
            mediaType,
            qualityWarning: `diamond-resolution-warning:${dimensions.width}x${dimensions.height}`,
            dimensions,
          };
        }
        console.log(
          `  Skipped ${url} — low dimensions (${dimensions.width}x${dimensions.height}, minimum 450px on each side)`
        );
        return null;
      }

      const base64 = buffer.toString('base64');
      return { base64, mediaType, dimensions: dimensions ?? undefined };
    } catch {
      return null;
    }
  }

  private isPublishableQuality(
    url: string,
    dimensions?: { width: number; height: number } | null
  ): { ok: boolean; reason: string } {
    if (this.isLikelyThumbnailAsset(url)) {
      return { ok: false, reason: 'filename suggests thumbnail, small asset, or icon' };
    }

    if (dimensions && (dimensions.width < 450 || dimensions.height < 450)) {
      return {
        ok: false,
        reason: `resolution too small for publication (${dimensions.width}x${dimensions.height}, minimum 450px on each side)`,
      };
    }

    return { ok: true, reason: 'publishable quality' };
  }

  private isForcedHighGoogleArtsUrl(url: string): boolean {
    const normalized = this.normalizeImageUrl(url).toLowerCase();
    return /^https:\/\/lh3\.googleusercontent\.com\/ci\//.test(normalized) && /=(?:s1600|s4000|s0)$/i.test(normalized);
  }

  private async hasTwoLargeApprovedImages(images: Image[]): Promise<boolean> {
    let largeCount = 0;

    for (const image of images) {
      const imageData = await this.downloadImageAsBase64(image.url);
      if (!imageData) {
        continue;
      }

      const buffer = Buffer.from(imageData.base64, 'base64');
      const dimensions = this.getImageDimensions(buffer, imageData.mediaType);
      if (!dimensions) {
        continue;
      }

      if (Math.min(dimensions.width, dimensions.height) >= 600) {
        largeCount += 1;
      }

      if (largeCount >= 2) {
        return true;
      }
    }

    return false;
  }

  private getImageDimensions(
    buffer: Buffer,
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  ): { width: number; height: number } | null {
    switch (mediaType) {
      case 'image/png':
        return this.readPngDimensions(buffer);
      case 'image/gif':
        return this.readGifDimensions(buffer);
      case 'image/webp':
        return this.readWebpDimensions(buffer);
      case 'image/jpeg':
      default:
        return this.readJpegDimensions(buffer);
    }
  }

  private readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
    if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
      return null;
    }

    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  private readGifDimensions(buffer: Buffer): { width: number; height: number } | null {
    if (buffer.length < 10 || buffer.toString('ascii', 0, 3) !== 'GIF') {
      return null;
    }

    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  private readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return null;
    }

    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      const markerLength = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);

      if (isStartOfFrame && offset + 8 < buffer.length) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }

      if (!markerLength || markerLength < 2) {
        break;
      }

      offset += markerLength + 2;
    }

    return null;
  }

  private readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
    if (
      buffer.length < 30 ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WEBP'
    ) {
      return null;
    }

    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height };
    }

    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }

    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }

    return null;
  }

  /**
   * Build a specific search query using artist details instead of generic terms.
   */
  private _buildSearchQuery(artist: ArtistInfo): string {
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
      const candidates = await this.wikiScout.findArtistImages(query, limit);
      return candidates.map((image) => ({
        title: image.title,
        url: image.url,
        description: image.description,
        author: undefined,
        license: undefined,
        thumb_url: undefined,
      }));
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
