/**
 * Database Client
 *
 * Manages SQLite database connection and provides access to database operations.
 */

import Database from 'better-sqlite3';
import { SCHEMA, INDEXES, INITIAL_DATA } from './schema.js';
import path from 'path';
import fs from 'fs';

let db: Database.Database | null = null;

function getTableColumns(database: Database.Database, table: string): string[] {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return columns.map((column) => column.name);
}

function rebuildArtistsTable(database: Database.Database): void {
  database.exec(`ALTER TABLE artists RENAME TO artists_legacy_migration;`);
  const legacyColumns = getTableColumns(database, 'artists_legacy_migration');
  const failureCountExpression = legacyColumns.includes('failure_count')
    ? 'COALESCE(failure_count, 0)'
    : '0';

  database.exec(`
    ${SCHEMA.artists};
    INSERT INTO artists (
      id,
      full_name,
      birthplace_city,
      birthplace_state,
      visual_practice,
      status,
      discovered_at,
      published_at,
      last_heartbeat,
      priority,
      failure_count,
      metadata
    )
    SELECT
      id,
      full_name,
      birthplace_city,
      birthplace_state,
      visual_practice,
      CASE lower(COALESCE(status, 'discovered'))
        WHEN 'published' THEN 'published'
        WHEN 'rejected' THEN 'rejected'
        WHEN 'rejected_by_head_of_art' THEN 'rejected_by_head_of_art'
        WHEN 'review_later' THEN 'review_later'
        WHEN 'rejected_duplicate_external' THEN 'rejected_duplicate_external'
        WHEN 'skipped_asset_quality' THEN 'skipped_asset_quality'
        WHEN 'failed_asset_quality_retry_headless' THEN 'failed_asset_quality_retry_headless'
        WHEN 'hard_failure_quarantine' THEN 'hard_failure_quarantine'
        WHEN 'skipped_pure_context_failure' THEN 'skipped_pure_context_failure'
        WHEN 'failed_context_preflight' THEN 'failed_context_preflight'
        WHEN 'already_published' THEN 'already_published'
        WHEN 'verified' THEN 'verified'
        WHEN 'pending_more_sources' THEN 'pending_more_sources'
        WHEN 'researched' THEN 'researched'
        WHEN 'curated' THEN 'curated'
        WHEN 'drafted' THEN 'drafted'
        WHEN 'ready_to_send' THEN 'ready_to_send'
        WHEN 'failed_permanent' THEN 'failed_permanent'
        ELSE 'discovered'
      END,
      discovered_at,
      published_at,
      NULL,
      0,
      ${failureCountExpression},
      metadata
    FROM artists_legacy_migration;
    DROP TABLE artists_legacy_migration;
  `);
}

function rebuildDraftsTable(database: Database.Database): void {
  database.exec(`
    ALTER TABLE drafts RENAME TO drafts_legacy_migration;
    ${SCHEMA.drafts};
  `);

  const legacyRows = database
    .prepare(
      `SELECT id, artist_id, title, subtitle, content, images, created_at, sent_at, status
       FROM drafts_legacy_migration
       ORDER BY id ASC`
    )
    .all() as Array<{
    id: number;
    artist_id: number;
    title: string;
    subtitle: string | null;
    content: string;
    images: string | null;
    created_at: string | null;
    sent_at: string | null;
    status: string | null;
  }>;

  const insert = database.prepare(
    `INSERT INTO drafts (
      id,
      artist_id,
      title,
      subtitle,
      content,
      images,
      created_at,
      sent_at,
      last_heartbeat,
      priority,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const row of legacyRows) {
    let migratedStatus = 'drafted';
    const legacyStatus = (row.status ?? '').toLowerCase();

    if (legacyStatus === 'sent' || legacyStatus === 'approved' || legacyStatus === 'rejected') {
      migratedStatus = legacyStatus;
    } else if (legacyStatus === 'ready' || legacyStatus === 'curated' || legacyStatus === 'drafted') {
      migratedStatus = legacyStatus;
    } else {
      let imageCount = 0;
      try {
        const parsed = row.images ? JSON.parse(row.images) : [];
        imageCount = Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        imageCount = 0;
      }

      if (imageCount >= 3) {
        migratedStatus = 'ready';
      } else if (imageCount > 0) {
        migratedStatus = 'curated';
      }
    }

    insert.run(
      row.id,
      row.artist_id,
      row.title,
      row.subtitle,
      row.content,
      row.images,
      row.created_at,
      row.sent_at,
      null,
      0,
      migratedStatus
    );
  }

  database.exec(`DROP TABLE drafts_legacy_migration;`);
}

function rebuildSourcesTable(database: Database.Database): void {
  database.exec(`
    ALTER TABLE sources RENAME TO sources_legacy_migration;
    ${SCHEMA.sources};
    INSERT INTO sources (
      id,
      artist_id,
      url,
      institution,
      credibility_score,
      content_summary,
      scraped_at
    )
    SELECT
      id,
      artist_id,
      url,
      institution,
      credibility_score,
      content_summary,
      scraped_at
    FROM sources_legacy_migration;
    DROP TABLE sources_legacy_migration;
  `);
}

function rebuildPublishingLogTable(database: Database.Database): void {
  database.exec(`
    ALTER TABLE publishing_log RENAME TO publishing_log_legacy_migration;
    ${SCHEMA.publishing_log};
    INSERT INTO publishing_log (
      id,
      draft_id,
      medium_url,
      published_at,
      error_message
    )
    SELECT
      id,
      draft_id,
      medium_url,
      published_at,
      error_message
    FROM publishing_log_legacy_migration;
    DROP TABLE publishing_log_legacy_migration;
  `);
}

function hasLegacyForeignKeyReference(database: Database.Database, table: string): boolean {
  const row = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql?: string } | undefined;
  const sql = row?.sql ?? '';
  return sql.includes('artists_legacy_migration') || sql.includes('drafts_legacy_migration');
}

function tableSqlContains(database: Database.Database, table: string, fragment: string): boolean {
  const row = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql?: string } | undefined;
  return (row?.sql ?? '').includes(fragment);
}

function runMigrations(database: Database.Database): void {
  const artistsColumns = getTableColumns(database, 'artists');
  if (
    !artistsColumns.includes('last_heartbeat') ||
    !artistsColumns.includes('priority') ||
    !artistsColumns.includes('failure_count') ||
    !tableSqlContains(database, 'artists', 'pending_more_sources') ||
    !tableSqlContains(database, 'artists', 'rejected_by_head_of_art') ||
    !tableSqlContains(database, 'artists', 'review_later') ||
    !tableSqlContains(database, 'artists', 'rejected_duplicate_external') ||
    !tableSqlContains(database, 'artists', 'skipped_asset_quality') ||
    !tableSqlContains(database, 'artists', 'failed_asset_quality_retry_headless') ||
    !tableSqlContains(database, 'artists', 'hard_failure_quarantine') ||
    !tableSqlContains(database, 'artists', 'skipped_pure_context_failure') ||
    !tableSqlContains(database, 'artists', 'failed_context_preflight') ||
    !tableSqlContains(database, 'artists', 'already_published')
  ) {
    database.exec('PRAGMA foreign_keys = OFF');
    rebuildArtistsTable(database);
    database.exec('PRAGMA foreign_keys = ON');
  }

  const draftsColumns = getTableColumns(database, 'drafts');
  if (
    !draftsColumns.includes('last_heartbeat') ||
    !draftsColumns.includes('priority') ||
    hasLegacyForeignKeyReference(database, 'drafts')
  ) {
    database.exec('PRAGMA foreign_keys = OFF');
    rebuildDraftsTable(database);
    database.exec('PRAGMA foreign_keys = ON');
  }

  if (hasLegacyForeignKeyReference(database, 'sources')) {
    database.exec('PRAGMA foreign_keys = OFF');
    rebuildSourcesTable(database);
    database.exec('PRAGMA foreign_keys = ON');
  }

  if (hasLegacyForeignKeyReference(database, 'publishing_log')) {
    database.exec('PRAGMA foreign_keys = OFF');
    rebuildPublishingLogTable(database);
    database.exec('PRAGMA foreign_keys = ON');
  }
}

export interface DatabaseConfig {
  path: string;
  verbose?: boolean;
}

/**
 * Initialize database connection and create tables if needed
 */
export function initDatabase(config: DatabaseConfig): Database.Database {
  // Ensure data directory exists
  const dataDir = path.dirname(config.path);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Create connection
  db = new Database(config.path, {
    verbose: config.verbose ? console.log : undefined,
  });

  // Set pragmas
  INITIAL_DATA.pragmas.forEach((pragma) => {
    db!.exec(pragma);
  });

  // Create tables
  Object.values(SCHEMA).forEach((tableSql) => {
    db!.exec(tableSql);
  });

  runMigrations(db!);

  // Create indexes
  Object.values(INDEXES).forEach((indexSql) => {
    db!.exec(indexSql);
  });

  console.log('✓ Database initialized:', config.path);

  return db;
}

/**
 * Get existing database connection
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('✓ Database connection closed');
  }
}

/**
 * Execute within a transaction
 */
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  const txn = database.transaction(fn);
  return txn();
}

/**
 * Type-safe query helpers
 */
export const query = {
  /**
   * Execute a SELECT query and return all rows
   */
  all<T = unknown>(sql: string, params?: unknown[]): T[] {
    const stmt = getDatabase().prepare(sql);
    return stmt.all(params ?? []) as T[];
  },

  /**
   * Execute a SELECT query and return first row
   */
  get<T = unknown>(sql: string, params?: unknown[]): T | undefined {
    const stmt = getDatabase().prepare(sql);
    return stmt.get(params ?? []) as T | undefined;
  },

  /**
   * Execute an INSERT/UPDATE/DELETE query
   */
  run(sql: string, params?: unknown[]): Database.RunResult {
    const stmt = getDatabase().prepare(sql);
    return stmt.run(params ?? []);
  },
};
