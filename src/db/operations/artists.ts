/**
 * Artist Database Operations - SQLite
 */

import { query } from '../client.js';
import type { Artist, ArtistStatus } from '../../types/index.js';

function normalizeArtistName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

export const artistOps = {
  parseMetadata(artist: Pick<Artist, 'metadata'> | null | undefined): Record<string, unknown> {
    if (!artist?.metadata) {
      return {};
    }

    try {
      const parsed = JSON.parse(artist.metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  },

  async findByNormalizedName(fullName: string): Promise<Artist | null> {
    const normalizedTarget = normalizeArtistName(fullName);
    if (!normalizedTarget) {
      return null;
    }

    const artists = query.all<Artist>(`SELECT * FROM artists ORDER BY discovered_at ASC, id ASC`);
    for (const artist of artists) {
      if (normalizeArtistName(artist.full_name) === normalizedTarget) {
        return artist;
      }
    }

    return null;
  },

  /**
   * Create a new artist
   */
  async create(artist: Omit<Artist, 'id'>): Promise<number> {
    const existingArtist = await this.findByNormalizedName(artist.full_name);
    if (existingArtist?.id) {
      query.run(
        `UPDATE artists
         SET
           birthplace_city = COALESCE(birthplace_city, ?),
           birthplace_state = COALESCE(birthplace_state, ?),
           visual_practice = COALESCE(visual_practice, ?),
           metadata = COALESCE(metadata, ?)
         WHERE id = ?`,
        [
          artist.birthplace_city ?? null,
          artist.birthplace_state ?? null,
          artist.visual_practice ?? null,
          artist.metadata ?? null,
          existingArtist.id,
        ]
      );
      return existingArtist.id;
    }

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
    if (row) {
      return row;
    }

    return this.findByNormalizedName(fullName);
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

  async mergeMetadata(id: number, patch: Record<string, unknown>): Promise<void> {
    const artist = await this.findById(id);
    const current = this.parseMetadata(artist);
    await this.updateMetadata(id, {
      ...current,
      ...patch,
    });
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
