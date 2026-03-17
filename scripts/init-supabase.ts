#!/usr/bin/env tsx

/**
 * Initialize Supabase tables via REST API
 * Executes SQL statements one at a time using the rpc endpoint
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

async function main() {
  // First test: can we reach the DB?
  console.log('Testing connection...');
  const { data, error } = await supabase.from('artists').select('id').limit(1);

  if (error) {
    if (error.code === '42P01') {
      // Table doesn't exist - this is expected
      console.log('Tables do not exist yet. Please create them via the Supabase SQL Editor.');
      console.log('\nSQL to execute:');
      console.log('================');

      const fs = await import('fs');
      const schema = fs.readFileSync('./supabase-schema.sql', 'utf-8');
      console.log(schema);

      console.log('\n================');
      console.log('Go to: https://supabase.com/dashboard/project/mrlsngxobwpreqlwwemi/sql');
      console.log('Paste the SQL above and click "Run"');
    } else {
      console.log('Connection error:', error.message, `(code: ${error.code})`);
    }
  } else {
    console.log('✅ Connection works! Artists table exists.');
    console.log('Found', data?.length ?? 0, 'artist(s)');
  }
}

main().catch(console.error);
