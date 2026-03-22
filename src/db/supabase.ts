/**
 * Supabase Client
 *
 * PostgreSQL database client for serverless deployment
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_KEY environment variables.');
    }

    supabase = createClient(supabaseUrl, supabaseKey);
  }

  return supabase;
}

export function initDatabase() {
  // Initialize the Supabase client
  getSupabase();
  console.log('✓ Supabase client initialized');
}

export function closeDatabase() {
  // Supabase client doesn't need explicit closing
  // Connection pooling is handled automatically
  supabase = null;
}
