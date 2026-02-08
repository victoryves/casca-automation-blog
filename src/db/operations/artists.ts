/**
 * Artist Database Operations
 */

import { query } from '../client.js';
import type { Artist, ArtistStatus } from '../../types/index.js';

export const artistOps = {
  /**
   * Create a new artist
   */
  create(artist: Omit<Artist, 'id'>): number {
    const result = query.run(
      `INSERT INTO artists (full_name, birthplace_city, birthplace_state, visual_practice, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        artist.full_name,
        artist.birthplace_city ?? null,
        artist.birthplace_state ?? null,
        artist.visual_practice ?? null,
        artist.status ?? 'discovered',
        artist.metadata ?? null,
      ]
    );
    return result.lastInsertRowid as number;
  },

  /**
   * Find artist by ID
   */
  findById(id: number): Artist | undefined {
    return query.get<Artist>('SELECT * FROM artists WHERE id = ?', [id]);
  },

  /**
   * Find artist by name and city
   */
  findByNameAndCity(fullName: string, city?: string): Artist | undefined {
    if (city) {
      return query.get<Artist>(
        'SELECT * FROM artists WHERE full_name = ? AND birthplace_city = ?',
        [fullName, city]
      );
    }
    return query.get<Artist>('SELECT * FROM artists WHERE full_name = ?', [fullName]);
  },

  /**
   * Get all artists by status
   */
  findByStatus(status: ArtistStatus): Artist[] {
    return query.all<Artist>('SELECT * FROM artists WHERE status = ? ORDER BY discovered_at ASC', [
      status,
    ]);
  },

  /**
   * Get verified but unpublished artists
   */
  findVerifiedUnpublished(): Artist[] {
    return query.all<Artist>(
      "SELECT * FROM artists WHERE status = 'verified' ORDER BY discovered_at ASC"
    );
  },

  /**
   * Update artist status
   */
  updateStatus(id: number, status: ArtistStatus): void {
    const updates: Record<string, string | null> = { status };

    if (status === 'published') {
      updates.published_at = new Date().toISOString();
    }

    const setClauses = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(', ');
    const values = [...Object.values(updates), id];

    query.run(`UPDATE artists SET ${setClauses} WHERE id = ?`, values);
  },

  /**
   * Update artist metadata
   */
  updateMetadata(id: number, metadata: Record<string, unknown>): void {
    query.run('UPDATE artists SET metadata = ? WHERE id = ?', [JSON.stringify(metadata), id]);
  },

  /**
   * Delete artist
   */
  delete(id: number): void {
    query.run('DELETE FROM artists WHERE id = ?', [id]);
  },

  /**
   * Get all artists
   */
  findAll(): Artist[] {
    return query.all<Artist>('SELECT * FROM artists ORDER BY discovered_at DESC');
  },

  /**
   * Count artists by status
   */
  countByStatus(status: ArtistStatus): number {
    const result = query.get<{ count: number }>('SELECT COUNT(*) as count FROM artists WHERE status = ?', [status]);
    return result?.count ?? 0;
  },
};
