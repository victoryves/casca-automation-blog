#!/usr/bin/env tsx

/**
 * Add Test Artist
 *
 * Adds Cícero Dias (famous artist from Pernambuco) to test the full workflow.
 */

import { initDatabase, closeDatabase } from '../src/db/client.js';
import { artistOps, sourceOps } from '../src/db/operations/index.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig();

initDatabase({
  path: config.env.databasePath,
});

// Add Cícero Dias - famous artist from Pernambuco
const artistId = artistOps.create({
  full_name: 'Cícero Dias',
  birthplace_city: 'Escada',
  birthplace_state: 'Pernambuco',
  visual_practice: 'painting',
  status: 'verified',
  metadata: JSON.stringify({
    note: 'Test artist - manually added',
    birth_year: '1907',
    death_year: '2003',
  }),
});

console.log(`✓ Artist created: Cícero Dias (ID: ${artistId})`);

// Add sources
sourceOps.create({
  artist_id: artistId,
  url: 'https://masp.org.br/acervo/obra/paisagem',
  institution: 'Museu de Arte de São Paulo (MASP)',
  credibility_score: 1.0,
  content_summary: 'Cícero Dias (1907-2003) was a Brazilian painter born in Escada, Pernambuco. Known for his surrealist and abstract works, he was one of the pioneers of modernism in Brazil. His work "Eu vi o mundo... ele começava no Recife" is considered a masterpiece of Brazilian modernist painting.',
});

sourceOps.create({
  artist_id: artistId,
  url: 'https://pinacoteca.org.br/acervo/cicero-dias',
  institution: 'Pinacoteca de São Paulo',
  credibility_score: 1.0,
  content_summary: 'Cícero Dias was a prominent visual artist from Pernambuco who spent much of his career in Paris. His work combines Brazilian folklore with European modernism. He was friends with Pablo Picasso and participated in the 1922 Week of Modern Art movement.',
});

console.log(`✓ Added 2 sources for Cícero Dias`);
console.log(`\n✅ Test artist ready for workflow!`);

closeDatabase();
