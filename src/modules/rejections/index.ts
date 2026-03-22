import { artistOps, draftOps, publishingOps } from '../../db/operations/index.js';

export interface RejectionQueueResult {
  queued: boolean;
  alreadyRejected: boolean;
}

export async function queueRejectedDraftReplacement(draftId: number): Promise<RejectionQueueResult> {
  const draft = await draftOps.findById(draftId);
  if (!draft) {
    throw new Error(`Draft ${draftId} not found`);
  }

  const alreadyRejected = draft.status === 'rejected';

  if (!alreadyRejected) {
    await draftOps.updateStatus(draftId, 'rejected');
  }

  await artistOps.updateStatus(draft.artist_id, 'published');

  const logs = await publishingOps.findByDraftId(draftId);
  const existingQueueLog = logs.find((log) => log.error_message === 'replacement_requested');

  if (!existingQueueLog) {
    await publishingOps.create({
      draft_id: draftId,
      error_message: 'replacement_requested',
    });
  }

  return { queued: true, alreadyRejected };
}
