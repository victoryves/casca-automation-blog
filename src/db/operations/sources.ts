/**
 * Source Database Operations - SQLite
 */

import { query } from '../client.js';
import type { Source } from '../../types/index.js';

export const sourceOps = {
  /**
   * Create a new source
   */
  async create(source: Omit<Source, 'id'>): Promise<number> {
    const result = query.run(
      `INSERT INTO sources (artist_id, url, institution, credibility_score, content_summary)
       VALUES (?, ?, ?, ?, ?)`,
      [
        source.artist_id,
        source.url,
        source.institution,
        source.credibility_score ?? 1.0,
        source.content_summary ?? null,
      ]
    );

    return Number(result.lastInsertRowid);
  },

  /**
   * Find source by ID
   */
  async findById(id: number): Promise<Source | null> {
    const row = query.get<Source>(`SELECT * FROM sources WHERE id = ?`, [id]);
    return row ?? null;
  },

  /**
   * Find all sources for an artist
   */
  async findByArtistId(artistId: number): Promise<Source[]> {
    return query.all<Source>(
      `SELECT * FROM sources WHERE artist_id = ? ORDER BY credibility_score DESC`,
      [artistId]
    );
  },

  /**
   * Find source by URL
   */
  async findByUrl(url: string): Promise<Source | null> {
    const row = query.get<Source>(`SELECT * FROM sources WHERE url = ?`, [url]);
    return row ?? null;
  },

  /**
   * Check if source exists for artist
   */
  async exists(artistId: number, url: string): Promise<boolean> {
    const row = query.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM sources WHERE artist_id = ? AND url = ?`,
      [artistId, url]
    );
    return (row?.count ?? 0) > 0;
  },

  /**
   * Get sources with minimum credibility
   */
  async findByMinCredibility(artistId: number, minScore: number): Promise<Source[]> {
    return query.all<Source>(
      `SELECT * FROM sources WHERE artist_id = ? AND credibility_score >= ? ORDER BY credibility_score DESC`,
      [artistId, minScore]
    );
  },

  /**
   * Count sources for artist
   */
  async countForArtist(artistId: number): Promise<number> {
    const row = query.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM sources WHERE artist_id = ?`,
      [artistId]
    );
    return row?.count ?? 0;
  },

  /**
   * Update source credibility score
   */
  async updateCredibility(id: number, score: number): Promise<void> {
    query.run(`UPDATE sources SET credibility_score = ? WHERE id = ?`, [score, id]);
  },

  /**
   * Update source content summary
   */
  async updateContentSummary(id: number, content: string): Promise<void> {
    query.run(`UPDATE sources SET content_summary = ? WHERE id = ?`, [content, id]);
  },

  /**
   * Delete source
   */
  async delete(id: number): Promise<void> {
    query.run(`DELETE FROM sources WHERE id = ?`, [id]);
  },

  /**
   * Delete all sources for artist
   */
  async deleteForArtist(artistId: number): Promise<void> {
    query.run(`DELETE FROM sources WHERE artist_id = ?`, [artistId]);
  },
};
