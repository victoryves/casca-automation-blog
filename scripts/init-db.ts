#!/usr/bin/env tsx

/**
 * Initialize Database
 *
 * Creates the database and tables if they don't exist.
 */

import { initDatabase, closeDatabase } from '../src/db/client.js';
import { loadConfig } from '../src/config/index.js';

function initDb(): void {
  console.log('🗄️  Initializing Database\n');

  try {
    const config = loadConfig();

    console.log(`Database path: ${config.env.databasePath}`);

    const db = initDatabase({
      path: config.env.databasePath,
      verbose: true,
    });

    console.log('\n✅ Database initialized successfully!');

    // Show tables
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    console.log(`\n📋 Tables created: ${tables.length}`);
    tables.forEach((table) => {
      console.log(`  - ${table.name}`);
    });

    closeDatabase();
  } catch (error) {
    console.error('\n❌ Database initialization failed:');
    console.error(error);
    process.exit(1);
  }
}

initDb();
