/**
 * Database Schema Definitions
 *
 * This file defines the SQL schema for the CASCA Editorial Agent database.
 * Tables: artists, sources, drafts, publishing_log
 */

export const SCHEMA = {
  artists: `
    CREATE TABLE IF NOT EXISTS artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      birthplace_city TEXT,
      birthplace_state TEXT,
      visual_practice TEXT,
      status TEXT NOT NULL CHECK(status IN ('discovered', 'verified', 'published')) DEFAULT 'discovered',
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      published_at DATETIME,
      metadata TEXT,
      UNIQUE(full_name, birthplace_city)
    )
  `,

  sources: `
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      institution TEXT NOT NULL,
      credibility_score REAL DEFAULT 1.0,
      content_summary TEXT,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
      UNIQUE(artist_id, url)
    )
  `,

  drafts: `
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      content TEXT NOT NULL,
      images TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'approved', 'rejected')) DEFAULT 'pending',
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    )
  `,

  publishing_log: `
    CREATE TABLE IF NOT EXISTS publishing_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL,
      medium_url TEXT,
      published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      error_message TEXT,
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
    )
  `,
};

export const INDEXES = {
  artistsStatus: `
    CREATE INDEX IF NOT EXISTS idx_artists_status
    ON artists(status, discovered_at)
  `,

  artistsPublished: `
    CREATE INDEX IF NOT EXISTS idx_artists_published
    ON artists(published_at)
  `,

  sourcesArtist: `
    CREATE INDEX IF NOT EXISTS idx_sources_artist
    ON sources(artist_id)
  `,

  draftsStatus: `
    CREATE INDEX IF NOT EXISTS idx_drafts_status
    ON drafts(status, sent_at)
  `,

  draftsArtist: `
    CREATE INDEX IF NOT EXISTS idx_drafts_artist
    ON drafts(artist_id)
  `,

  publishingLogDraft: `
    CREATE INDEX IF NOT EXISTS idx_publishing_log_draft
    ON publishing_log(draft_id)
  `,
};

export const INITIAL_DATA = {
  // Pragmas for performance and reliability
  pragmas: [
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = NORMAL',
    'PRAGMA foreign_keys = ON',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA mmap_size = 30000000000',
  ],
};
