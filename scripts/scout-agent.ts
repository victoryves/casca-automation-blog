#!/usr/bin/env tsx

import { loadConfig } from '../src/config/index.js';
import { initDatabase, closeDatabase } from '../src/db/local.js';
import { ScoutAgent } from '../src/modules/agents/scout.js';

async function main(): Promise<void> {
  loadConfig();
  initDatabase();
  const agent = new ScoutAgent();
  const once = process.argv.includes('--once');

  try {
    if (once) {
      await agent.runSinglePass();
      return;
    }
    await agent.start();
  } finally {
    closeDatabase();
  }
}

void main();
