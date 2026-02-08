/**
 * Publishing Log Database Operations
 */

import { query } from '../client.js';
import type { PublishingLog } from '../../types/index.js';

export const publishingOps = {
  /**
   * Create a new publishing log entry
   */
  create(log: Omit<PublishingLog, 'id'>): number {
    const result = query.run(
      `INSERT INTO publishing_log (draft_id, medium_url, error_message)
       VALUES (?, ?, ?)`,
      [log.draft_id, log.medium_url ?? null, log.error_message ?? null]
    );
    return result.lastInsertRowid as number;
  },

  /**
   * Find log entry by ID
   */
  findById(id: number): PublishingLog | undefined {
    return query.get<PublishingLog>('SELECT * FROM publishing_log WHERE id = ?', [id]);
  },

  /**
   * Find all log entries for a draft
   */
  findByDraftId(draftId: number): PublishingLog[] {
    return query.all<PublishingLog>(
      'SELECT * FROM publishing_log WHERE draft_id = ? ORDER BY published_at DESC',
      [draftId]
    );
  },

  /**
   * Find latest log entry for a draft
   */
  findLatestByDraftId(draftId: number): PublishingLog | undefined {
    return query.get<PublishingLog>(
      'SELECT * FROM publishing_log WHERE draft_id = ? ORDER BY published_at DESC LIMIT 1',
      [draftId]
    );
  },

  /**
   * Check if draft was published successfully
   */
  isPublished(draftId: number): boolean {
    const result = query.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM publishing_log WHERE draft_id = ? AND medium_url IS NOT NULL',
      [draftId]
    );
    return (result?.count ?? 0) > 0;
  },

  /**
   * Get all failed publishing attempts
   */
  findFailed(): PublishingLog[] {
    return query.all<PublishingLog>(
      'SELECT * FROM publishing_log WHERE error_message IS NOT NULL ORDER BY published_at DESC'
    );
  },

  /**
   * Get all successful publishing attempts
   */
  findSuccessful(): PublishingLog[] {
    return query.all<PublishingLog>(
      'SELECT * FROM publishing_log WHERE medium_url IS NOT NULL ORDER BY published_at DESC'
    );
  },

  /**
   * Update Medium URL after publication
   */
  updateMediumUrl(id: number, mediumUrl: string): void {
    query.run('UPDATE publishing_log SET medium_url = ? WHERE id = ?', [mediumUrl, id]);
  },

  /**
   * Delete log entry
   */
  delete(id: number): void {
    query.run('DELETE FROM publishing_log WHERE id = ?', [id]);
  },
};
