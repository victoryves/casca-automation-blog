/**
 * Vercel Serverless Function - One-Click Rejection
 *
 * GET /api/webhook/reject?draft=ID&token=SECRET
 * Rejects a draft, marks the artist as rejected, and re-runs the workflow
 * to discover a new artist and send a new approval email.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { WorkflowOrchestrator } from '../../src/orchestrator/workflow.js';
import { draftOps } from '../../src/db/operations/index.js';
import { initDatabase, closeDatabase } from '../../src/db/supabase.js';

// Allow up to 120s for the full workflow to complete
export const maxDuration = 120;

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

    // Check draft exists and is in "sent" status
    const draft = await draftOps.findById(draftId);
    if (!draft) {
      closeDatabase();
      return res.status(404).send(page('Not Found', `Draft ${draftId} not found.`));
    }

    if (draft.status === 'rejected') {
      closeDatabase();
      return res.status(200).send(page('Already Rejected', `This draft was already rejected. A new article is being prepared.`));
    }

    if (draft.status !== 'sent') {
      closeDatabase();
      return res.status(400).send(page('Invalid Status', `Draft is "${draft.status}", expected "sent".`));
    }

    closeDatabase();

    // Handle rejection and re-run workflow
    console.log(`Rejecting draft ${draftId}: ${draft.title}`);
    const orchestrator = new WorkflowOrchestrator();
    const result = await orchestrator.handleRejection(draftId);

    if (result.email_sent) {
      return res.status(200).send(
        page('Rejected — New Article Sent!', `The article about this artist was rejected. A new article has been prepared and sent to your email for review.`)
      );
    } else {
      return res.status(200).send(
        page('Rejected', `The article was rejected. ${result.errors.length > 0 ? 'However, we could not find a new artist at this time: ' + result.errors.join(', ') : 'A new article will be prepared soon.'}`)
      );
    }
  } catch (error) {
    console.error('Rejection error:', error);
    closeDatabase();
    return res.status(500).send(
      page('Error', `Rejection failed: ${error instanceof Error ? error.message : String(error)}`)
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
