/**
 * Vercel Serverless Function - One-Click Rejection
 *
 * GET /api/webhook/reject?draft=ID&token=SECRET
 * Rejects a draft and immediately attempts to send the next approval email
 * before falling back to background replenishment.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { spawn } from 'node:child_process';
import { draftOps } from '../../src/db/operations/index.js';
import { getConfig } from '../../src/config/index.js';
import { initDatabase, closeDatabase } from '../../src/db/local.js';
import { Dispatcher, EmailModule } from '../../src/modules/email/index.js';
import { EmergencyFallbackModule } from '../../src/modules/emergency/index.js';
import { queueRejectedDraftReplacement } from '../../src/modules/rejections/index.js';

const MIN_APPROVAL_IMAGES = 3;

export const maxDuration = 30;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  const draftId = Number(req.query.draft);
  const token = req.query.token as string;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  // Validate token
  if (!webhookSecret || token !== webhookSecret) {
    return res.status(401).send(page('Unauthorized', 'Invalid or missing token.'));
  }

  // Validate draft ID
  if (!draftId || isNaN(draftId)) {
    return res.status(400).send(page('Error', 'Missing or invalid draft ID.'));
  }

  try {
    initDatabase();

    // Check draft exists and is in "sent" or "approved" status
    const draft = await draftOps.findById(draftId);
    if (!draft) {
      closeDatabase();
      console.warn(
        `Draft ${draftId} not found locally during rejection. Triggering detached replacement flow.`
      );

      triggerReplacementAttemptDetached({ preferSend: true });
      return res.status(200).send(
        page(
          'Rejected',
          'This article was rejected successfully. The original draft was not present in this local queue, but a replacement run has already been triggered and the next article will be sent automatically.'
        )
      );
    }

    const alreadyRejected = draft.status === 'rejected';

    if (!alreadyRejected && draft.status !== 'sent' && draft.status !== 'approved') {
      closeDatabase();
      return res
        .status(400)
        .send(page('Invalid Status', `Draft is "${draft.status}", expected "sent" or "approved".`));
    }

    console.log(`Rejecting draft ${draftId}: ${draft.title}`);
    const result = await queueRejectedDraftReplacement(draftId);
    const replacement = await sendImmediateReplacement(draftId);

    closeDatabase();

    if (replacement.sent) {
      triggerReplacementAttemptDetached({ preferSend: false });
      return res.status(200).send(
        page(
          result.alreadyRejected || alreadyRejected ? 'Already Rejected' : 'Rejected',
          `This article was rejected successfully. A new approval email for ${replacement.artistName} has already been sent.`
        )
      );
    }

    if (replacement.blockedByDailyCap) {
      triggerReplacementAttemptDetached({ preferSend: false });
      return res.status(200).send(
        page(
          result.alreadyRejected || alreadyRejected ? 'Already Rejected' : 'Rejected',
          'This article was rejected successfully. An urgent replacement is being prepared in the background and will be sent as soon as it is ready.'
        )
      );
    }

    triggerReplacementAttemptDetached({ preferSend: true });

    return res.status(200).send(
      page(
        result.alreadyRejected || alreadyRejected ? 'Already Rejected' : 'Rejected',
        'This article was rejected successfully. No ready replacement was available instantly, so a priority replacement run has been triggered in the background and will send the next article immediately when it becomes ready.'
      )
    );
  } catch (error) {
    console.error('Rejection error:', error);
    closeDatabase();
    return res.status(500).send(
      page('Error', `Rejection failed: ${error instanceof Error ? error.message : String(error)}`)
    );
  }
}

async function sendImmediateReplacement(
  rejectedDraftId: number
): Promise<{ sent: boolean; blockedByDailyCap?: boolean; draftId?: number; artistName?: string }> {
  const config = getConfig();
  const email = new EmailModule(config.env.resendApiKey);
  const dispatcher = new Dispatcher(email);
  const emergencyFallback = new EmergencyFallbackModule();
  const rejectedDraft = await draftOps.findById(rejectedDraftId);
  const excludedArtistIds = new Set<number>();

  if (rejectedDraft?.artist_id) {
    excludedArtistIds.add(rejectedDraft.artist_id);
  }

  const dispatchResult = await dispatcher.sendNextAvailable(true);
  if (dispatchResult.sent) {
    return {
      sent: true,
      draftId: dispatchResult.draftId,
      artistName: dispatchResult.artistName,
    };
  }

  if (dispatchResult.reason && isDailyCapSendError(dispatchResult.reason)) {
    return { sent: false, blockedByDailyCap: true };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const fallback = await emergencyFallback.prepareFallbackDraft({
      minImages: MIN_APPROVAL_IMAGES,
      excludedArtistIds,
    });

    if (!fallback) {
      break;
    }

    try {
      await email.sendApprovalEmail({
        draftId: fallback.draftId,
        images: fallback.images,
        bypassDailyCap: true,
      });

      return {
        sent: true,
        draftId: fallback.draftId,
        artistName: fallback.artistName,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Immediate emergency replacement send failed for draft ${fallback.draftId}: ${message}`
      );

      if (isDailyCapSendError(message)) {
        return { sent: false, blockedByDailyCap: true };
      }

      excludedArtistIds.add(fallback.artistId);
      await draftOps.updateStatus(fallback.draftId, 'rejected');

      if (!isDiscardableImmediateSendError(message)) {
        throw error;
      }
    }
  }

  return { sent: false };
}

function isDailyCapSendError(message: string): boolean {
  return message.toLowerCase().includes('daily hard cap');
}

function isDiscardableImmediateSendError(message: string): boolean {
  return [
    'validated images',
    'fewer than',
    'duplicate approval email',
    'already-published artist',
    'already in sent status',
    'editor-rejected artist',
    'rejected draft',
  ].some((fragment) => message.includes(fragment));
}

function triggerReplacementAttemptDetached(options: { preferSend: boolean }): void {
  try {
    const command = options.preferSend
      ? 'mkdir -p logs && (' +
        '(npx tsx scripts/scout-agent.ts --once >> logs/webhook-replacements.log 2>&1 || true); ' +
        '(npx tsx scripts/research-agent.ts --once >> logs/webhook-replacements.log 2>&1 || true); ' +
        '(npx tsx scripts/curator-agent.ts --once >> logs/webhook-replacements.log 2>&1 || true); ' +
        '(npx tsx scripts/run-dispatcher.ts --force >> logs/webhook-replacements.log 2>&1 || true); ' +
        '(npx tsx scripts/overseer.ts >> logs/webhook-replacements.log 2>&1 || true)' +
        ')'
      : 'mkdir -p logs && (' +
        '(npx tsx scripts/scout-agent.ts --once >> logs/webhook-replacements.log 2>&1 || true); ' +
        '(npx tsx scripts/research-agent.ts --once >> logs/webhook-replacements.log 2>&1 || true); ' +
        '(npx tsx scripts/curator-agent.ts --once >> logs/webhook-replacements.log 2>&1 || true); ' +
        '(npx tsx scripts/overseer.ts >> logs/webhook-replacements.log 2>&1 || true)' +
        ')';

    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(
      `Queued detached replacement workflow after rejection (${options.preferSend ? 'send+prepare' : 'prepare-only'})`
    );
  } catch (replacementError) {
    console.warn(
      'Failed to queue detached replacement workflow after rejection.',
      replacementError
    );
  }
}

function page(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CASCA - ${title}</title>
<style>
  body { font-family: 'Courier New', monospace; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: #fff; padding: 40px 50px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center; max-width: 500px; }
  h1 { margin: 0 0 15px; font-size: 1.8em; }
  p { color: #555; font-size: 1.1em; line-height: 1.5; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}
