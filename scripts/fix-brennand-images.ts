#!/usr/bin/env tsx

import { initDatabase, closeDatabase } from '../src/db/supabase.js';
import { loadConfig } from '../src/config/index.js';
import { EmailModule } from '../src/modules/email/index.js';
import { VisualModule } from '../src/modules/visual/index.js';
import { draftOps } from '../src/db/operations/index.js';

const config = loadConfig();
initDatabase({ path: config.env.databasePath });

async function fixImages() {
  console.log('🔧 Fixing Francisco Brennand images...\n');

  // Source fresh images
  const visualModule = new VisualModule();
  console.log('🖼️  Sourcing fresh images...');
  const allImages = await visualModule.sourceImages('Francisco Brennand', 17, 12);
  console.log(`  Found ${allImages.length} image URLs\n`);

  // Validate images (download and check)
  console.log('✅ Validating images...');
  const emailModule = new EmailModule(config.env.resendApiKey);
  const result = await (emailModule as any).prepareImageAttachments(allImages);

  // Get only valid images that were successfully validated
  const validImages = result.validatedImages;

  console.log(`\n📊 Validation complete:`);
  console.log(`  Total URLs: ${allImages.length}`);
  console.log(`  Valid images: ${validImages.length}`);
  console.log(`  Rejected: ${allImages.length - validImages.length}\n`);

  // Show valid images
  console.log('✅ Valid images to save:');
  validImages.forEach((img, i) => {
    console.log(`  ${i + 1}. ${img.url.substring(0, 80)}...`);
  });

  // Update draft with only valid images
  draftOps.updateImages(17, validImages);
  console.log(`\n✅ Updated draft 17 with ${validImages.length} validated images`);

  closeDatabase();
}

fixImages();
