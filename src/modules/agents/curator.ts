import { query } from '../../db/client.js';
import { artistOps, draftOps, sourceOps } from '../../db/operations/index.js';
import { getConfig } from '../../config/index.js';
import { SynthesisModule } from '../synthesis/index.js';
import { VisualModule } from '../visual/index.js';
import { VisualScavenger } from '../visual/scavenger.js';
import type { Artist, Image } from '../../types/index.js';
import { BaseAgent, type AgentTickResult } from './base.js';

const READY_FLOOR = 5;
const HYPERDRIVE_SLEEP_MS = 10_000;
const MAX_FAILURES = 3;
const MIN_WORDS = 450;
const MAX_WORDS = 700;
const REQUIRED_IMAGE_COUNT = 3;
const SCRAPING_JUNK_PATTERNS = [
  'get the app',
  'join us',
  'buy now',
  'skip to main content',
  'login',
  'log in',
  'sign up',
  'marketplace',
  'cookie policy',
  'privacy policy',
  'download the app',
];

export class CuratorAgent extends BaseAgent {
  private readonly synthesis = new SynthesisModule(getConfig().env.geminiApiKey);
  private readonly visual = new VisualModule(getConfig().env.geminiApiKey);
  private readonly scavenger = new VisualScavenger(this.visual);

  constructor() {
    super('curator-agent', {
      pollIntervalMs: 45_000,
      maxBackoffMs: 15 * 60 * 1000,
    });
  }

  protected async tick(): Promise<AgentTickResult> {
    const readyCount = await draftOps.countByStatus('ready');
    const hyperDrive = readyCount < READY_FLOOR;
    const batchSize = hyperDrive ? 5 : 1;
    const artists = query.all<Artist>(
      `SELECT *
       FROM artists
       WHERE status IN ('researched', 'curated', 'verified')
       ORDER BY priority DESC, discovered_at ASC
       LIMIT ?`,
      [batchSize]
    );

    if (artists.length === 0) {
      return {
        worked: false,
        detail: 'queue-empty:researched',
        sleepMs: hyperDrive ? HYPERDRIVE_SLEEP_MS : 3 * 60 * 1000,
      };
    }

    const settled = await Promise.allSettled(artists.map((artist) => this.processArtist(artist)));

    let ready = 0;
    let permanent = 0;
    let failures = 0;
    let approvedImages = 0;
    let rejectedImages = 0;

    for (const item of settled) {
      if (item.status === 'fulfilled') {
        ready += item.value.ready;
        permanent += item.value.permanent;
        failures += item.value.failures;
        approvedImages += item.value.approved;
        rejectedImages += item.value.rejected;
      } else {
        failures += 1;
      }
    }

    return {
      worked: ready > 0,
      detail: `mode:${hyperDrive ? 'hyperdrive' : 'cruise'};ready:${ready};permanent:${permanent};failures:${failures};approved:${approvedImages};rejected:${rejectedImages};queue:${readyCount}`,
      sleepMs: hyperDrive ? HYPERDRIVE_SLEEP_MS : undefined,
    };
  }

  private async processArtist(
    artist: Artist
  ): Promise<{ ready: number; permanent: number; failures: number; approved: number; rejected: number }> {
    if (!artist.id) {
      return { ready: 0, permanent: 0, failures: 1, approved: 0, rejected: 0 };
    }

    await this.pruneInvalidOpenDrafts(artist.id);

    const sources = await sourceOps.findByArtistId(artist.id);

    const metadata = artistOps.parseMetadata(artist);
    const bioMetadata =
      metadata.bio_metadata && typeof metadata.bio_metadata === 'object'
        ? (metadata.bio_metadata as { birth_year?: string })
        : {};
    const artistInfo = {
      full_name: artist.full_name,
      visual_practice: artist.visual_practice ?? undefined,
      birth_year: typeof bioMetadata.birth_year === 'string' ? bioMetadata.birth_year : undefined,
      birthplace_city: artist.birthplace_city ?? undefined,
      birthplace_state: artist.birthplace_state ?? undefined,
      artwork_candidates: Array.isArray(metadata.research_cache_artwork_candidates)
        ? (metadata.research_cache_artwork_candidates as Array<{
            pageUrl: string;
            imageUrl?: string;
            title?: string;
            sourceDomain?: string;
            confidence?: number;
          }>)
        : undefined,
    };
    const skepticismMode = true;
    let candidateImages = await this.visual.sourceImages(
      artistInfo,
      sources,
      0,
      6
    );

    let curation = await this.visual.curateDraftImagesForReady(artistInfo, candidateImages, {
      skepticMode: skepticismMode,
      requireDiamondSources: true,
      allowGalleryProxy: true,
    });

    if (!curation.ready && curation.approved.length >= 1) {
      const scavenged = await this.scavenger.recoverMissingImages(
        artistInfo,
        curation.approved,
        REQUIRED_IMAGE_COUNT - curation.approved.length,
        { institutionalOnly: true }
      );
      if (scavenged.approved.length > 0 || scavenged.rejected.length > 0) {
        const merged = [...curation.approved, ...scavenged.approved].filter(
          (image, index, list) => list.findIndex((candidate) => candidate.url === image.url) === index
        );
        curation = await this.visual.curateDraftImagesForReady(artistInfo, merged, {
          skepticMode: skepticismMode,
          requireDiamondSources: true,
          allowGalleryProxy: true,
        });
      }
    }

    if (!curation.ready) {
      if (curation.approved.length === REQUIRED_IMAGE_COUNT - 1) {
        await this.persistAlmostReadyDraft(artist, curation.approved, curation.rejected);
      }
      const permanent = await this.registerFailure(
        artist.id,
        artist.full_name,
        `curator:not-ready:${curation.approved.length}/${REQUIRED_IMAGE_COUNT}`
      );
      return {
        ready: 0,
        permanent,
        failures: 1,
        approved: curation.approved.length,
        rejected: curation.rejected.length,
      };
    }

    await artistOps.updateStatus(artist.id, 'curated');
    const synthesisResult = await this.synthesis.synthesize(artist.id);
    const readinessError = this.validateDraftForReadyState(
      synthesisResult.draft.title,
      synthesisResult.draft.content,
      artist.full_name,
      curation.approved
    );

    if (readinessError) {
      if (synthesisResult.draft.id) {
        await draftOps.delete(synthesisResult.draft.id);
      }
      const permanent = await this.registerFailure(
        artist.id,
        artist.full_name,
        `curator:invalid-draft:${readinessError}`
      );
      return {
        ready: 0,
        permanent,
        failures: 1,
        approved: curation.approved.length,
        rejected: curation.rejected.length,
      };
    }

    await draftOps.markCurated(synthesisResult.draft.id!, curation.approved, 80);
    await draftOps.markReady(synthesisResult.draft.id!, curation.approved, 80);
    await artistOps.updateStatus(artist.id, 'ready_to_send');
    await artistOps.updatePriority(artist.id, 80);
    await artistOps.resetFailureCount(artist.id);
    await artistOps.mergeMetadata(artist.id, {
      almost_ready_draft_id: null,
      almost_ready_candidates: [],
      almost_ready_last_reason: null,
    });

    return {
      ready: 1,
      permanent: 0,
      failures: 0,
      approved: curation.approved.length,
      rejected: curation.rejected.length,
    };
  }

  private validateDraftForReadyState(
    title: string,
    content: string,
    artistName: string,
    approvedImages: Array<{ url: string; caption?: string; attribution: string }>
  ): string | null {
    if (!this.titleIncludesArtist(title, artistName)) {
      return 'title-missing-artist-name';
    }

    const wordCount = content.split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
      return `invalid-word-count:${wordCount}`;
    }

    if (approvedImages.length !== REQUIRED_IMAGE_COUNT) {
      return `invalid-image-count:${approvedImages.length}`;
    }

    const normalized = content.toLowerCase();
    if (SCRAPING_JUNK_PATTERNS.some((pattern) => normalized.includes(pattern))) {
      return 'scraping-junk-detected';
    }

    return null;
  }

  private titleIncludesArtist(title: string, artistName: string): boolean {
    const normalizedTitle = this.normalizeText(title);
    const normalizedArtist = this.normalizeText(artistName);
    if (normalizedTitle.includes(normalizedArtist)) {
      return true;
    }
    const surname = normalizedArtist.split(/\s+/).filter(Boolean).pop();
    return Boolean(surname && surname.length >= 3 && normalizedTitle.includes(surname));
  }

  private normalizeText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  private async persistAlmostReadyDraft(
    artist: Artist,
    approvedImages: Image[],
    rejectedCandidates: Array<{ image: Image; reason: string }>
  ): Promise<void> {
    if (!artist.id) {
      return;
    }

    await artistOps.updateStatus(artist.id, 'curated');
    const synthesisResult = await this.synthesis.synthesize(artist.id);
    if (!synthesisResult.draft.id) {
      return;
    }

    await draftOps.markCurated(synthesisResult.draft.id, approvedImages, 75);
    await artistOps.mergeMetadata(artist.id, {
      almost_ready_draft_id: synthesisResult.draft.id,
      almost_ready_candidates: rejectedCandidates.slice(0, 8).map((candidate) => ({
        url: candidate.image.url,
        caption: candidate.image.caption ?? '',
        attribution: candidate.image.attribution,
        reason: candidate.reason,
      })),
      almost_ready_last_reason: `curator:not-ready:${approvedImages.length}/${REQUIRED_IMAGE_COUNT}`,
    });
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

  private async pruneInvalidOpenDrafts(artistId: number): Promise<void> {
    const drafts = await draftOps.findByArtistId(artistId);
    for (const draft of drafts) {
      if (!draft.id) {
        continue;
      }
      if (!['pending', 'researched', 'curated', 'drafted'].includes(draft.status)) {
        continue;
      }

      const wordCount = draft.content.split(/\s+/).filter(Boolean).length;
      const imageCount = this.parseImageCount(draft.images);
      if (wordCount < MIN_WORDS || wordCount > MAX_WORDS || imageCount < REQUIRED_IMAGE_COUNT) {
        await draftOps.delete(draft.id);
      }
    }
  }

  private parseImageCount(images: string | null | undefined): number {
    if (!images) {
      return 0;
    }

    try {
      const parsed = JSON.parse(images);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
}
