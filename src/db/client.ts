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
