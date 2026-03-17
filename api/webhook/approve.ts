/**
 * Vercel Serverless Function - One-Click Approval
 *
 * GET /api/webhook/approve?draft=ID&token=SECRET
 * Approves and publishes a draft to Hashnode.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { WorkflowOrchestrator } from '../../src/orchestrator/workflow.js';
import { draftOps } from '../../src/db/operations/index.js';
import { initDatabase, closeDatabase } from '../../src/db/supabase.js';

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

    if (draft.status === 'approved') {
      closeDatabase();
      return res.status(200).send(page('Already Published', `"${draft.title}" was already published.`));
    }

    if (draft.status !== 'sent') {
      closeDatabase();
      return res.status(400).send(page('Invalid Status', `Draft is "${draft.status}", expected "sent".`));
    }

    // Publish
    console.log(`Approving draft ${draftId}: ${draft.title}`);
    const orchestrator = new WorkflowOrchestrator();
    await orchestrator.handleApproval(draftId);

    closeDatabase();

    return res.status(200).send(
      page('Published!', `"${draft.title}" has been published to Hashnode.`)
    );
  } catch (error) {
    console.error('Approval error:', error);
    closeDatabase();
    return res.status(500).send(
      page('Error', `Publication failed: ${error instanceof Error ? error.message : String(error)}`)
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
