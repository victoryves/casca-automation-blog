#!/usr/bin/env tsx

/**
 * Test Image Sourcing
 */

import { VisualModule } from '../src/modules/visual/index.js';

const visualModule = new VisualModule();

async function testImages() {
  console.log('🖼️  Testing image sourcing for Cícero Dias...\n');

  try {
    const images = await visualModule.sourceImages('Cícero Dias', 999, 3);

    console.log(`\n✅ Found ${images.length} images:\n`);

    images.forEach((img, idx) => {
      console.log(`Image ${idx + 1}:`);
      console.log(`  URL: ${img.url}`);
      console.log(`  Caption: ${img.caption}`);
      console.log(`  Attribution: ${img.attribution}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testImages();
