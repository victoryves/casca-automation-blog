/**
 * Source Database Operations
 */

import { query } from '../client.js';
import type { Source } from '../../types/index.js';

export const sourceOps = {
  /**
   * Create a new source
   */
  create(source: Omit<Source, 'id'>): number {
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
    return result.lastInsertRowid as number;
  },

  /**
   * Find source by ID
   */
  findById(id: number): Source | undefined {
    return query.get<Source>('SELECT * FROM sources WHERE id = ?', [id]);
  },

  /**
   * Find all sources for an artist
   */
  findByArtistId(artistId: number): Source[] {
    return query.all<Source>('SELECT * FROM sources WHERE artist_id = ? ORDER BY credibility_score DESC', [
      artistId,
    ]);
  },

  /**
   * Find source by URL
   */
  findByUrl(url: string): Source | undefined {
    return query.get<Source>('SELECT * FROM sources WHERE url = ?', [url]);
  },

  /**
   * Check if source exists for artist
   */
  exists(artistId: number, url: string): boolean {
    const result = query.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM sources WHERE artist_id = ? AND url = ?',
      [artistId, url]
    );
    return (result?.count ?? 0) > 0;
  },

  /**
   * Get sources with minimum credibility
   */
  findByMinCredibility(artistId: number, minScore: number): Source[] {
    return query.all<Source>(
      'SELECT * FROM sources WHERE artist_id = ? AND credibility_score >= ? ORDER BY credibility_score DESC',
      [artistId, minScore]
    );
  },

  /**
   * Count sources for artist
   */
  countForArtist(artistId: number): number {
    const result = query.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM sources WHERE artist_id = ?',
      [artistId]
    );
    return result?.count ?? 0;
  },

  /**
   * Update source credibility score
   */
  updateCredibility(id: number, score: number): void {
    query.run('UPDATE sources SET credibility_score = ? WHERE id = ?', [score, id]);
  },

  /**
   * Delete source
   */
  delete(id: number): void {
    query.run('DELETE FROM sources WHERE id = ?', [id]);
  },

  /**
   * Delete all sources for artist
   */
  deleteByArtistId(artistId: number): void {
    query.run('DELETE FROM sources WHERE artist_id = ?', [artistId]);
  },
};
