/**
 * Artist Database Operations - SQLite
 */

import { query } from '../client.js';
import type { Artist, ArtistStatus } from '../../types/index.js';

export const artistOps = {
  /**
   * Create a new artist
   */
  async create(artist: Omit<Artist, 'id'>): Promise<number> {
    const result = query.run(
      `INSERT INTO artists (full_name, birthplace_city, birthplace_state, visual_practice, status)
       VALUES (?, ?, ?, ?, ?)`,
      [
        artist.full_name,
        artist.birthplace_city ?? null,
        artist.birthplace_state ?? null,
        artist.visual_practice ?? null,
        artist.status ?? 'discovered',
      ]
    );

    return Number(result.lastInsertRowid);
  },

  /**
   * Find artist by ID
   */
  async findById(id: number): Promise<Artist | null> {
    const row = query.get<Artist>(`SELECT * FROM artists WHERE id = ?`, [id]);
    return row ?? null;
  },

  /**
   * Find artist by name and city
   */
  async findByNameAndCity(fullName: string, city?: string): Promise<Artist | null> {
    if (city) {
      const row = query.get<Artist>(
        `SELECT * FROM artists WHERE full_name = ? AND birthplace_city = ?`,
        [fullName, city]
      );
      return row ?? null;
    }

    const row = query.get<Artist>(`SELECT * FROM artists WHERE full_name = ?`, [fullName]);
    return row ?? null;
  },

  /**
   * Get all artists by status
   */
  async findByStatus(status: ArtistStatus): Promise<Artist[]> {
    return query.all<Artist>(
      `SELECT * FROM artists WHERE status = ? ORDER BY discovered_at ASC`,
      [status]
    );
  },

  /**
   * Get verified but unpublished artists
   */
  async findVerifiedUnpublished(): Promise<Artist[]> {
    return query.all<Artist>(
      `SELECT * FROM artists WHERE status = 'verified' ORDER BY discovered_at ASC`
    );
  },

  /**
   * Update artist status
   */
  async updateStatus(id: number, status: ArtistStatus): Promise<void> {
    if (status === 'published') {
      query.run(
        `UPDATE artists SET status = ?, published_at = ? WHERE id = ?`,
        [status, new Date().toISOString(), id]
      );
      return;
    }

    query.run(`UPDATE artists SET status = ? WHERE id = ?`, [status, id]);
  },

  /**
   * Update artist metadata JSON
   */
  async updateMetadata(id: number, metadata: Record<string, unknown> | null): Promise<void> {
    query.run(`UPDATE artists SET metadata = ? WHERE id = ?`, [
      metadata ? JSON.stringify(metadata) : null,
      id,
    ]);
  },

  /**
   * Delete artist
   */
  async delete(id: number): Promise<void> {
    query.run(`DELETE FROM artists WHERE id = ?`, [id]);
  },

  /**
   * Get all artists
   */
  async findAll(): Promise<Artist[]> {
    return query.all<Artist>(`SELECT * FROM artists ORDER BY discovered_at DESC`);
  },

  /**
   * Count artists by status
   */
  async countByStatus(status: ArtistStatus): Promise<number> {
    const row = query.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM artists WHERE status = ?`,
      [status]
    );
    return row?.count ?? 0;
  },
};
