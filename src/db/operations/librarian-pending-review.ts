import { query } from '../client.js';
import type { LibrarianPendingReviewEntry } from '../../types/index.js';

export const librarianPendingReviewOps = {
  async upsert(
    entry: Omit<LibrarianPendingReviewEntry, 'id' | 'created_at' | 'updated_at'>
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.findByUrl(entry.url);
    const shouldPreserveExisting =
      existing &&
      (existing.confidence > entry.confidence ||
        (existing.confidence === entry.confidence &&
          existing.resolved_name.trim().length < entry.resolved_name.trim().length));

    const resolvedName = shouldPreserveExisting ? existing.resolved_name : entry.resolved_name;
    const normalizedResolvedName = shouldPreserveExisting
      ? existing.normalized_resolved_name
      : entry.normalized_resolved_name;
    const confidence = shouldPreserveExisting ? existing.confidence : entry.confidence;
    const reasoning = shouldPreserveExisting
      ? existing.reasoning ?? entry.reasoning ?? null
      : entry.reasoning ?? null;
    const description = shouldPreserveExisting
      ? existing.description ?? entry.description ?? null
      : entry.description ?? null;
    const content = shouldPreserveExisting
      ? existing.content ?? entry.content ?? null
      : entry.content ?? null;

    query.run(
      `INSERT INTO librarian_pending_review (
        original_title,
        resolved_name,
        normalized_resolved_name,
        confidence,
        reasoning,
        url,
        description,
        content,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        original_title = excluded.original_title,
        resolved_name = excluded.resolved_name,
        normalized_resolved_name = excluded.normalized_resolved_name,
        confidence = excluded.confidence,
        reasoning = excluded.reasoning,
        description = excluded.description,
        content = excluded.content,
        updated_at = excluded.updated_at`,
      [
        entry.original_title,
        resolvedName,
        normalizedResolvedName,
        confidence,
        reasoning,
        entry.url,
        description,
        content,
        now,
        now,
      ]
    );
  },

  async findAll(): Promise<LibrarianPendingReviewEntry[]> {
    return query.all<LibrarianPendingReviewEntry>(
      `SELECT *
       FROM librarian_pending_review
       ORDER BY confidence ASC, datetime(updated_at) DESC, datetime(created_at) DESC`
    );
  },

  async findById(id: number): Promise<LibrarianPendingReviewEntry | null> {
    const row = query.get<LibrarianPendingReviewEntry>(
      `SELECT * FROM librarian_pending_review WHERE id = ? LIMIT 1`,
      [id]
    );
    return row ?? null;
  },

  async findByUrl(url: string): Promise<LibrarianPendingReviewEntry | null> {
    const row = query.get<LibrarianPendingReviewEntry>(
      `SELECT * FROM librarian_pending_review WHERE url = ? LIMIT 1`,
      [url]
    );
    return row ?? null;
  },

  async delete(id: number): Promise<void> {
    query.run(`DELETE FROM librarian_pending_review WHERE id = ?`, [id]);
  },

  async getNormalizedNames(): Promise<Set<string>> {
    const rows = query.all<{ normalized_resolved_name: string }>(
      `SELECT normalized_resolved_name FROM librarian_pending_review`
    );
    return new Set(rows.map((row) => row.normalized_resolved_name).filter(Boolean));
  },
};
