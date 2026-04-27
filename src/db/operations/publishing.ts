/**
 * Publishing Log Database Operations - SQLite
 */

import { query } from '../client.js';
import type { PublishingLog } from '../../types/index.js';

export const publishingOps = {
  /**
   * Create a new publishing log entry
   */
  async create(log: Omit<PublishingLog, 'id'>): Promise<number> {
    const result = query.run(
      `INSERT INTO publishing_log (draft_id, medium_url, error_message)
       VALUES (?, ?, ?)`,
      [log.draft_id, log.medium_url ?? null, log.error_message ?? null]
    );

    return Number(result.lastInsertRowid);
  },

  /**
   * Find log entry by ID
   */
  async findById(id: number): Promise<PublishingLog | null> {
    const row = query.get<PublishingLog>(`SELECT * FROM publishing_log WHERE id = ?`, [id]);
    return row ?? null;
  },

  /**
   * Find all log entries for a draft
   */
  async findByDraftId(draftId: number): Promise<PublishingLog[]> {
    return query.all<PublishingLog>(
      `SELECT * FROM publishing_log WHERE draft_id = ? ORDER BY published_at DESC`,
      [draftId]
    );
  },

  /**
   * Find latest log entry for a draft
   */
  async findLatestByDraftId(draftId: number): Promise<PublishingLog | null> {
    const row = query.get<PublishingLog>(
      `SELECT * FROM publishing_log WHERE draft_id = ? ORDER BY published_at DESC LIMIT 1`,
      [draftId]
    );
    return row ?? null;
  },

  /**
   * Check if draft was published successfully
   */
  async isPublished(draftId: number): Promise<boolean> {
    const row = query.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM publishing_log WHERE draft_id = ? AND medium_url IS NOT NULL`,
      [draftId]
    );
    return (row?.count ?? 0) > 0;
  },

  async publishedOnDate(workflowDate: string, timeZone = 'UTC'): Promise<boolean> {
    const rows = query.all<{ published_at: string | null }>(
      `SELECT published_at
       FROM publishing_log
       WHERE medium_url IS NOT NULL AND published_at IS NOT NULL
       ORDER BY published_at DESC`
    );

    return rows.some((row) => {
      if (!row.published_at) return false;
      const normalized =
        /z$/i.test(row.published_at) || /[+-]\d{2}:\d{2}$/.test(row.published_at)
          ? row.published_at
          : `${row.published_at}Z`;
      const date = new Date(normalized);
      const formatted = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
      return formatted === workflowDate;
    });
  },

  /**
   * Get all failed publishing attempts
   */
  async findFailed(): Promise<PublishingLog[]> {
    return query.all<PublishingLog>(
      `SELECT * FROM publishing_log WHERE medium_url IS NULL AND error_message IS NOT NULL ORDER BY published_at DESC`
    );
  },

  /**
   * Count publishing logs by status
   */
  async countFailed(): Promise<number> {
    const row = query.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM publishing_log WHERE medium_url IS NULL AND error_message IS NOT NULL`
    );
    return row?.count ?? 0;
  },

  /**
   * Update log entry URL
   */
  async updateUrl(id: number, url: string): Promise<void> {
    query.run(`UPDATE publishing_log SET medium_url = ? WHERE id = ?`, [url, id]);
  },

  /**
   * Update log entry error
   */
  async updateError(id: number, errorMessage: string): Promise<void> {
    query.run(`UPDATE publishing_log SET error_message = ? WHERE id = ?`, [errorMessage, id]);
  },

  /**
   * Delete log entry
   */
  async delete(id: number): Promise<void> {
    query.run(`DELETE FROM publishing_log WHERE id = ?`, [id]);
  },
};
