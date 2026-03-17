#!/usr/bin/env tsx

/**
 * Test Email with Images
 */

import { initDatabase, closeDatabase } from '../src/db/supabase.js';
import { loadConfig } from '../src/config/index.js';
import { EmailModule } from '../src/modules/email/index.js';
import { VisualModule } from '../src/modules/visual/index.js';

const config = loadConfig();

initDatabase({
  path: config.env.databasePath,
});

async function testEmail() {
  console.log('🧪 Testing email with images...\n');

  try {
    // Source images
    const visualModule = new VisualModule(config.env.anthropicApiKey);
    console.log('📸 Sourcing images...');
    const images = await visualModule.sourceImages(
      { full_name: 'Cícero Dias', visual_practice: 'pintura' },
      [],
      999,
      3
    );
    console.log(`  ✓ Found ${images.length} images\n`);

    // Send email
    const emailModule = new EmailModule(config.env.resendApiKey);
    console.log('📧 Sending email with images...');

    await emailModule.sendApprovalEmail({
      draftId: 16, // Latest draft
      images,
    });

    console.log('\n✅ Email sent successfully!');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    closeDatabase();
  }
}

testEmail();
