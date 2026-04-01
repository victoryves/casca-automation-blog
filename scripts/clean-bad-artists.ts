#!/usr/bin/env tsx

/**
 * Clean Bad Artists Script
 *
 * Removes non-person entities (events, exhibitions, institutions) from database
 * and resets daily email counter to allow new workflow execution.
 */

import { initDatabase, closeDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';

async function cleanBadArtists() {
  console.log('🧹 Cleaning bad artists from database...\n');

  initDatabase();

  try {
    // Patterns that indicate non-person entities
    const badPatterns = [
      'panorama',
      'bienal',
      'biennial',
      'exhibition',
      'exposição',
      'museum',
      'museu',
      'gallery',
      'galeria',
      'list of',
      'lista de',
      'under the lens',
      'gênero memória',
      'vera cruz um artista',
    ];

    let totalDeleted = 0;

    for (const pattern of badPatterns) {
      const artists = query.all<{ id: number; full_name: string }>(
        `SELECT id, full_name FROM artists WHERE LOWER(full_name) LIKE ?`,
        [`%${pattern.toLowerCase()}%`]
      );

      if (artists && artists.length > 0) {
        console.log(`  Found ${artists.length} artist(s) matching "${pattern}":`);
        artists.forEach(a => console.log(`    - ${a.full_name}`));

        // Delete sources first (foreign key constraint)
        for (const artist of artists) {
          query.run(`DELETE FROM sources WHERE artist_id = ?`, [artist.id]);
        }

        // Delete artists
        query.run(`DELETE FROM artists WHERE LOWER(full_name) LIKE ?`, [`%${pattern.toLowerCase()}%`]);
        console.log(`  ✓ Deleted ${artists.length} bad artist(s)\n`);
        totalDeleted += artists.length;
      }
    }

    console.log(`\n📊 Total cleaned: ${totalDeleted} bad artists removed`);

    // Reset today's email counter by deleting drafts from today
    console.log('\n🔄 Resetting daily email counter...');
    const today = new Date().toISOString().split('T')[0];

    const todayDrafts = query.all<{ id: number; title: string }>(
      `SELECT id, title FROM drafts WHERE created_at >= ? AND created_at <= ?`,
      [`${today}T00:00:00`, `${today}T23:59:59`]
    );

    if (todayDrafts.length > 0) {
      console.log(`  Found ${todayDrafts.length} draft(s) from today:`);
      todayDrafts.forEach(d => console.log(`    - ${d.title}`));

      query.run(
        `DELETE FROM drafts WHERE created_at >= ? AND created_at <= ?`,
        [`${today}T00:00:00`, `${today}T23:59:59`]
      );

      console.log(`  ✓ Deleted ${todayDrafts.length} draft(s) from today`);
    } else {
      console.log('  No drafts from today to delete');
    }

    console.log('\n✅ Database cleaned successfully!');
    console.log('📧 Daily email counter reset - ready for new workflow execution');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

cleanBadArtists();
