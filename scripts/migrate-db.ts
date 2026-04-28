#!/usr/bin/env tsx

import { closeDatabase, initDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';

async function main(): Promise<void> {
  initDatabase();

  const tableSql = query.get<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'artists'`
  );

  const statuses = query
    .all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count
       FROM artists
       GROUP BY status
       ORDER BY count DESC, status ASC`
    );

  console.log(
    JSON.stringify(
      {
        migrated: true,
        artists_table_sql: tableSql?.sql ?? null,
        statuses,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
