/**
 * Source Database Operations - Supabase
 */

import { getSupabase } from '../supabase.js';
import type { Source } from '../../types/index.js';

export const sourceOps = {
  /**
   * Create a new source
   */
  async create(source: Omit<Source, 'id'>): Promise<number> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('sources')
      .insert({
        artist_id: source.artist_id,
        url: source.url,
        institution: source.institution,
        credibility_score: source.credibility_score ?? 1.0,
        content_summary: source.content_summary ?? null,
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to create source: ${error.message}`);
    }

    return data.id;
  },

  /**
   * Find source by ID
   */
  async findById(id: number): Promise<Source | null> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('sources')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find source: ${error.message}`);
    }

    return data as Source;
  },

  /**
   * Find all sources for an artist
   */
  async findByArtistId(artistId: number): Promise<Source[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('sources')
      .select('*')
      .eq('artist_id', artistId)
      .order('credibility_score', { ascending: false });

    if (error) {
      throw new Error(`Failed to find sources for artist: ${error.message}`);
    }

    return data as Source[];
  },

  /**
   * Find source by URL
   */
  async findByUrl(url: string): Promise<Source | null> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('sources')
      .select('*')
      .eq('url', url)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to find source by URL: ${error.message}`);
    }

    return data as Source | null;
  },

  /**
   * Check if source exists for artist
   */
  async exists(artistId: number, url: string): Promise<boolean> {
    const supabase = getSupabase();

    const { count, error } = await supabase
      .from('sources')
      .select('*', { count: 'exact', head: true })
      .eq('artist_id', artistId)
      .eq('url', url);

    if (error) {
      throw new Error(`Failed to check source existence: ${error.message}`);
    }

    return (count ?? 0) > 0;
  },

  /**
   * Get sources with minimum credibility
   */
  async findByMinCredibility(artistId: number, minScore: number): Promise<Source[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('sources')
      .select('*')
      .eq('artist_id', artistId)
      .gte('credibility_score', minScore)
      .order('credibility_score', { ascending: false });

    if (error) {
      throw new Error(`Failed to find sources by credibility: ${error.message}`);
    }

    return data as Source[];
  },

  /**
   * Count sources for artist
   */
  async countForArtist(artistId: number): Promise<number> {
    const supabase = getSupabase();

    const { count, error } = await supabase
      .from('sources')
      .select('*', { count: 'exact', head: true })
      .eq('artist_id', artistId);

    if (error) {
      throw new Error(`Failed to count sources: ${error.message}`);
    }

    return count ?? 0;
  },

  /**
   * Update source credibility score
   */
  async updateCredibility(id: number, score: number): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('sources')
      .update({ credibility_score: score })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to update source credibility: ${error.message}`);
    }
  },

  /**
   * Delete source
   */
  async delete(id: number): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('sources')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete source: ${error.message}`);
    }
  },

  /**
   * Delete all sources for artist
   */
  async deleteByArtistId(artistId: number): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('sources')
      .delete()
      .eq('artist_id', artistId);

    if (error) {
      throw new Error(`Failed to delete sources for artist: ${error.message}`);
    }
  },
};
