import { artistOps, draftOps } from '../../db/operations/index.js';
import type { Draft, Image } from '../../types/index.js';

export interface EmergencyFallbackDraft {
  sourceDraftId: number;
  draftId: number;
  artistId: number;
  artistName: string;
  images: Image[];
}

export class EmergencyFallbackModule {
  async prepareFallbackDraft(options: {
    minImages?: number;
    excludedArtistIds?: Set<number>;
  } = {}): Promise<EmergencyFallbackDraft | null> {
    const minImages = options.minImages ?? 2;
    const excludedArtistIds = options.excludedArtistIds ?? new Set<number>();

    const reserveCandidates = await this.findReserveCandidates(minImages, excludedArtistIds);
    if (reserveCandidates.length === 0) {
      return null;
    }

    const selected = reserveCandidates[0];
    const clonedDraftId = await draftOps.create(
      {
        artist_id: selected.artistId,
        title: selected.draft.title,
        subtitle: selected.draft.subtitle,
        content: selected.draft.content,
        status: 'pending',
      },
      selected.images
    );

    return {
      sourceDraftId: selected.draft.id!,
      draftId: clonedDraftId,
      artistId: selected.artistId,
      artistName: selected.artistName,
      images: selected.images,
    };
  }

  private async findReserveCandidates(
    minImages: number,
    excludedArtistIds: Set<number>
  ): Promise<Array<{ draft: Draft; images: Image[]; artistId: number; artistName: string }>> {
    const approvedDrafts = await draftOps.findByStatus('approved');
    const reservePool = [...approvedDrafts];

    const candidates: Array<{ draft: Draft; images: Image[]; artistId: number; artistName: string }> = [];

    for (const draft of reservePool) {
      if (!draft.id || excludedArtistIds.has(draft.artist_id)) {
        continue;
      }

      const images = this.parseImages(draft.images);
      if (images.length < minImages) {
        continue;
      }

      const hasRiskyAttribution = images.some((image) =>
        (image.attribution ?? '').toLowerCase().includes('web search')
      );
      if (hasRiskyAttribution) {
        continue;
      }

      const hasSocialImage = images.some((image) => this.isSocialImageUrl(image.url));
      if (hasSocialImage) {
        continue;
      }

      const artist = await artistOps.findById(draft.artist_id);
      if (!artist) {
        continue;
      }

      const activeDrafts = await draftOps.findByArtistId(draft.artist_id);
      const hasOpenDraft = activeDrafts.some(
        (existing) => existing.status === 'pending' || existing.status === 'sent'
      );
      if (hasOpenDraft) {
        continue;
      }

      candidates.push({
        draft,
        images,
        artistId: draft.artist_id,
        artistName: artist.full_name,
      });
    }

    candidates.sort((a, b) => {
      const aTime = new Date(a.draft.sent_at ?? a.draft.created_at ?? 0).getTime();
      const bTime = new Date(b.draft.sent_at ?? b.draft.created_at ?? 0).getTime();
      return aTime - bTime;
    });

    return candidates;
  }

  private parseImages(raw: string | null | undefined): Image[] {
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as Image[];
      return parsed.filter((image) => image?.url && image?.attribution);
    } catch {
      return [];
    }
  }

  private isSocialImageUrl(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return [
        'instagram.com',
        'cdninstagram.com',
        'facebook.com',
        'fbcdn.net',
        'pinterest.com',
        'pinimg.com',
      ].some((host) => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  }
}
