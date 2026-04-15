/**
 * Draft Database Operations - SQLite
 */

import { query } from '../client.js';
import type { Draft, DraftStatus, Image } from '../../types/index.js';
import { getConfig } from '../../config/index.js';

export const draftOps = {
  /**
   * Create a new draft
   */
  async create(draft: Omit<Draft, 'id'>, images?: Image[]): Promise<number> {
    const existingPendingDraft = query.get<{ id: number }>(
      `SELECT id
       FROM drafts
       WHERE artist_id = ? AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [draft.artist_id]
    );

    if (existingPendingDraft?.id) {
      return existingPendingDraft.id;
    }

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

    return Number(result.lastInsertRowid);
  },

  /**
   * Find draft by ID
   */
  async findById(id: number): Promise<Draft | null> {
    const row = query.get<Draft>(`SELECT * FROM drafts WHERE id = ?`, [id]);
    return row ?? null;
  },

  /**
   * Find all drafts for an artist
   */
  async findByArtistId(artistId: number): Promise<Draft[]> {
    return query.all<Draft>(
      `SELECT * FROM drafts WHERE artist_id = ? ORDER BY created_at DESC`,
      [artistId]
    );
  },

  /**
   * Find drafts by status
   */
  async findByStatus(status: DraftStatus): Promise<Draft[]> {
    return query.all<Draft>(
      `SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC`,
      [status]
    );
  },

  /**
   * Get most recently sent draft
   */
  async findMostRecentSent(): Promise<Draft | null> {
    const row = query.get<Draft>(
      `SELECT * FROM drafts WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1`
    );
    return row ?? null;
  },

  async findReadyPending(minImages = 3): Promise<(Draft & { parsedImages: Image[] }) | null> {
    const readyDrafts = await this.findReadyPendingDrafts(minImages);
    return readyDrafts[0] ?? null;
  },

  async findReadyPendingDrafts(minImages = 3): Promise<Array<Draft & { parsedImages: Image[] }>> {
    const pendingDrafts = await this.findByStatus('pending');
    const readyDrafts: Array<Draft & { parsedImages: Image[] }> = [];

    for (const draft of pendingDrafts) {
      const parsedImages = draft.images ? (JSON.parse(draft.images) as Image[]) : [];
      if (parsedImages.length >= minImages) {
        readyDrafts.push({
          ...draft,
          parsedImages,
        });
      }
    }

    return readyDrafts.sort((a, b) => {
      const aTime = new Date(a.created_at ?? 0).getTime();
      const bTime = new Date(b.created_at ?? 0).getTime();
      return aTime - bTime;
    });
  },

  async findHydratablePendingDrafts(
    minImages = 3
  ): Promise<Array<Draft & { parsedImages: Image[] }>> {
    const pendingDrafts = await this.findByStatus('pending');
    const hydratableDrafts: Array<Draft & { parsedImages: Image[] }> = [];

    for (const draft of pendingDrafts) {
      const parsedImages = draft.images ? (JSON.parse(draft.images) as Image[]) : [];
      if (parsedImages.length < minImages) {
        hydratableDrafts.push({
          ...draft,
          parsedImages,
        });
      }
    }

    return hydratableDrafts.sort((a, b) => {
      const aTime = new Date(a.created_at ?? 0).getTime();
      const bTime = new Date(b.created_at ?? 0).getTime();
      return bTime - aTime;
    });
  },

  async countReadyPending(minImages = 3): Promise<number> {
    const readyDrafts = await this.findReadyPendingDrafts(minImages);
    return readyDrafts.length;
  },

  async countCreatedOnDate(workflowDate: string, timeZone?: string): Promise<number> {
    const resolvedTimeZone =
      timeZone ||
      getConfig().env.appTimezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      'UTC';
    const rows = query.all<{ created_at: string | null }>(
      `SELECT created_at
       FROM drafts
       WHERE created_at IS NOT NULL
       ORDER BY created_at DESC`
    );

    return rows.filter((draft) => {
      if (!draft.created_at) return false;
      return this.formatDateInTimezone(this.parseTimestamp(draft.created_at), resolvedTimeZone) === workflowDate;
    }).length;
  },

  /**
   * Check if email already sent today
   */
  async emailSentToday(): Promise<boolean> {
    const timezone =
      getConfig().env.appTimezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      'UTC';
    const now = new Date();
    const today = this.formatDateInTimezone(now, timezone);
    const lookback = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();

    const rows = query.all<{ sent_at: string | null }>(
      `SELECT sent_at
       FROM drafts
       WHERE status IN ('sent', 'approved') AND sent_at >= ?
       ORDER BY sent_at DESC
       LIMIT 50`,
      [lookback]
    );

    return rows.some((draft) => {
      if (!draft.sent_at) return false;
      return this.formatDateInTimezone(this.parseTimestamp(draft.sent_at), timezone) === today;
    });
  },

  /**
   * Update draft status
   */
  async updateStatus(id: number, status: DraftStatus): Promise<void> {
    if (status === 'sent') {
      query.run(`UPDATE drafts SET status = ?, sent_at = ? WHERE id = ?`, [
        status,
        new Date().toISOString(),
        id,
      ]);
      return;
    }

    query.run(`UPDATE drafts SET status = ? WHERE id = ?`, [status, id]);
  },

  /**
   * Update draft images
   */
  async updateImages(id: number, images: Image[]): Promise<void> {
    query.run(`UPDATE drafts SET images = ? WHERE id = ?`, [JSON.stringify(images), id]);
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
    query.run(`DELETE FROM drafts WHERE id = ?`, [id]);
  },

  /**
   * Count drafts by status
   */
  async countByStatus(status: DraftStatus): Promise<number> {
    const row = query.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM drafts WHERE status = ?`,
      [status]
    );
    return row?.count ?? 0;
  },

  formatDateInTimezone(date: Date, timeZone: string): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    return formatter.format(date);
  },

  parseTimestamp(value: string): Date {
    const normalized = /z$/i.test(value) || /[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
    return new Date(normalized);
  },
};
