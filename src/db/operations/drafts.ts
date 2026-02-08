/**
 * Draft Database Operations
 */

import { query } from '../client.js';
import type { Draft, DraftStatus, Image } from '../../types/index.js';

export const draftOps = {
  /**
   * Create a new draft
   */
  create(draft: Omit<Draft, 'id'>, images?: Image[]): number {
    const result = query.run(
      `INSERT INTO drafts (artist_id, title, subtitle, content, images, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        draft.artist_id,
        draft.title,
        draft.subtitle ?? null,
        draft.content,
        images ? JSON.stringify(images) : null,
        draft.status ?? 'pending',
      ]
    );
    return result.lastInsertRowid as number;
  },

  /**
   * Find draft by ID
   */
  findById(id: number): Draft | undefined {
    return query.get<Draft>('SELECT * FROM drafts WHERE id = ?', [id]);
  },

  /**
   * Find all drafts for an artist
   */
  findByArtistId(artistId: number): Draft[] {
    return query.all<Draft>('SELECT * FROM drafts WHERE artist_id = ? ORDER BY created_at DESC', [
      artistId,
    ]);
  },

  /**
   * Find drafts by status
   */
  findByStatus(status: DraftStatus): Draft[] {
    return query.all<Draft>('SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC', [
      status,
    ]);
  },

  /**
   * Get most recently sent draft
   */
  findMostRecentSent(): Draft | undefined {
    return query.get<Draft>(
      "SELECT * FROM drafts WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1"
    );
  },

  /**
   * Check if email already sent today
   */
  emailSentToday(): boolean {
    const today = new Date().toISOString().split('T')[0];
    const result = query.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM drafts WHERE status = 'sent' AND DATE(sent_at) = ?",
      [today]
    );
    return (result?.count ?? 0) > 0;
  },

  /**
   * Update draft status
   */
  updateStatus(id: number, status: DraftStatus): void {
    const updates: Record<string, string | null> = { status };

    if (status === 'sent') {
      updates.sent_at = new Date().toISOString();
    }

    const setClauses = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(', ');
    const values = [...Object.values(updates), id];

    query.run(`UPDATE drafts SET ${setClauses} WHERE id = ?`, values);
  },

  /**
   * Update draft images
   */
  updateImages(id: number, images: Image[]): void {
    const imagesJson = JSON.stringify(images);
    query.run('UPDATE drafts SET images = ? WHERE id = ?', [imagesJson, id]);
  },

  /**
   * Get draft with images parsed
   */
  findByIdWithImages(id: number): (Draft & { parsedImages: Image[] }) | undefined {
    const draft = query.get<Draft>('SELECT * FROM drafts WHERE id = ?', [id]);
    if (!draft) return undefined;

    return {
      ...draft,
      parsedImages: draft.images ? (JSON.parse(draft.images) as Image[]) : [],
    };
  },

  /**
   * Delete draft
   */
  delete(id: number): void {
    query.run('DELETE FROM drafts WHERE id = ?', [id]);
  },

  /**
   * Count drafts by status
   */
  countByStatus(status: DraftStatus): number {
    const result = query.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM drafts WHERE status = ?',
      [status]
    );
    return result?.count ?? 0;
  },
};
