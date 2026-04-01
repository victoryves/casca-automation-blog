#!/usr/bin/env tsx

/**
 * Test Hashnode Publishing
 *
 * Tests the publication flow to Hashnode.
 * Make sure HASHNODE_API_KEY and HASHNODE_PUBLICATION_ID are set in .env
 */

import { initDatabase, closeDatabase } from '../src/db/local.js';
import { loadConfig } from '../src/config/index.js';
import { PublishingModule } from '../src/modules/publishing/index.js';
import { draftOps } from '../src/db/operations/index.js';

const config = loadConfig();

// Check if Hashnode credentials are configured
if (!config.env.hashnodeApiKey || !config.env.hashnodePublicationId) {
  console.error('❌ Hashnode credentials not configured!');
  console.error('\nPlease set in .env:');
  console.error('  HASHNODE_API_KEY=your_api_key');
  console.error('  HASHNODE_PUBLICATION_ID=your_publication_id');
  console.error('\nSee docs/HASHNODE_SETUP.md for instructions.');
  process.exit(1);
}

initDatabase();

async function testPublish() {
  console.log('🧪 Testing Hashnode publication...\n');

  try {
    // Get the most recent draft
    const draft = draftOps.findMostRecentSent();

    if (!draft) {
      console.error('❌ No sent draft found. Please send an approval email first.');
      console.error('   Run: npx tsx scripts/test-email-with-images.ts');
      return;
    }

    console.log(`📄 Found draft: ${draft.title}`);
    console.log(`   ID: ${draft.id}`);
    console.log(`   Status: ${draft.status}\n`);

    // Mark as approved (for testing)
    console.log('✏️  Marking draft as approved...');
    draftOps.updateStatus(draft.id!, 'approved');

    // Publish
    const publishingModule = new PublishingModule(
      config.env.hashnodeApiKey!,
      config.env.hashnodePublicationId!
    );

    console.log('🚀 Publishing to Hashnode...\n');
    const result = await publishingModule.publish(draft.id!);

    if (result.success) {
      console.log('\n✅ Publication successful!');
      console.log(`   URL: ${result.medium_url}`);
      console.log('\n🎉 Your article is now live on Hashnode!');
    } else {
      console.error('\n❌ Publication failed:');
      console.error(`   ${result.error}`);
    }
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    closeDatabase();
  }
}

testPublish();
