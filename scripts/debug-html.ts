#!/usr/bin/env tsx

import { marked } from 'marked';
import { initDatabase, closeDatabase } from '../src/db/client.js';
import { draftOps } from '../src/db/operations/index.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig();

initDatabase({
  path: config.env.databasePath,
});

const draft = draftOps.findById(16);

if (draft) {
  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  const contentHtml = await marked(draft.content);

  console.log('=== RAW MARKDOWN ===');
  console.log(draft.content.substring(0, 500));

  console.log('\n\n=== HTML OUTPUT ===');
  console.log(contentHtml.substring(0, 1000));

  console.log('\n\n=== PARAGRAPHS ===');
  const parts = contentHtml.split(/(<\/p>)/gi);
  console.log(`Found ${parts.length} parts`);

  for (let i = 0; i < Math.min(parts.length, 10); i++) {
    console.log(`Part ${i}: ${parts[i].substring(0, 100)}...`);
  }
}

closeDatabase();
