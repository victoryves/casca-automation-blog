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
    // Parse Resend webhook payload
    const payload = req.body;

    if (payload.type !== 'email.received') {
      return res.status(200).json({ message: 'Event type not handled' });
    }

    const email = payload.data;
    const from = email.from;
    const subject = email.subject;
    const body = email.text || email.html || '';

    console.log('Received email:', { from, subject });

    // Verify sender is approval email
    const approvalEmail = process.env.APPROVAL_EMAIL;
    if (!from.includes(approvalEmail!)) {
      console.log('Email not from approval address');
      return res.status(200).json({ message: 'Email not from approval address' });
    }

    // Initialize database
    initDatabase();

    // Check for approval keyword
    const emailModule = new EmailModule(process.env.RESEND_API_KEY!);
    const isApproval = emailModule.parseApprovalReply(body);

    if (!isApproval) {
      console.log('Email does not contain approval keyword');
      closeDatabase();
      return res.status(200).json({ message: 'No approval keyword found' });
    }

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
