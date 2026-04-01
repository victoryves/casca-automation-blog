#!/usr/bin/env tsx

/**
 * Manual Draft Publication
 *
 * Publishes the most recent sent draft to Hashnode
 */

import { initDatabase, closeDatabase } from '../src/db/local.js';
import { loadConfig } from '../src/config/index.js';
import { draftOps } from '../src/db/operations/index.js';
import { PublishingModule } from '../src/modules/publishing/index.js';

const config = loadConfig();

async function publishDraft() {
  console.log('🚀 Manual Draft Publication\n');

  initDatabase();

  try {
    // Get most recent sent draft
    const draft = await draftOps.findMostRecentSent();

    if (!draft) {
      console.error('❌ No sent draft found');
      process.exit(1);
    }

    console.log(`📄 Draft found: ${draft.title}`);
    console.log(`   ID: ${draft.id}`);
    console.log(`   Artist ID: ${draft.artist_id}`);
    console.log('');

    // Mark as approved
    console.log('✅ Marking draft as approved...');
    await draftOps.updateStatus(draft.id!, 'approved');

    // Publish to Hashnode
    console.log('🚀 Publishing to Hashnode...\n');

    const publishing = new PublishingModule(
      config.env.hashnodeApiKey!,
      config.env.hashnodePublicationId!
    );

    const result = await publishing.publish(draft.id!);

    if (result.success) {
      console.log('\n✅ SUCCESS! Article published!');
      console.log(`📰 URL: ${result.medium_url}`);
      console.log('');
    } else {
      console.error('\n❌ Publication failed:', result.error);
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

publishDraft();
