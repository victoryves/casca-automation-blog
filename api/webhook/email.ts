/**
 * Vercel Serverless Function - Email Webhook
 *
 * Handles inbound email from Resend for approval detection.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { EmailModule } from '../../src/modules/email/index.js';
import { WorkflowOrchestrator } from '../../src/orchestrator/workflow.js';
import { draftOps } from '../../src/db/operations/index.js';
import { initDatabase, closeDatabase } from '../../src/db/supabase.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify webhook secret
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const authHeader = req.headers['authorization'];

  if (!webhookSecret || authHeader !== `Bearer ${webhookSecret}`) {
    console.error('Unauthorized webhook request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Parse webhook payload (from Cloudflare Email Worker)
    const payload = req.body;

    const from = payload.from;
    const subject = payload.subject;
    const body = payload.body || '';
    const hasApprovalKeyword = payload.hasApprovalKeyword;

    console.log('Received webhook:', { from, subject, hasApprovalKeyword });

    // Verify sender is approval email
    const approvalEmail = process.env.APPROVAL_EMAIL;
    if (!from.includes(approvalEmail!)) {
      console.log('Email not from approval address');
      return res.status(200).json({ message: 'Email not from approval address' });
    }

    // Check if approval keyword was already detected by Worker
    if (!hasApprovalKeyword) {
      console.log('No approval keyword detected');
      return res.status(200).json({ message: 'No approval keyword found' });
    }

    // Initialize database
    initDatabase();

    console.log('✓ Approval detected!');

    // Get most recent sent draft
    const draft = await draftOps.findMostRecentSent();

    if (!draft) {
      console.error('No sent draft found');
      closeDatabase();
      return res.status(404).json({ error: 'No sent draft found' });
    }

    console.log(`Processing approval for draft ${draft.id}`);

    // Handle approval
    const orchestrator = new WorkflowOrchestrator();
    await orchestrator.handleApproval(draft.id!);

    console.log('✓ Article published successfully');

    closeDatabase();

    return res.status(200).json({
      success: true,
      message: 'Article approved and published',
      draft_id: draft.id,
    });
  } catch (error) {
    console.error('Webhook error:', error);
    closeDatabase();
    return res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
