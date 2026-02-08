/**
 * Publishing Log Database Operations - Supabase
 */

import { getSupabase } from '../supabase.js';
import type { PublishingLog } from '../../types/index.js';

export const publishingOps = {
  /**
   * Create a new publishing log entry
   */
  async create(log: Omit<PublishingLog, 'id'>): Promise<number> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('publishing_log')
      .insert({
        draft_id: log.draft_id,
        medium_url: log.medium_url ?? null,
        error_message: log.error_message ?? null,
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to create publishing log: ${error.message}`);
    }

    return data.id;
  },

  /**
   * Find log entry by ID
   */
  async findById(id: number): Promise<PublishingLog | null> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('publishing_log')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find publishing log: ${error.message}`);
    }

    return data as PublishingLog;
  },

  /**
   * Find all log entries for a draft
   */
  async findByDraftId(draftId: number): Promise<PublishingLog[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('publishing_log')
      .select('*')
      .eq('draft_id', draftId)
      .order('published_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find publishing logs for draft: ${error.message}`);
    }

    return data as PublishingLog[];
  },

  /**
   * Find latest log entry for a draft
   */
  async findLatestByDraftId(draftId: number): Promise<PublishingLog | null> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('publishing_log')
      .select('*')
      .eq('draft_id', draftId)
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to find latest publishing log: ${error.message}`);
    }

    return data as PublishingLog | null;
  },

  /**
   * Check if draft was published successfully
   */
  async isPublished(draftId: number): Promise<boolean> {
    const supabase = getSupabase();

    const { count, error } = await supabase
      .from('publishing_log')
      .select('*', { count: 'exact', head: true })
      .eq('draft_id', draftId)
      .not('medium_url', 'is', null);

    if (error) {
      throw new Error(`Failed to check if published: ${error.message}`);
    }

    return (count ?? 0) > 0;
  },

  /**
   * Get all failed publishing attempts
   */
  async findFailed(): Promise<PublishingLog[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('publishing_log')
      .select('*')
      .not('error_message', 'is', null)
      .order('published_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find failed publishing attempts: ${error.message}`);
    }

    return data as PublishingLog[];
  },

  /**
   * Get all successful publishing attempts
   */
  async findSuccessful(): Promise<PublishingLog[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('publishing_log')
      .select('*')
      .not('medium_url', 'is', null)
      .order('published_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find successful publishing attempts: ${error.message}`);
    }

    return data as PublishingLog[];
  },

  /**
   * Update Medium URL after publication
   */
  async updateMediumUrl(id: number, mediumUrl: string): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('publishing_log')
      .update({ medium_url: mediumUrl })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to update Medium URL: ${error.message}`);
    }
  },

  /**
   * Delete log entry
   */
  async delete(id: number): Promise<void> {
    const supabase = getSupabase();

    const { error } = await supabase
      .from('publishing_log')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete publishing log: ${error.message}`);
    }
  },
};
