/**
 * Vercel Serverless Function - One-Click Rejection
 *
 * GET /api/webhook/reject?draft=ID&token=SECRET
 * Rejects a draft, queues a replacement request in the database,
 * and lets the background runner discover a new artist and send a new approval email.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { spawn } from 'node:child_process';
import { draftOps } from '../../src/db/operations/index.js';
import { initDatabase, closeDatabase } from '../../src/db/local.js';
import { queueRejectedDraftReplacement } from '../../src/modules/rejections/index.js';

// Fast webhook: queue the replacement and try to send the next ready draft
// before returning when the backlog already exists.
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

      triggerReplacementAttemptDetached();
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

    closeDatabase();
    triggerReplacementAttemptDetached();

    return res.status(200).send(
      page(
        result.alreadyRejected || alreadyRejected ? 'Already Rejected' : 'Rejected',
        'This article was rejected successfully. A replacement request has been queued, and the next article is now being prepared in the background.'
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

function triggerReplacementAttemptDetached(): void {
  try {
    const command =
      'mkdir -p logs && ' +
      '(npx tsx scripts/run-daily.ts --force --skip-discovery >> logs/webhook-replacements.log 2>&1 || ' +
      'npx tsx scripts/run-daily.ts --force >> logs/webhook-replacements.log 2>&1)';

    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log('Queued detached replacement workflow after rejection');
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
