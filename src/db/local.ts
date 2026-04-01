/**
 * Local Database Bootstrap
 */

import { initDatabase as initSqlite, closeDatabase as closeSqlite } from './client.js';
import { getConfig } from '../config/index.js';

export function initDatabase(): void {
  const config = getConfig();
  initSqlite({
    path: config.env.dbPath,
  });
}

export function closeDatabase(): void {
  closeSqlite();
}
