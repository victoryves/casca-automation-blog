/**
 * Database Schema Definitions
 *
 * This file defines the SQL schema for the CASCA Editorial Agent database.
 * Tables: artists, sources, drafts, publishing_log, publication_history, librarian_pending_review
 */

export const SCHEMA = {
  artists: `
    CREATE TABLE IF NOT EXISTS artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      birthplace_city TEXT,
      birthplace_state TEXT,
      visual_practice TEXT,
      status TEXT NOT NULL CHECK(status IN ('discovered', 'pending_more_sources', 'researched', 'curated', 'drafted', 'ready_to_send', 'verified', 'published', 'rejected', 'rejected_by_head_of_art', 'review_later', 'rejected_duplicate_external', 'skipped_asset_quality', 'failed_asset_quality_retry_headless', 'hard_failure_quarantine', 'skipped_pure_context_failure', 'failed_context_preflight', 'already_published', 'failed_permanent')) DEFAULT 'discovered',
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      published_at DATETIME,
      last_heartbeat DATETIME,
      priority INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
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
      last_heartbeat DATETIME,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('pending', 'researched', 'curated', 'drafted', 'ready', 'sent', 'approved', 'rejected')) DEFAULT 'pending',
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

  publication_history: `
    CREATE TABLE IF NOT EXISTS publication_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_name TEXT NOT NULL,
      normalized_artist_name TEXT NOT NULL,
      post_title TEXT,
      post_url TEXT,
      source TEXT NOT NULL DEFAULT 'automation',
      published_at DATETIME,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(normalized_artist_name, source),
      UNIQUE(post_url)
    )
  `,

  librarian_pending_review: `
    CREATE TABLE IF NOT EXISTS librarian_pending_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_title TEXT NOT NULL,
      resolved_name TEXT NOT NULL,
      normalized_resolved_name TEXT NOT NULL,
      confidence REAL NOT NULL,
      reasoning TEXT,
      url TEXT NOT NULL UNIQUE,
      description TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,

  worker_heartbeats: `
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      agent_name TEXT PRIMARY KEY,
      last_heartbeat DATETIME,
      pid INTEGER,
      detail TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  artistsQueue: `
    CREATE INDEX IF NOT EXISTS idx_artists_queue
    ON artists(status, priority DESC, discovered_at ASC)
  `,

  sourcesArtist: `
    CREATE INDEX IF NOT EXISTS idx_sources_artist
    ON sources(artist_id)
  `,

  draftsStatus: `
    CREATE INDEX IF NOT EXISTS idx_drafts_status
    ON drafts(status, priority DESC, sent_at, created_at)
  `,

  draftsArtist: `
    CREATE INDEX IF NOT EXISTS idx_drafts_artist
    ON drafts(artist_id)
  `,

  draftsHeartbeat: `
    CREATE INDEX IF NOT EXISTS idx_drafts_heartbeat
    ON drafts(status, last_heartbeat, priority DESC, created_at)
  `,

  publishingLogDraft: `
    CREATE INDEX IF NOT EXISTS idx_publishing_log_draft
    ON publishing_log(draft_id)
  `,

  publicationHistoryName: `
    CREATE INDEX IF NOT EXISTS idx_publication_history_name
    ON publication_history(normalized_artist_name, source, published_at)
  `,

  publicationHistoryPublished: `
    CREATE INDEX IF NOT EXISTS idx_publication_history_published
    ON publication_history(published_at, synced_at)
  `,

  librarianPendingName: `
    CREATE INDEX IF NOT EXISTS idx_librarian_pending_name
    ON librarian_pending_review(normalized_resolved_name, confidence, updated_at)
  `,

  librarianPendingCreated: `
    CREATE INDEX IF NOT EXISTS idx_librarian_pending_created
    ON librarian_pending_review(created_at DESC, updated_at DESC)
  `,

  workerHeartbeatStale: `
    CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_stale
    ON worker_heartbeats(last_heartbeat, updated_at)
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
