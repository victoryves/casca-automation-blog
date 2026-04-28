import { query } from '../client.js';
import type { LibrarianPendingReviewEntry, PublicationHistoryEntry } from '../../types/index.js';

function normalizeArtistName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const publicationHistoryOps = {
  normalizeArtistName,

  async create(entry: Omit<PublicationHistoryEntry, 'id'>): Promise<number> {
    const result = query.run(
      `INSERT OR IGNORE INTO publication_history (
        artist_name,
        normalized_artist_name,
        post_title,
        post_url,
        source,
        published_at,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.artist_name,
        entry.normalized_artist_name,
        entry.post_title ?? null,
        entry.post_url ?? null,
        entry.source,
        entry.published_at ?? null,
        entry.synced_at ?? new Date().toISOString(),
      ]
    );

    return Number(result.lastInsertRowid ?? 0);
  },

  async upsert(entry: Omit<PublicationHistoryEntry, 'id'>): Promise<void> {
    const existingByName = query.get<{ id: number; post_url: string | null }>(
      `SELECT id, post_url
       FROM publication_history
       WHERE normalized_artist_name = ? AND source = ?
       LIMIT 1`,
      [entry.normalized_artist_name, entry.source]
    );

    if (entry.post_url) {
      const existingByUrl = query.get<{ id: number }>(
        `SELECT id FROM publication_history WHERE post_url = ? LIMIT 1`,
        [entry.post_url]
      );
      if (existingByUrl?.id) {
        if (existingByName?.id && existingByName.id !== existingByUrl.id) {
          query.run(`DELETE FROM publication_history WHERE id = ?`, [existingByUrl.id]);
          query.run(
            `UPDATE publication_history
             SET
               artist_name = ?,
               post_title = COALESCE(post_title, ?),
               published_at = COALESCE(published_at, ?),
               synced_at = ?,
               post_url = COALESCE(post_url, ?)
             WHERE id = ?`,
            [
              entry.artist_name,
              entry.post_title ?? null,
              entry.published_at ?? null,
              entry.synced_at ?? new Date().toISOString(),
              entry.post_url ?? null,
              existingByName.id,
            ]
          );
          return;
        }

        query.run(
          `UPDATE publication_history
           SET
             artist_name = ?,
             normalized_artist_name = ?,
             post_title = ?,
             source = ?,
             published_at = ?,
             synced_at = ?
           WHERE id = ?`,
          [
            entry.artist_name,
            entry.normalized_artist_name,
            entry.post_title ?? null,
            entry.source,
            entry.published_at ?? null,
            entry.synced_at ?? new Date().toISOString(),
            existingByUrl.id,
          ]
        );
        return;
      }
    }

    if (existingByName?.id) {
      query.run(
        `UPDATE publication_history
         SET
           artist_name = ?,
           post_title = COALESCE(post_title, ?),
           published_at = COALESCE(published_at, ?),
           synced_at = ?,
           post_url = COALESCE(post_url, ?)
         WHERE id = ?`,
        [
          entry.artist_name,
          entry.post_title ?? null,
          entry.published_at ?? null,
          entry.synced_at ?? new Date().toISOString(),
          entry.post_url ?? null,
          existingByName.id,
        ]
      );
      return;
    }

    query.run(
      `INSERT OR IGNORE INTO publication_history (
        artist_name,
        normalized_artist_name,
        post_title,
        post_url,
        source,
        published_at,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.artist_name,
        entry.normalized_artist_name,
        entry.post_title ?? null,
        entry.post_url ?? null,
        entry.source,
        entry.published_at ?? null,
        entry.synced_at ?? new Date().toISOString(),
      ]
    );
  },

  async findAll(): Promise<PublicationHistoryEntry[]> {
    return query.all<PublicationHistoryEntry>(
      `SELECT * FROM publication_history ORDER BY published_at DESC, synced_at DESC`
    );
  },

  async findByNormalizedName(normalizedArtistName: string): Promise<PublicationHistoryEntry | null> {
    const row = query.get<PublicationHistoryEntry>(
      `SELECT *
       FROM publication_history
       WHERE normalized_artist_name = ?
       ORDER BY published_at DESC, synced_at DESC
       LIMIT 1`,
      [normalizedArtistName]
    );
    return row ?? null;
  },

  async findByPostUrl(postUrl: string): Promise<PublicationHistoryEntry | null> {
    const row = query.get<PublicationHistoryEntry>(
      `SELECT *
       FROM publication_history
       WHERE post_url = ?
       LIMIT 1`,
      [postUrl]
    );
    return row ?? null;
  },

  async deleteByPostUrl(postUrl: string): Promise<void> {
    query.run(`DELETE FROM publication_history WHERE post_url = ?`, [postUrl]);
  },

  async isPublished(artistName: string): Promise<boolean> {
    const normalized = normalizeArtistName(artistName);
    if (!normalized) return false;
    const row = query.get<{ count: number }>(
      `SELECT
         (SELECT COUNT(*) FROM publication_history WHERE normalized_artist_name = ?)
         +
         (SELECT COUNT(*) FROM librarian_pending_review WHERE normalized_resolved_name = ?) AS count`,
      [normalized, normalized]
    );
    return (row?.count ?? 0) > 0;
  },

  async getNormalizedNames(): Promise<Set<string>> {
    const rows = query.all<{ normalized_artist_name: string }>(
      `SELECT normalized_artist_name FROM publication_history`
    );
    const pendingRows = query.all<{ normalized_resolved_name: string }>(
      `SELECT normalized_resolved_name FROM librarian_pending_review`
    );
    return new Set(
      [
        ...rows.map((row) => row.normalized_artist_name),
        ...pendingRows.map((row) => row.normalized_resolved_name),
      ].filter((value) => Boolean(value?.trim()))
    );
  },

  async approvePendingReview(
    entry: LibrarianPendingReviewEntry,
    source: PublicationHistoryEntry['source'] = 'rss_feed'
  ): Promise<void> {
    await this.upsert({
      artist_name: entry.resolved_name,
      normalized_artist_name: entry.normalized_resolved_name,
      post_title: entry.original_title,
      post_url: entry.url,
      source,
      published_at: null,
      synced_at: new Date().toISOString(),
    });
    query.run(`DELETE FROM librarian_pending_review WHERE id = ?`, [entry.id]);
  },

  async findFuzzyMatch(artistName: string): Promise<PublicationHistoryEntry | null> {
    const normalized = normalizeArtistName(artistName);
    if (!normalized) {
      return null;
    }

    const rows = query.all<PublicationHistoryEntry>(
      `SELECT * FROM publication_history ORDER BY published_at DESC, synced_at DESC`
    );

    const direct = rows.find((row) => row.normalized_artist_name === normalized);
    if (direct) {
      return direct;
    }

    const tokens = normalized.split(' ').filter(Boolean);
    const surname = tokens[tokens.length - 1] ?? '';
    if (!surname || surname.length < 3) {
      return null;
    }

    const tokenSet = new Set(tokens);
    for (const row of rows) {
      const candidateTokens = row.normalized_artist_name.split(' ').filter(Boolean);
      const overlap = candidateTokens.filter((token) => tokenSet.has(token)).length;
      const sharesSurname = candidateTokens.includes(surname);
      if (sharesSurname && overlap >= Math.min(2, tokens.length)) {
        return row;
      }
    }

    return null;
  },
};
