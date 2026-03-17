#!/usr/bin/env tsx

/**
 * Test Image Sourcing
 */

import { VisualModule } from '../src/modules/visual/index.js';
import { getConfig } from '../src/config/index.js';

const config = getConfig();
const visualModule = new VisualModule(config.env.anthropicApiKey);

async function testImages() {
  console.log('🖼️  Testing image sourcing for Cícero Dias...\n');

  try {
    const images = await visualModule.sourceImages(
      { full_name: 'Cícero Dias', visual_practice: 'pintura' },
      [],
      999,
      3
    );

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
