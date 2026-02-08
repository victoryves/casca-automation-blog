#!/usr/bin/env tsx

import { initDatabase, closeDatabase } from '../src/db/supabase.js';
import { draftOps, artistOps, sourceOps } from '../src/db/operations/index.js';
import { loadConfig } from '../src/config/index.js';
import { marked } from 'marked';
import fs from 'fs';

const config = loadConfig();

initDatabase({
  path: config.env.databasePath,
});

const draft = draftOps.findById(16);

if (draft) {
  const artist = artistOps.findById(draft.artist_id);
  const sources = sourceOps.findByArtistId(draft.artist_id);

  console.log('Sources found:', sources?.length || 0);

  if (sources && sources.length > 0) {
    sources.forEach((s, i) => {
      console.log(`  ${i + 1}: ${s.institution} - ${s.url}`);
    });
  }

  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  let contentHtml = await marked(draft.content);

  console.log('\n=== BEFORE SOURCES INSERTION ===');
  console.log('Has Keywords:', contentHtml.toLowerCase().includes('keywords'));
  console.log('Content length:', contentHtml.length);

  // Insert sources before Keywords
  if (sources && sources.length > 0) {
    const sourcesHtml = `
<p style="margin: 2.5em 0; line-height: 1.4; text-align: justify; font-family: 'Courier New', Courier, monospace !important;"><strong>Fontes:</strong></p>
${sources
  .map(
    (source, index) => `
<p style="margin: 2.5em 0; line-height: 1.4; text-align: justify; font-family: 'Courier New', Courier, monospace !important;">
(${index + 1}) ${source.institution || 'Source'} - <a href="${source.url}" style="color: #667eea; text-decoration: underline;">${source.url}</a>
</p>`
  )
  .join('')}
`;

    const hasKeywords = contentHtml.toLowerCase().includes('keywords');
    console.log('\n=== INSERTING SOURCES ===');
    console.log('Keywords found:', hasKeywords);

    if (hasKeywords) {
      const patterns = [
        /(<p[^>]*>.*?<strong>Keywords:<\/strong>.*?<\/p>)/is,
        /(<p[^>]*>.*?Keywords:.*?<\/p>)/is,
        /(Keywords:.*?<br>)/is
      ];

      let replaced = false;
      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        if (pattern.test(contentHtml)) {
          console.log(`Pattern ${i + 1} matched!`);
          contentHtml = contentHtml.replace(pattern, sourcesHtml + '\n$1');
          replaced = true;
          break;
        } else {
          console.log(`Pattern ${i + 1} did not match`);
        }
      }

      if (!replaced) {
        console.log('⚠ Keywords found but no pattern matched, appending at end');
        contentHtml += sourcesHtml;
      }
    } else {
      console.log('⚠ No Keywords found, appending at end');
      contentHtml += sourcesHtml;
    }
  }

  console.log('\n=== AFTER SOURCES INSERTION ===');
  console.log('Content length:', contentHtml.length);
  console.log('Has "Fontes":', contentHtml.includes('Fontes'));

  // Find and show the Keywords section
  const keywordsMatch = contentHtml.match(/.{0,200}Keywords.{0,200}/is);
  if (keywordsMatch) {
    console.log('\n=== KEYWORDS CONTEXT ===');
    console.log(keywordsMatch[0]);
  }

  // Find and show the Fontes section
  const fontesMatch = contentHtml.match(/.{0,100}Fontes.{0,300}/is);
  if (fontesMatch) {
    console.log('\n=== FONTES CONTEXT ===');
    console.log(fontesMatch[0]);
  }

  // Save to file for inspection
  fs.writeFileSync('/tmp/email-debug.html', contentHtml);
  console.log('\n✓ Full HTML saved to /tmp/email-debug.html');
}

closeDatabase();
