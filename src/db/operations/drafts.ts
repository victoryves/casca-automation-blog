/**
 * Draft Database Operations - Supabase
 */

import { getSupabase } from '../supabase.js';
import type { Draft, DraftStatus, Image } from '../../types/index.js';

export const draftOps = {
  /**
   * Create a new draft
   */
  async create(draft: Omit<Draft, 'id'>, images?: Image[]): Promise<number> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('drafts')
      .insert({
        artist_id: draft.artist_id,
        title: draft.title,
        subtitle: draft.subtitle ?? null,
        content: draft.content,
        images: images ? JSON.stringify(images) : null,
        status: draft.status ?? 'pending',
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to create draft: ${error.message}`);
    }

    return data.id;
  },

  /**
   * Find draft by ID
   */
  async findById(id: number): Promise<Draft | null> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('drafts')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find draft: ${error.message}`);
    }

    return data as Draft;
  },

  /**
   * Find all drafts for an artist
   */
  async findByArtistId(artistId: number): Promise<Draft[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('drafts')
      .select('*')
      .eq('artist_id', artistId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find drafts for artist: ${error.message}`);
    }

    return data as Draft[];
  },

  /**
   * Find drafts by status
   */
  async findByStatus(status: DraftStatus): Promise<Draft[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('drafts')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find drafts by status: ${error.message}`);
    }

    return data as Draft[];
  },

  /**
   * Get most recently sent draft
   */
  async findMostRecentSent(): Promise<Draft | null> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('drafts')
      .select('*')
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to find most recent sent draft: ${error.message}`);
    }

    return data as Draft | null;
  },

  /**
   * Check if email already sent today
   */
  async emailSentToday(): Promise<boolean> {
    const supabase = getSupabase();
    const today = new Date().toISOString().split('T')[0];

    const { count, error } = await supabase
      .from('drafts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('sent_at', `${today}T00:00:00.000Z`)
      .lt('sent_at', `${today}T23:59:59.999Z`);

    if (error) {
      throw new Error(`Failed to check if email sent today: ${error.message}`);
    }

    return (count ?? 0) > 0;
  },

  /**
   * Update draft status
   */
  async updateStatus(id: number, status: DraftStatus): Promise<void> {
    const supabase = getSupabase();

    const updates: any = { status };

    if (status === 'sent') {
      updates.sent_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('drafts')
      .update(updates)
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to update draft status: ${error.message}`);
    }
  },

  /**
   * Update draft images
   */
  async updateImages(id: number, images: Image[]): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('drafts')
      .update({ images: JSON.stringify(images) })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to update draft images: ${error.message}`);
    }
  },

  /**
   * Get draft with images parsed
   */
  async findByIdWithImages(id: number): Promise<(Draft & { parsedImages: Image[] }) | null> {
    const draft = await this.findById(id);
    if (!draft) return null;

    return {
      ...draft,
      parsedImages: draft.images ? (JSON.parse(draft.images) as Image[]) : [],
    };
  },

  /**
   * Delete draft
   */
  async delete(id: number): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('drafts')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete draft: ${error.message}`);
    }
  },

  /**
   * Count drafts by status
   */
  async countByStatus(status: DraftStatus): Promise<number> {
    const supabase = getSupabase();

    const { count, error } = await supabase
      .from('drafts')
      .select('*', { count: 'exact', head: true })
      .eq('status', status);

    if (error) {
      throw new Error(`Failed to count drafts: ${error.message}`);
    }

    return count ?? 0;
  },
};
