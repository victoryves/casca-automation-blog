#!/usr/bin/env tsx

/**
 * Clean Bad Artists Script
 *
 * Removes non-person entities (events, exhibitions, institutions) from database
 * and resets daily email counter to allow new workflow execution.
 */

import { initDatabase, closeDatabase } from '../src/db/supabase.js';
import { getSupabase } from '../src/db/supabase.js';

async function cleanBadArtists() {
  console.log('🧹 Cleaning bad artists from database...\n');

  initDatabase();
  const supabase = getSupabase();

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
      const { data: artists, error: fetchError } = await supabase
        .from('artists')
        .select('id, full_name')
        .ilike('full_name', `%${pattern}%`);

      if (fetchError) {
        console.error(`  ✗ Error fetching ${pattern}:`, fetchError.message);
        continue;
      }

      if (artists && artists.length > 0) {
        console.log(`  Found ${artists.length} artist(s) matching "${pattern}":`);
        artists.forEach(a => console.log(`    - ${a.full_name}`));

        // Delete sources first (foreign key constraint)
        for (const artist of artists) {
          await supabase
            .from('sources')
            .delete()
            .eq('artist_id', artist.id);
        }

        // Delete artists
        const { error: deleteError } = await supabase
          .from('artists')
          .delete()
          .ilike('full_name', `%${pattern}%`);

        if (deleteError) {
          console.error(`  ✗ Error deleting ${pattern}:`, deleteError.message);
        } else {
          console.log(`  ✓ Deleted ${artists.length} bad artist(s)\n`);
          totalDeleted += artists.length;
        }
      }
    }

    console.log(`\n📊 Total cleaned: ${totalDeleted} bad artists removed`);

    // Reset today's email counter by deleting drafts from today
    console.log('\n🔄 Resetting daily email counter...');
    const today = new Date().toISOString().split('T')[0];

    const { data: todayDrafts, error: draftFetchError } = await supabase
      .from('drafts')
      .select('id, title')
      .gte('created_at', `${today}T00:00:00`)
      .lte('created_at', `${today}T23:59:59`);

    if (draftFetchError) {
      console.error('  ✗ Error fetching drafts:', draftFetchError.message);
    } else if (todayDrafts && todayDrafts.length > 0) {
      console.log(`  Found ${todayDrafts.length} draft(s) from today:`);
      todayDrafts.forEach(d => console.log(`    - ${d.title}`));

      const { error: deleteDraftsError } = await supabase
        .from('drafts')
        .delete()
        .gte('created_at', `${today}T00:00:00`)
        .lte('created_at', `${today}T23:59:59`);

      if (deleteDraftsError) {
        console.error('  ✗ Error deleting drafts:', deleteDraftsError.message);
      } else {
        console.log(`  ✓ Deleted ${todayDrafts.length} draft(s) from today`);
      }
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
