/**
 * Artist Database Operations - Supabase
 */

import { getSupabase } from '../supabase.js';
import type { Artist, ArtistStatus } from '../../types/index.js';

export const artistOps = {
  /**
   * Create a new artist
   */
  async create(artist: Omit<Artist, 'id'>): Promise<number> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('artists')
      .insert({
        full_name: artist.full_name,
        birthplace_city: artist.birthplace_city ?? null,
        birthplace_state: artist.birthplace_state ?? null,
        visual_practice: artist.visual_practice ?? null,
        status: artist.status ?? 'discovered',
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to create artist: ${error.message}`);
    }

    return data.id;
  },

  /**
   * Find artist by ID
   */
  async findById(id: number): Promise<Artist | null> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('artists')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Not found
        return null;
      }
      throw new Error(`Failed to find artist: ${error.message}`);
    }

    return data as Artist;
  },

  /**
   * Find artist by name and city
   */
  async findByNameAndCity(fullName: string, city?: string): Promise<Artist | null> {
    const supabase = getSupabase();

    let query = supabase
      .from('artists')
      .select('*')
      .eq('full_name', fullName);

    if (city) {
      query = query.eq('birthplace_city', city);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      throw new Error(`Failed to find artist: ${error.message}`);
    }

    return data as Artist | null;
  },

  /**
   * Get all artists by status
   */
  async findByStatus(status: ArtistStatus): Promise<Artist[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('artists')
      .select('*')
      .eq('status', status)
      .order('discovered_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find artists by status: ${error.message}`);
    }

    return data as Artist[];
  },

  /**
   * Get verified but unpublished artists
   */
  async findVerifiedUnpublished(): Promise<Artist[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('artists')
      .select('*')
      .eq('status', 'verified')
      .order('discovered_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find verified artists: ${error.message}`);
    }

    return data as Artist[];
  },

  /**
   * Update artist status
   */
  async updateStatus(id: number, status: ArtistStatus): Promise<void> {
    const supabase = getSupabase();

    const updates: any = { status };

    if (status === 'published') {
      updates.published_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('artists')
      .update(updates)
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to update artist status: ${error.message}`);
    }
  },

  /**
   * Update artist metadata JSON
   */
  async updateMetadata(id: number, metadata: Record<string, unknown> | null): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('artists')
      .update({ metadata: metadata ? JSON.stringify(metadata) : null })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to update artist metadata: ${error.message}`);
    }
  },

  /**
   * Delete artist
   */
  async delete(id: number): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('artists')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete artist: ${error.message}`);
    }
  },

  /**
   * Get all artists
   */
  async findAll(): Promise<Artist[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('artists')
      .select('*')
      .order('discovered_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find all artists: ${error.message}`);
    }

    return data as Artist[];
  },

  /**
   * Count artists by status
   */
  async countByStatus(status: ArtistStatus): Promise<number> {
    const supabase = getSupabase();

    const { count, error } = await supabase
      .from('artists')
      .select('*', { count: 'exact', head: true })
      .eq('status', status);

    if (error) {
      throw new Error(`Failed to count artists: ${error.message}`);
    }

    return count ?? 0;
  },
};
