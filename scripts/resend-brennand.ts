#!/usr/bin/env tsx

import { initDatabase, closeDatabase } from '../src/db/local.js';
import { loadConfig } from '../src/config/index.js';
import { EmailModule } from '../src/modules/email/index.js';
import { VisualModule } from '../src/modules/visual/index.js';
import { draftOps } from '../src/db/operations/index.js';

const config = loadConfig();
initDatabase();

async function resend() {
  console.log('📧 Resending Francisco Brennand email...\n');

  // Get draft 17
  const draft = draftOps.findById(17);
  if (!draft) {
    console.error('Draft 17 not found');
    process.exit(1);
  }

  console.log(`📄 Draft: ${draft.title}\n`);

  // Source fresh images
  const visualModule = new VisualModule(config.env.geminiApiKey);
  console.log('🖼️  Sourcing images...');
  const images = await visualModule.sourceImages(
    { full_name: 'Francisco Brennand' },
    [],
    17,
    6
  );
  console.log(`  ✓ Found ${images.length} images\n`);

  // Send email
  const emailModule = new EmailModule(config.env.resendApiKey);
  await emailModule.sendApprovalEmail({
    draftId: 17,
    images,
  });

  console.log('\n✅ Email resent successfully!');
  closeDatabase();
}

resend();
