import { artistOps, draftOps, publicationHistoryOps } from '../../db/operations/index.js';

export interface PurgedReadyDuplicate {
  artistId: number;
  artistName: string;
  draftId?: number;
  matchedPublicationUrl?: string | null;
}

export async function purgeReadyDuplicatesAgainstPublicationHistory(): Promise<PurgedReadyDuplicate[]> {
  const readyDrafts = await draftOps.findByStatus('ready');
  const purged: PurgedReadyDuplicate[] = [];

  for (const draft of readyDrafts) {
    const artist = await artistOps.findById(draft.artist_id);
    if (!artist?.id) {
      continue;
    }

    const match = await publicationHistoryOps.findFuzzyMatch(artist.full_name);
    if (!match) {
      continue;
    }

    await artistOps.updateStatus(artist.id, 'rejected_duplicate_external');
    await artistOps.mergeMetadata(artist.id, {
      external_duplicate_detected_at: new Date().toISOString(),
      external_duplicate_source: match.source,
      external_duplicate_post_title: match.post_title ?? null,
      external_duplicate_post_url: match.post_url ?? null,
    });
    if (draft.id) {
      await draftOps.updateStatus(draft.id, 'rejected');
    }

    purged.push({
      artistId: artist.id,
      artistName: artist.full_name,
      draftId: draft.id,
      matchedPublicationUrl: match.post_url,
    });
  }

  return purged;
}
